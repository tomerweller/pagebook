use crate::errors::Error;
use crate::events;
use crate::iface::{PlaceFlags, SlotWindow};
use crate::level;
use crate::math::{quote_atoms, taker_fee};
use crate::rest;
use crate::settle;
use crate::store;
use pagebook_types::{BestTick, Market};
use soroban_sdk::{Address, Env};

pub fn place(
    env: &Env,
    taker: Address,
    market: u32,
    is_bid: bool,
    limit_tick: u32,
    qty_lots: u64,
    start_tick: u32,
    nonce: u64,
    window: SlotWindow,
    flags: PlaceFlags,
) -> (bool, u64, i128) {
    taker.require_auth();
    store::require_not_paused(env);
    let m = store::load_market(env, market);
    crate::market::require_qty(env, &m, qty_lots);
    crate::market::require_tick(env, &m, limit_tick);
    crate::market::require_start(env, &m, start_tick);
    if window.consume.len() > m.max_levels_crossed {
        env.panic_with_error(Error::BadWindow);
    }
    if window.append.first > window.append.last {
        env.panic_with_error(Error::BadWindow);
    }

    if flags.post_only {
        let opp = store::load_best(env, market, !is_bid);
        if !opp.empty && rest::crosses(is_bid, opp.tick, limit_tick) {
            env.panic_with_error(Error::Crossed);
        }
    }

    let (filled, quote, remainder) = take_one(
        env, market, &m, is_bid, limit_tick, qty_lots, start_tick, &window,
    );

    if remainder > 0 && flags.fill_or_kill {
        env.panic_with_error(Error::Unfilled);
    }

    let mut rested = false;
    if remainder > 0 {
        let opp = store::load_best(env, market, !is_bid);
        let still_crosses = !opp.empty && rest::crosses(is_bid, opp.tick, limit_tick);
        if !flags.no_rest && !still_crosses {
            rest::rest(
                env, &taker, market, &m, is_bid, limit_tick, remainder, nonce, &window, false,
            );
            rested = true;
        }
    }

    pay_place(
        env, &taker, market, &m, is_bid, nonce, filled, quote, rested,
    );
    (rested, filled, quote)
}

fn take_one(
    env: &Env,
    market: u32,
    m: &Market,
    taker_is_bid: bool,
    limit_tick: u32,
    qty: u64,
    start_tick: u32,
    window: &SlotWindow,
) -> (u64, i128, u64) {
    let opp = !taker_is_bid;
    if !rest::crosses(taker_is_bid, start_tick, limit_tick) {
        return (0, 0, qty);
    }
    let mut lvl = store::load_level(env, market, opp, start_tick);
    if lvl.open_lots == 0 {
        if store::level_exists(env, market, opp, start_tick) {
            rest::clear_presence(env, market, opp, start_tick);
        }
        return (0, 0, qty);
    }
    if lvl.open_lots <= qty {
        let took = lvl.open_lots;
        let quote = quote_atoms(env, took, start_tick, m.tick_size);
        let gen = lvl.generation;
        level::sweep_reset(env, &mut lvl);
        store::save_level(env, market, opp, start_tick, &lvl);
        rest::clear_presence(env, market, opp, start_tick);
        store::save_best(
            env,
            market,
            opp,
            &BestTick {
                empty: false,
                tick: start_tick,
            },
        );
        events::filled(env, market, opp, start_tick, took, quote);
        events::swept(env, market, opp, start_tick, gen);
        return (took, quote, qty - took);
    }

    let page_last = consume_last(window, start_tick);
    let took = consume_partial(env, market, m, opp, start_tick, &mut lvl, qty, page_last);
    let quote = quote_atoms(env, took, start_tick, m.tick_size);
    store::save_level(env, market, opp, start_tick, &lvl);
    events::filled(env, market, opp, start_tick, took, quote);
    (took, quote, qty - took)
}

fn consume_last(window: &SlotWindow, tick: u32) -> Option<u32> {
    for w in window.consume.iter() {
        if w.tick == tick {
            return Some(w.pages.last);
        }
    }
    Some(0)
}

fn consume_partial(
    env: &Env,
    market: u32,
    m: &Market,
    is_bid: bool,
    tick: u32,
    lvl: &mut pagebook_types::Level,
    want: u64,
    page_last: Option<u32>,
) -> u64 {
    let mut left = want;
    let mut scanned = 0u32;
    while left > 0 && lvl.head_seq < lvl.tail_seq && scanned < m.max_slots_scanned {
        if !pagebook_types::is_inline(lvl.head_seq) {
            if let Some(last) = page_last {
                if pagebook_types::page(lvl.head_seq) > last {
                    break;
                }
            }
        }
        let qty = level::slot_qty(env, market, is_bid, tick, lvl, lvl.head_seq);
        if qty == 0 || lvl.head_consumed_lots >= qty {
            lvl.head_seq += 1;
            lvl.head_consumed_lots = 0;
            scanned += 1;
            continue;
        }
        let open = qty - lvl.head_consumed_lots;
        let take = core::cmp::min(open, left);
        lvl.head_consumed_lots += take;
        level::consume_open(env, lvl, take);
        left -= take;
        scanned += 1;
        if lvl.head_consumed_lots >= qty {
            lvl.head_seq += 1;
            lvl.head_consumed_lots = 0;
        }
    }
    want - left
}

fn pay_place(
    env: &Env,
    taker: &Address,
    market: u32,
    m: &Market,
    is_bid: bool,
    nonce: u64,
    filled: u64,
    quote: i128,
    rested: bool,
) {
    let mut base_net: i128 = 0;
    let mut quote_net: i128 = 0;
    if filled > 0 {
        if is_bid {
            settle::net_add(env, &mut quote_net, quote);
            let out = crate::math::base_atoms(env, filled, m.lot_size);
            let fee = taker_fee(env, out, m.taker_fee_bps);
            settle::net_sub(env, &mut base_net, out - fee);
            settle::accrue_fee(env, market, &m.base, fee);
        } else {
            settle::net_add(
                env,
                &mut base_net,
                crate::math::base_atoms(env, filled, m.lot_size),
            );
            let fee = taker_fee(env, quote, m.taker_fee_bps);
            settle::net_sub(env, &mut quote_net, quote - fee);
            settle::accrue_fee(env, market, &m.quote, fee);
        }
    }
    if rested {
        let order = store::load_order(env, market, taker, nonce)
            .unwrap_or_else(|| env.panic_with_error(Error::UnknownOrder));
        let (tok, amt) = settle::escrow_for(env, m, is_bid, order.tick, order.qty_lots);
        if tok == m.base {
            settle::net_add(env, &mut base_net, amt);
        } else {
            settle::net_add(env, &mut quote_net, amt);
        }
    }
    settle::apply_net(env, &m.base, taker, base_net);
    settle::apply_net(env, &m.quote, taker, quote_net);
}
