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

    let (filled, quote, remainder) = walk(
        env,
        market,
        &m,
        is_bid,
        limit_tick,
        qty_lots,
        start_tick,
        &window,
        Mode::Apply,
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

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum Mode {
    Apply,
    DryRun,
}

fn walk(
    env: &Env,
    market: u32,
    m: &Market,
    taker_is_bid: bool,
    limit_tick: u32,
    qty: u64,
    start_tick: u32,
    window: &SlotWindow,
    mode: Mode,
) -> (u64, i128, u64) {
    let opp = !taker_is_bid;
    let ascend = taker_is_bid;
    let recorded = store::load_best(env, market, opp);
    let mut cur = if recorded.empty {
        start_tick
    } else if ascend {
        core::cmp::max(recorded.tick, start_tick)
    } else {
        core::cmp::min(recorded.tick, start_tick)
    };
    let mut left = qty;
    let mut filled = 0u64;
    let mut quote = 0i128;
    let mut crossed = 0u32;
    let apply = mode == Mode::Apply;
    let mut last_tick = cur;
    while left > 0 && rest::crosses(taker_is_bid, cur, limit_tick) && crossed < m.max_levels_crossed
    {
        last_tick = cur;
        let mut lvl = store::load_level(env, market, opp, cur);
        crossed += 1;
        if lvl.open_lots == 0 {
            if apply {
                rest::clear_presence(env, market, opp, cur);
            }
            match crate::bitmap::next_set_tick(env, market, opp, cur, ascend) {
                Some(n) => cur = n,
                None => {
                    if apply {
                        store::save_best(
                            env,
                            market,
                            opp,
                            &BestTick {
                                empty: true,
                                tick: cur,
                            },
                        );
                    }
                    break;
                }
            }
            continue;
        }
        if lvl.open_lots <= left {
            let took = lvl.open_lots;
            let q = quote_atoms(env, took, cur, m.tick_size);
            filled += took;
            quote = crate::math::chk_add(env, quote, q);
            left -= took;
            if apply {
                let gen = lvl.generation;
                level::sweep_reset(env, &mut lvl);
                store::save_level(env, market, opp, cur, &lvl);
                rest::clear_presence(env, market, opp, cur);
                events::filled(env, market, opp, cur, took, q);
                events::swept(env, market, opp, cur, gen);
            }
            if left == 0 {
                if apply {
                    store::save_best(
                        env,
                        market,
                        opp,
                        &BestTick {
                            empty: false,
                            tick: cur,
                        },
                    );
                }
                break;
            }
            match crate::bitmap::next_set_tick(env, market, opp, cur, ascend) {
                Some(n) => cur = n,
                None => {
                    if apply {
                        store::save_best(
                            env,
                            market,
                            opp,
                            &BestTick {
                                empty: true,
                                tick: cur,
                            },
                        );
                    }
                    break;
                }
            }
            continue;
        }
        let page_last = consume_last(window, cur);
        let took = consume_partial(env, market, m, opp, cur, &mut lvl, left, page_last);
        let q = quote_atoms(env, took, cur, m.tick_size);
        filled += took;
        quote = crate::math::chk_add(env, quote, q);
        left -= took;
        if apply {
            store::save_level(env, market, opp, cur, &lvl);
            events::filled(env, market, opp, cur, took, q);
            store::save_best(
                env,
                market,
                opp,
                &BestTick {
                    empty: false,
                    tick: cur,
                },
            );
        }
        break;
    }
    let _ = last_tick;
    (filled, quote, left)
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

pub fn quote_place(
    env: &Env,
    market: u32,
    is_bid: bool,
    limit_tick: u32,
    qty: u64,
) -> crate::iface::QuoteResult {
    let m = store::load_market(env, market);
    crate::market::require_tick(env, &m, limit_tick);
    let opp = store::load_best(env, market, !is_bid);
    let start_tick = if opp.empty { limit_tick } else { opp.tick };
    let window = crate::iface::empty_window(env);
    let _ = walk(
        env,
        market,
        &m,
        is_bid,
        limit_tick,
        qty,
        start_tick,
        &window,
        Mode::DryRun,
    );
    let mut crossed = soroban_sdk::Vec::new(env);
    let mut keys = soroban_sdk::Vec::new(env);
    let mut t = start_tick;
    let ascend = is_bid;
    let mut n = 0u32;
    while rest::crosses(is_bid, t, limit_tick) && n < m.max_levels_crossed {
        crossed.push_back(t);
        keys.push_back(crate::iface::QuotedKey {
            key: crate::keys::DataKey::Level(market, !is_bid, t),
            archived: false,
        });
        n += 1;
        match crate::bitmap::next_set_tick(env, market, !is_bid, t, ascend) {
            Some(nx) => t = nx,
            None => break,
        }
    }
    if crossed.is_empty() {
        keys.push_back(crate::iface::QuotedKey {
            key: crate::keys::DataKey::Level(market, !is_bid, start_tick),
            archived: false,
        });
    }
    keys.push_back(crate::iface::QuotedKey {
        key: crate::keys::DataKey::Level(market, is_bid, limit_tick),
        archived: false,
    });
    keys.push_back(crate::iface::QuotedKey {
        key: crate::keys::DataKey::BestTick(market, !is_bid),
        archived: false,
    });
    keys.push_back(crate::iface::QuotedKey {
        key: crate::keys::DataKey::BestTick(market, is_bid),
        archived: false,
    });
    keys.push_back(crate::iface::QuotedKey {
        key: crate::keys::DataKey::TickSummary(market, !is_bid),
        archived: false,
    });
    keys.push_back(crate::iface::QuotedKey {
        key: crate::keys::DataKey::TickSummary(market, is_bid),
        archived: false,
    });
    let own = store::load_level(env, market, is_bid, limit_tick);
    crate::iface::QuoteResult {
        start_tick,
        crossed,
        tail_seq: own.tail_seq,
        keys,
    }
}
