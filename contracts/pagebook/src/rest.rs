use crate::errors::Error;
use crate::events;
use crate::iface::SlotWindow;
use crate::level;
use crate::store;
use pagebook_types::{BestTick, Market, Order};
use soroban_sdk::{Address, Env};

pub fn rest(
    env: &Env,
    owner: &Address,
    market: u32,
    m: &Market,
    is_bid: bool,
    tick: u32,
    qty: u64,
    nonce: u64,
    window: &SlotWindow,
    reuse_order: bool,
) {
    crate::market::require_qty(env, m, qty);
    crate::market::require_tick(env, m, tick);
    if !reuse_order && store::load_order(env, market, owner, nonce).is_some() {
        env.panic_with_error(Error::OrderExists);
    }
    let mut lvl = store::load_level(env, market, is_bid, tick);
    let was_empty = lvl.open_lots == 0;
    let seq = level::append(
        env,
        market,
        is_bid,
        tick,
        m,
        &mut lvl,
        qty,
        window.append.last,
    );
    store::save_level(env, market, is_bid, tick, &lvl);
    if was_empty {
        crate::bitmap::set_tick(env, market, is_bid, tick);
    }
    update_best_on_rest(env, market, is_bid, tick);
    store::save_order(
        env,
        market,
        owner,
        nonce,
        &Order {
            is_bid,
            tick,
            generation: lvl.generation,
            seq,
            qty_lots: qty,
        },
    );
    events::rested(env, market, owner, nonce, is_bid, tick, lvl.generation, seq);
}

fn update_best_on_rest(env: &Env, market: u32, is_bid: bool, tick: u32) {
    let cur = store::load_best(env, market, is_bid);
    let take = cur.empty || better(is_bid, tick, cur.tick);
    if !take {
        return;
    }
    let old = if cur.empty { 0 } else { cur.tick };
    store::save_best(env, market, is_bid, &BestTick { empty: false, tick });
    events::top_changed(env, market, is_bid, old, tick);
}

pub fn better(is_bid: bool, cand: u32, rec: u32) -> bool {
    if is_bid {
        cand > rec
    } else {
        cand < rec
    }
}

pub fn crosses(taker_is_bid: bool, opp_tick: u32, limit_tick: u32) -> bool {
    if taker_is_bid {
        opp_tick <= limit_tick
    } else {
        opp_tick >= limit_tick
    }
}
