use crate::errors::Error;
use pagebook_types::{Level, Market};
use soroban_sdk::Env;

/// A rest that finds an empty queue with history (`open_lots == 0`, slots
/// held) starts a new generation first (architecture §2, empty-level reset).
pub fn reset_empty(env: &Env, level: &mut Level) {
    if level.open_lots != 0 || level.tail() == 0 {
        return;
    }
    sweep_reset(env, level);
}

/// Append `qty` at the tail; returns the seq. `LevelFull` at the market's
/// `level_cap`.
pub fn append(env: &Env, m: &Market, level: &mut Level, qty: u64) -> u32 {
    reset_empty(env, level);
    if level.tail() >= m.level_cap {
        env.panic_with_error(Error::LevelFull);
    }
    let seq = level.push_slot(qty);
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

/// Start a new generation: checked increment, counters to zero, no slots.
pub fn sweep_reset(env: &Env, level: &mut Level) {
    if level.generation == u32::MAX {
        env.panic_with_error(Error::Overflow);
    }
    level.generation += 1;
    level.head_seq = 0;
    level.open_lots = 0;
    level.clear_slots(env);
}

/// Move the head past a run of zero slots (tombstones and consumed heads),
/// scanning at most `max_slots`. A longer run leaves the head on a zero slot
/// for the next take to clear (§7, stranded head).
pub fn advance_head(level: &mut Level, max_slots: u32) {
    let mut scanned = 0u32;
    while level.head_seq < level.tail() && scanned < max_slots {
        if level.slot(level.head_seq) != 0 {
            break;
        }
        level.head_seq += 1;
        scanned += 1;
    }
}

/// The §7 settlement rows for an order `(g, s, qty)` against a level: behind
/// the head or from an earlier generation it is filled; at the head its slot
/// holds what is still open; past the head nothing has been consumed.
pub fn preview_settle(order_g: u32, order_seq: u32, order_qty: u64, level: &Level) -> (u64, u64) {
    if order_g < level.generation || (order_g == level.generation && order_seq < level.head_seq) {
        return (order_qty, 0);
    }
    if order_g == level.generation && order_seq == level.head_seq {
        let open = core::cmp::min(level.slot(order_seq), order_qty);
        return (order_qty - open, open);
    }
    (0, order_qty)
}
