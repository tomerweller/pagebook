use crate::errors::Error;
use crate::iface::SlotWindow;
use crate::rest;
use crate::settle;
use crate::store;
use soroban_sdk::{Address, Env};

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
    crate::market::require_qty(env, &m, qty_lots);
    crate::market::require_tick(env, &m, tick);
    let opp = store::load_best(env, market, !is_bid);
    if !opp.empty && rest::crosses(is_bid, opp.tick, tick) {
        env.panic_with_error(Error::Crossed);
    }
    let old = store::load_order(env, market, &owner, nonce)
        .unwrap_or_else(|| env.panic_with_error(Error::UnknownOrder));
    let r = settle::settle_order(env, &owner, market, nonce, false);
    rest::rest(
        env, &owner, market, &m, is_bid, tick, qty_lots, nonce, &window, true,
    );
    let (new_tok, new_amt) = settle::escrow_for(env, &m, is_bid, tick, qty_lots);
    let mut base_net: i128 = 0;
    let mut quote_net: i128 = 0;
    if r.is_bid {
        settle::net_sub(env, &mut base_net, r.paid);
        settle::net_sub(env, &mut quote_net, r.refunded);
    } else {
        settle::net_sub(env, &mut quote_net, r.paid);
        settle::net_sub(env, &mut base_net, r.refunded);
    }
    if new_tok == m.base {
        settle::net_add(env, &mut base_net, new_amt);
    } else {
        settle::net_add(env, &mut quote_net, new_amt);
    }
    let _ = old;
    settle::apply_net(env, &m.base, &owner, base_net);
    settle::apply_net(env, &m.quote, &owner, quote_net);
    (r.paid, r.refunded)
}

pub fn do_settle(env: &Env, owner: Address, market: u32, nonce: u64) -> (i128, i128) {
    owner.require_auth();
    let m = store::load_market(env, market);
    let r = settle::settle_order(env, &owner, market, nonce, true);
    settle::pay_settle(env, &m, &owner, &r);
    (r.paid, r.refunded)
}
