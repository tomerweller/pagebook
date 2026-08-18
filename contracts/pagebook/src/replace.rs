use crate::errors::Error;
use crate::iface::SlotWindow;
use crate::rest;
use crate::settle::{self, Netting};
use crate::store;
use pagebook_types::Market;
use soroban_sdk::{Address, Env};

/// Entry point: authenticates, checks pause, one item, one flush.
pub fn replace(
    env: &Env,
    owner: Address,
    market: u32,
    nonce: u64,
    is_bid: bool,
    tick: u32,
    qty_lots: u64,
    window: SlotWindow,
) -> (i128, i128) {
    owner.require_auth();
    store::require_not_paused(env);
    let m = store::load_market(env, market);
    let mut net = Netting::new(env);
    let out = replace_body(
        env, &owner, market, &m, nonce, is_bid, tick, qty_lots, &window, &mut net,
    );
    net.flush(env, &owner);
    out
}

/// One replace item (architecture §10): settle the old order per §7, rewrite the
/// same `Order` in place, append at the new tick; escrow moves as a netted delta.
/// No auth, no pause check, no transfers: the caller owns those.
#[allow(clippy::too_many_arguments)]
pub fn replace_body(
    env: &Env,
    owner: &Address,
    market: u32,
    m: &Market,
    nonce: u64,
    is_bid: bool,
    tick: u32,
    qty_lots: u64,
    window: &SlotWindow,
    net: &mut Netting,
) -> (i128, i128) {
    let opp = store::load_best(env, market, !is_bid);
    if !opp.empty && rest::crosses(is_bid, opp.tick, tick) {
        env.panic_with_error(Error::Crossed);
    }
    let r = settle::settle_order(env, owner, market, m, nonce, false);
    rest::rest(
        env, owner, market, m, is_bid, tick, qty_lots, nonce, window, true,
    );
    // ADR-021: the pay-in is the full new escrow (a function of the arguments);
    // the old order's proceeds and refund flow out separately, whatever filled
    // in flight.
    if r.is_bid {
        net.pay_out(env, &m.base, r.paid);
        net.pay_out(env, &m.quote, r.refunded);
    } else {
        net.pay_out(env, &m.quote, r.paid);
        net.pay_out(env, &m.base, r.refunded);
    }
    let (new_tok, new_amt) = settle::escrow_for(env, m, is_bid, tick, qty_lots);
    net.pay_in(env, &new_tok, new_amt);
    (r.paid, r.refunded)
}

pub fn do_settle(env: &Env, owner: Address, market: u32, nonce: u64) -> (i128, i128) {
    owner.require_auth();
    let m = store::load_market(env, market);
    let r = settle::settle_order(env, &owner, market, &m, nonce, true);
    settle::pay_settle(env, &m, &owner, &r);
    (r.paid, r.refunded)
}
