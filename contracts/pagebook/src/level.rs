use crate::errors::Error;
use crate::store;
use pagebook_types::{is_inline, level_cap, page, slot_in_page, Level, Market};
use soroban_sdk::Env;

pub fn slot_qty(env: &Env, market: u32, is_bid: bool, tick: u32, level: &Level, seq: u32) -> u64 {
    if seq >= level.tail_seq {
        return 0;
    }
    if is_inline(seq) {
        level.slots[seq as usize]
    } else {
        let p = page(seq);
        let i = slot_in_page(seq);
        store::load_page(env, market, is_bid, tick, p).slots[i as usize]
    }
}

pub fn write_slot(
    env: &Env,
    market: u32,
    is_bid: bool,
    tick: u32,
    level: &mut Level,
    seq: u32,
    qty: u64,
) {
    if is_inline(seq) {
        level.slots[seq as usize] = qty;
        return;
    }
    let p = page(seq);
    let i = slot_in_page(seq);
    let mut pg = store::load_page(env, market, is_bid, tick, p);
    pg.slots[i as usize] = qty;
    store::save_page(env, market, is_bid, tick, p, &pg);
}

pub fn reset_empty(env: &Env, level: &mut Level) {
    if level.open_lots != 0 || level.tail_seq == 0 {
        return;
    }
    sweep_reset(env, level);
}

pub fn append(
    env: &Env,
    market: u32,
    is_bid: bool,
    tick: u32,
    m: &Market,
    level: &mut Level,
    qty: u64,
    append_first: u32,
    append_last: u32,
) -> u32 {
    reset_empty(env, level);
    let cap = level_cap(m.max_pages);
    if level.tail_seq >= cap {
        env.panic_with_error(Error::LevelFull);
    }
    let seq = level.tail_seq;
    if !is_inline(seq) {
        let p = page(seq);
        if p >= m.max_pages {
            env.panic_with_error(Error::LevelFull);
        }
        // Same window rule as consumption: page 0 is always implied, any other
        // page must lie inside the declared inclusive range (ADR-021).
        if p != 0 && (p < append_first || p > append_last) {
            env.panic_with_error(Error::RetryRest);
        }
    }
    write_slot(env, market, is_bid, tick, level, seq, qty);
    level.tail_seq = seq + 1;
    level.open_lots = level
        .open_lots
        .checked_add(qty)
        .unwrap_or_else(|| env.panic_with_error(Error::Overflow));
    seq
}

pub fn consume_open(env: &Env, level: &mut Level, lots: u64) {
    if lots > level.open_lots {
        env.panic_with_error(Error::Overflow);
    }
    level.open_lots -= lots;
}

pub fn sweep_reset(env: &Env, level: &mut Level) {
    if level.generation == u32::MAX {
        env.panic_with_error(Error::Overflow);
    }
    level.generation += 1;
    level.head_seq = 0;
    level.head_consumed_lots = 0;
    level.tail_seq = 0;
    level.open_lots = 0;
}

/// The one window predicate (05 "Encoding decisions"): an inline head is always
/// readable; page 0 is always implied; any other page is readable only inside the
/// declared inclusive range; a level with no declared window is inline-only.
pub fn head_in_window(level: &Level, window: Option<(u32, u32)>) -> bool {
    if is_inline(level.head_seq) {
        return true;
    }
    let p = page(level.head_seq);
    if p == 0 {
        return window.is_some();
    }
    match window {
        Some((first, last)) => p >= first && p <= last,
        None => false,
    }
}

pub fn advance_head(
    env: &Env,
    market: u32,
    is_bid: bool,
    tick: u32,
    level: &mut Level,
    max_slots: u32,
    window: Option<(u32, u32)>,
) {
    let mut scanned = 0u32;
    while level.head_seq < level.tail_seq && scanned < max_slots {
        if !head_in_window(level, window) {
            break;
        }
        let qty = slot_qty(env, market, is_bid, tick, level, level.head_seq);
        if qty == 0 || level.head_consumed_lots >= qty {
            level.head_seq += 1;
            level.head_consumed_lots = 0;
            scanned += 1;
            continue;
        }
        break;
    }
}

pub fn preview_settle(order_g: u32, order_seq: u32, order_qty: u64, level: &Level) -> (u64, u64) {
    if order_g < level.generation || (order_g == level.generation && order_seq < level.head_seq) {
        return (order_qty, 0);
    }
    if order_g == level.generation && order_seq == level.head_seq {
        let filled = core::cmp::min(level.head_consumed_lots, order_qty);
        return (filled, order_qty - filled);
    }
    (0, order_qty)
}
