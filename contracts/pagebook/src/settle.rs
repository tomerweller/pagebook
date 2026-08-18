use crate::errors::Error;
use crate::events;
use crate::level;
use crate::math::{base_atoms, chk_add, chk_sub, quote_atoms};
use crate::store;
use pagebook_types::{Market, Order};
use soroban_sdk::{token::TokenClient, Address, Env};

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
    nonce: u64,
    delete_order: bool,
) -> SettleResult {
    let order = store::load_order(env, market, owner, nonce)
        .unwrap_or_else(|| env.panic_with_error(Error::UnknownOrder));
    let m = store::load_market(env, market);
    let mut lvl = store::load_level(env, market, order.is_bid, order.tick);
    let (filled_lots, refunded_lots) =
        level::preview_settle(order.generation, order.seq, order.qty_lots, &lvl);

    if order.generation == lvl.generation && order.seq == lvl.head_seq && refunded_lots > 0 {
        level::consume_open(env, &mut lvl, refunded_lots);
        lvl.head_seq += 1;
        lvl.head_consumed_lots = 0;
        level::advance_head(
            env,
            market,
            order.is_bid,
            order.tick,
            &mut lvl,
            m.inline_slots,
            Some(pagebook_types::page(order.seq)),
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

    let (paid, refunded) = payouts(env, &m, &order, filled_lots, refunded_lots);
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

pub fn net_add(env: &Env, acc: &mut i128, delta: i128) {
    *acc = chk_add(env, *acc, delta);
}

pub fn net_sub(env: &Env, acc: &mut i128, delta: i128) {
    *acc = chk_sub(env, *acc, delta);
}

pub fn apply_net(env: &Env, token: &Address, user: &Address, net: i128) {
    let vault = env.current_contract_address();
    if net > 0 {
        transfer(env, token, user, &vault, net);
    } else if net < 0 {
        transfer(env, token, &vault, user, -net);
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
    let accrued = store::load_fees(env, market, &token);
    if accrued == 0 {
        return 0;
    }
    store::save_fees(env, market, &token, 0);
    let vault = env.current_contract_address();
    transfer(env, &token, &vault, &config.fee_recipient, accrued);
    accrued
}
