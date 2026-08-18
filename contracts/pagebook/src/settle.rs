use crate::errors::Error;
use crate::events;
use crate::level;
use crate::math::{base_atoms, chk_add, quote_atoms};
use crate::store;
use pagebook_types::{Market, Order};
use soroban_sdk::{token::TokenClient, Address, Env, Map};

pub struct SettleResult {
    pub paid: i128,
    pub refunded: i128,
    #[allow(dead_code)]
    pub filled_lots: u64,
    #[allow(dead_code)]
    pub refunded_lots: u64,
    pub is_bid: bool,
}

pub fn settle_order(
    env: &Env,
    owner: &Address,
    market: u32,
    m: &Market,
    nonce: u64,
    delete_order: bool,
) -> SettleResult {
    let order = store::load_order(env, market, owner, nonce)
        .unwrap_or_else(|| env.panic_with_error(Error::UnknownOrder));
    let mut lvl = store::load_level(env, market, order.is_bid, order.tick);
    let (filled_lots, refunded_lots) =
        level::preview_settle(order.generation, order.seq, order.qty_lots, &lvl);

    if order.generation == lvl.generation && order.seq == lvl.head_seq && refunded_lots > 0 {
        level::consume_open(env, &mut lvl, refunded_lots);
        lvl.head_seq += 1;
        lvl.head_consumed_lots = 0;
        // Settle declares at most one LevelPage: the page holding the settled
        // seq (page 0 for an inline seq, so an inline head may advance into
        // page 0). The scan is bounded by the market's slot cap.
        level::advance_head(
            env,
            market,
            order.is_bid,
            order.tick,
            &mut lvl,
            m.max_slots_scanned,
            Some((0, pagebook_types::page(order.seq))),
        );
        store::save_level(env, market, order.is_bid, order.tick, &lvl);
    } else if order.generation == lvl.generation && order.seq > lvl.head_seq && refunded_lots > 0 {
        level::consume_open(env, &mut lvl, refunded_lots);
        level::write_slot(
            env,
            market,
            order.is_bid,
            order.tick,
            &mut lvl,
            order.seq,
            0,
        );
        store::save_level(env, market, order.is_bid, order.tick, &lvl);
    }

    let (paid, refunded) = payouts(env, m, &order, filled_lots, refunded_lots);
    if delete_order {
        store::del_order(env, market, owner, nonce);
    }
    events::settled(env, market, owner, nonce, filled_lots, refunded_lots);
    SettleResult {
        paid,
        refunded,
        filled_lots,
        refunded_lots,
        is_bid: order.is_bid,
    }
}

pub fn payouts(
    env: &Env,
    m: &Market,
    order: &Order,
    filled_lots: u64,
    refunded_lots: u64,
) -> (i128, i128) {
    if order.is_bid {
        (
            base_atoms(env, filled_lots, m.lot_size),
            quote_atoms(env, refunded_lots, order.tick, m.tick_size),
        )
    } else {
        (
            quote_atoms(env, filled_lots, order.tick, m.tick_size),
            base_atoms(env, refunded_lots, m.lot_size),
        )
    }
}

pub fn transfer(env: &Env, token: &Address, from: &Address, to: &Address, amount: i128) {
    if amount == 0 {
        return;
    }
    TokenClient::new(env, token).transfer(from, to, &amount);
}

pub fn pay_settle(env: &Env, m: &Market, owner: &Address, r: &SettleResult) {
    let vault = env.current_contract_address();
    if r.is_bid {
        transfer(env, &m.base, &vault, owner, r.paid);
        transfer(env, &m.quote, &vault, owner, r.refunded);
    } else {
        transfer(env, &m.quote, &vault, owner, r.paid);
        transfer(env, &m.base, &vault, owner, r.refunded);
    }
}

pub fn escrow_for(env: &Env, m: &Market, is_bid: bool, tick: u32, qty: u64) -> (Address, i128) {
    if is_bid {
        (m.quote.clone(), quote_atoms(env, qty, tick, m.tick_size))
    } else {
        (m.base.clone(), base_atoms(env, qty, m.lot_size))
    }
}

pub fn accrue_fee(env: &Env, market: u32, token: &Address, fee: i128) {
    if fee == 0 {
        return;
    }
    let next = chk_add(env, store::load_fees(env, market, token), fee);
    store::save_fees(env, market, token, next);
}

pub fn collect_fees(env: &Env, market: u32, token: Address) -> i128 {
    let config = store::load_config(env);
    let m = store::load_market(env, market);
    if token != m.base && token != m.quote {
        env.panic_with_error(Error::UnknownMarket);
    }
    let accrued = store::load_fees(env, market, &token);
    if accrued == 0 {
        return 0;
    }
    store::save_fees(env, market, &token, 0);
    let vault = env.current_contract_address();
    transfer(env, &token, &vault, &config.fee_recipient, accrued);
    accrued
}

/// Per-transaction token movement (architecture §8/§10, ADR-021). Three ledgers
/// per token, flushed once by the entry point in a fixed order:
///
/// 1. `backed_out` — vault pays the user amounts the vault already holds for
///    certain: fills (makers' escrow) and a settled order's proceeds and refund;
/// 2. `pay_in` — user pays the vault, an amount that MUST be a pure function of
///    the call's arguments: the SAC `transfer(user, vault, amt)` carries
///    `user.require_auth()` on exact arguments and the user's signed auth tree is
///    built at simulation, so a book-dependent pay-in would fail auth on any race;
/// 3. `unspent_out` — the part of this call's own pay-in that neither filled nor
///    rested, returned after the pay-in landed.
///
/// The order is deterministic (no balance read), lets a chained route pay a
/// later leg with what an earlier leg bought, and never asks the vault to front
/// a user's own refund. Ledgers are never netted against each other.
pub struct Netting {
    backed_out: Map<Address, i128>,
    pay_in: Map<Address, i128>,
    unspent_out: Map<Address, i128>,
}

fn bump(env: &Env, m: &mut Map<Address, i128>, token: &Address, amount: i128) {
    let cur = m.get(token.clone()).unwrap_or(0);
    m.set(token.clone(), chk_add(env, cur, amount));
}

impl Netting {
    pub fn new(env: &Env) -> Self {
        Self {
            backed_out: Map::new(env),
            pay_in: Map::new(env),
            unspent_out: Map::new(env),
        }
    }

    /// User pays the vault `amount` of `token` (escrow at the limit price, full
    /// order escrow) — derived only from call arguments.
    pub fn pay_in(&mut self, env: &Env, token: &Address, amount: i128) {
        bump(env, &mut self.pay_in, token, amount);
    }

    /// Vault pays the user from funds it already holds: fills, proceeds, refunds.
    pub fn pay_out(&mut self, env: &Env, token: &Address, amount: i128) {
        bump(env, &mut self.backed_out, token, amount);
    }

    /// Vault returns the unspent part of this call's own pay-in.
    pub fn refund_unspent(&mut self, env: &Env, token: &Address, amount: i128) {
        bump(env, &mut self.unspent_out, token, amount);
    }

    pub fn flush(&self, env: &Env, user: &Address) {
        let vault = env.current_contract_address();
        for (token, amt) in self.backed_out.iter() {
            transfer(env, &token, &vault, user, amt);
        }
        for (token, amt) in self.pay_in.iter() {
            transfer(env, &token, user, &vault, amt);
        }
        for (token, amt) in self.unspent_out.iter() {
            transfer(env, &token, &vault, user, amt);
        }
    }
}
