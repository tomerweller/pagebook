use crate::errors::Error;
use crate::events;
use crate::iface::{CrossedLevel, PlaceFlags, QuoteResult, SlotWindow};
use crate::keys::DataKey;
use crate::level;
use crate::math::{quote_atoms, taker_fee};
use crate::rest;
use crate::settle::{self, Netting};
use crate::store;
use pagebook_types::{word_of, BestTick, Market};
use soroban_sdk::{Address, Env, Vec};

/// Per-transaction loop budget (architecture §8, invariant 7): one budget spans
/// every leg of a `route`, so a route's ceiling is one maximal place.
#[derive(Clone, Copy)]
pub struct Budget {
    pub levels: u32,
    pub slots: u32,
}

impl Budget {
    pub fn from_market(m: &Market) -> Self {
        Self {
            levels: m.max_levels_crossed,
            slots: m.max_slots_scanned,
        }
    }

    /// Clamp a shared budget to another market's caps (a route across markets
    /// never exceeds any of its markets' caps).
    pub fn clamp_to(&mut self, m: &Market) {
        self.levels = core::cmp::min(self.levels, m.max_levels_crossed);
        self.slots = core::cmp::min(self.slots, m.max_slots_scanned);
    }
}

/// Entry point: authenticates, checks pause, runs one place, settles the taker's
/// token movement in one transfer per token.
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
    let mut budget = Budget::from_market(&m);
    let mut net = Netting::new(env);
    let out = place_body(
        env,
        &taker,
        market,
        &m,
        is_bid,
        limit_tick,
        qty_lots,
        start_tick,
        nonce,
        &window,
        &flags,
        &mut budget,
        &mut net,
    );
    net.flush(env, &taker);
    out
}

/// The body of one place: no auth, no pause check, no transfers — the caller
/// (`place`, or `route` once per leg) owns those.
pub fn place_body(
    env: &Env,
    taker: &Address,
    market: u32,
    m: &Market,
    is_bid: bool,
    limit_tick: u32,
    qty_lots: u64,
    start_tick: u32,
    nonce: u64,
    window: &SlotWindow,
    flags: &PlaceFlags,
    budget: &mut Budget,
    net: &mut Netting,
) -> (bool, u64, i128) {
    crate::market::require_qty(env, m, qty_lots);
    crate::market::require_tick(env, m, limit_tick);
    crate::market::require_start(env, m, start_tick);
    if window.consume.len() > m.max_levels_crossed {
        env.panic_with_error(Error::BadWindow);
    }
    if window.append.first > window.append.last {
        env.panic_with_error(Error::BadWindow);
    }
    for w in window.consume.iter() {
        if w.pages.first > w.pages.last {
            env.panic_with_error(Error::BadWindow);
        }
    }

    let recorded = store::load_best(env, market, !is_bid);
    if flags.post_only && !recorded.empty && rest::crosses(is_bid, recorded.tick, limit_tick) {
        env.panic_with_error(Error::Crossed);
    }

    let out = walk(
        env,
        market,
        m,
        is_bid,
        limit_tick,
        qty_lots,
        start_tick,
        &recorded,
        window,
        budget,
        Mode::Apply,
        None,
    );

    if out.left > 0 && flags.fill_or_kill {
        env.panic_with_error(Error::Unfilled);
    }

    // Rest the remainder only if nothing on the book still crosses the limit
    // (invariant 8), the caller wants a rest, and the remainder is not dust: a
    // remainder below `min_order_lots` is refunded, never rested and never a
    // reason to fail the completed takes.
    let mut rested = false;
    if out.left > 0 && !flags.no_rest && !out.crossing_remains && out.left >= m.min_order_lots {
        rest::rest(
            env, taker, market, m, is_bid, limit_tick, out.left, nonce, window, false,
        );
        rested = true;
    }

    // Taker's token movement, netted into `net` (flushed by the entry point).
    if out.filled > 0 {
        if is_bid {
            net.add(env, &m.quote, out.quote);
            let base_out = crate::math::base_atoms(env, out.filled, m.lot_size);
            let fee = taker_fee(env, base_out, m.taker_fee_bps);
            net.sub(env, &m.base, crate::math::chk_sub(env, base_out, fee));
            settle::accrue_fee(env, market, &m.base, fee);
        } else {
            net.add(
                env,
                &m.base,
                crate::math::base_atoms(env, out.filled, m.lot_size),
            );
            let fee = taker_fee(env, out.quote, m.taker_fee_bps);
            net.sub(env, &m.quote, crate::math::chk_sub(env, out.quote, fee));
            settle::accrue_fee(env, market, &m.quote, fee);
        }
    }
    if rested {
        let (tok, amt) = settle::escrow_for(env, m, is_bid, limit_tick, out.left);
        net.add(env, &tok, amt);
    }
    (rested, out.filled, out.quote)
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum Mode {
    Apply,
    DryRun,
}

pub struct WalkOut {
    pub filled: u64,
    pub quote: i128,
    pub left: u64,
    /// True when the walk stopped while a level at-or-better than `limit_tick`
    /// may still hold liquidity (cap hit, window edge, or the recorded best was
    /// better than `start_tick` and crosses the limit) — the remainder must be
    /// refunded, never rested.
    pub crossing_remains: bool,
}

/// The matching walk (architecture §8). Shared by `place` (Apply) and
/// `quote_place` (DryRun); the only difference is that DryRun writes nothing and
/// records the levels it visited into `trace`.
#[allow(clippy::too_many_arguments)]
fn walk(
    env: &Env,
    market: u32,
    m: &Market,
    taker_is_bid: bool,
    limit_tick: u32,
    qty: u64,
    start_tick: u32,
    recorded: &BestTick,
    window: &SlotWindow,
    budget: &mut Budget,
    mode: Mode,
    mut trace: Option<&mut Vec<CrossedLevel>>,
) -> WalkOut {
    let opp = !taker_is_bid;
    let ascend = taker_is_bid;
    let apply = mode == Mode::Apply;

    // Start at worse_of(recorded best, start_tick): ticks better than
    // start_tick are never visited (invariant 5).
    let mut cur = if recorded.empty {
        start_tick
    } else if ascend {
        core::cmp::max(recorded.tick, start_tick)
    } else {
        core::cmp::min(recorded.tick, start_tick)
    };
    // Only a walk that began at the recorded best may move BestTick(opposite):
    // otherwise the levels between the recorded best and start_tick were never
    // visited and the recorded best is still at-or-better than the truth.
    let began_at_best = recorded.empty || recorded.tick == cur;
    // A bounded scan that reaches the band's last word and finds nothing has
    // proven the side empty; any narrower "none" only proves "nothing up to the
    // limit's word".
    let exhaustive = if ascend {
        word_of(limit_tick) >= word_of(m.tick_max.saturating_sub(1))
    } else {
        word_of(limit_tick) <= word_of(m.tick_min)
    };

    let mut left = qty;
    let mut filled = 0u64;
    let mut quote = 0i128;
    let mut moved = false; // did the walk advance past the recorded best?
    let mut side_empty = false;
    let mut crossing_remains = false;

    while left > 0 && rest::crosses(taker_is_bid, cur, limit_tick) {
        if budget.levels == 0 {
            crossing_remains = true;
            break;
        }
        budget.levels -= 1;
        let mut lvl = store::load_level(env, market, opp, cur);
        if let Some(t) = trace.as_deref_mut() {
            t.push_back(CrossedLevel {
                tick: cur,
                head_seq: lvl.head_seq,
                open_lots: lvl.open_lots,
            });
        }
        if lvl.open_lots == 0 {
            // Stale bit (or an unpopulated start tick): clear lazily, no write
            // if the bit was already clear.
            if apply {
                crate::bitmap::clear_tick(env, market, opp, cur);
            }
            match crate::bitmap::next_set_tick(env, market, opp, cur, limit_tick, ascend) {
                Some(n) => {
                    cur = n;
                    moved = true;
                    continue;
                }
                None => {
                    side_empty = exhaustive;
                    break;
                }
            }
        }
        if lvl.open_lots <= left {
            // Sweep: one write, no slot reads.
            let took = lvl.open_lots;
            let q = quote_atoms(env, took, cur, m.tick_size);
            filled += took;
            quote = crate::math::chk_add(env, quote, q);
            left -= took;
            if apply {
                let gen = lvl.generation;
                level::sweep_reset(env, &mut lvl);
                store::save_level(env, market, opp, cur, &lvl);
                crate::bitmap::clear_tick(env, market, opp, cur);
                events::filled(env, market, opp, cur, took, q);
                events::swept(env, market, opp, cur, gen);
            }
            if left == 0 {
                // No scan past the last sweep: BestTick stays on the swept tick
                // (stale-better, invariant 3).
                moved = true;
                break;
            }
            match crate::bitmap::next_set_tick(env, market, opp, cur, limit_tick, ascend) {
                Some(n) => {
                    cur = n;
                    moved = true;
                    continue;
                }
                None => {
                    moved = true;
                    side_empty = exhaustive;
                    break;
                }
            }
        }
        // Partial: consume from the head inside the declared window and the
        // shared slot budget; progress persists even if a cap ends it.
        let page_last = consume_last(window, cur);
        let took = consume_partial(env, market, opp, cur, &mut lvl, left, page_last, budget);
        let q = quote_atoms(env, took, cur, m.tick_size);
        filled += took;
        quote = crate::math::chk_add(env, quote, q);
        left -= took;
        if apply {
            store::save_level(env, market, opp, cur, &lvl);
            if took > 0 {
                events::filled(env, market, opp, cur, took, q);
            }
        }
        moved = true;
        if left > 0 {
            // Window edge or scan cap stopped us at a level that still crosses.
            crossing_remains = true;
        }
        break;
    }

    // Loop ended because `cur` no longer crosses limit_tick (or qty is done):
    // nothing at-or-better than the limit remains on the visited side. If the
    // walk did NOT begin at the recorded best, the recorded best is still live
    // and decides.
    if !began_at_best && !recorded.empty && rest::crosses(taker_is_bid, recorded.tick, limit_tick) {
        crossing_remains = true;
    }

    // BestTick(opposite) maintenance: only a walk that began at the recorded
    // best may move it; move it to where the walk stands (a set-bit tick, a
    // partially consumed level, or the last swept tick — never worse than the
    // true best), or mark the side empty when the scan was exhaustive.
    if apply && began_at_best && (moved || side_empty) {
        let new = BestTick {
            empty: side_empty,
            tick: cur,
        };
        if new.empty != recorded.empty || new.tick != recorded.tick {
            store::save_best(env, market, opp, &new);
            let old = if recorded.empty { 0 } else { recorded.tick };
            events::top_changed(env, market, opp, old, if new.empty { 0 } else { new.tick });
        }
    }

    WalkOut {
        filled,
        quote,
        left,
        crossing_remains,
    }
}

/// The last page the client declared for consumption at `tick`; a level absent
/// from the consume window is inline-only (05 "Encoding decisions").
fn consume_last(window: &SlotWindow, tick: u32) -> Option<u32> {
    for w in window.consume.iter() {
        if w.tick == tick {
            return Some(w.pages.last);
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn consume_partial(
    env: &Env,
    market: u32,
    is_bid: bool,
    tick: u32,
    lvl: &mut pagebook_types::Level,
    want: u64,
    page_last: Option<u32>,
    budget: &mut Budget,
) -> u64 {
    let mut left = want;
    while left > 0 && lvl.head_seq < lvl.tail_seq && budget.slots > 0 {
        if !level::head_in_window(lvl, page_last) {
            break;
        }
        budget.slots -= 1;
        let qty = level::slot_qty(env, market, is_bid, tick, lvl, lvl.head_seq);
        if qty == 0 || lvl.head_consumed_lots >= qty {
            lvl.head_seq += 1;
            lvl.head_consumed_lots = 0;
            continue;
        }
        let open = qty - lvl.head_consumed_lots;
        let take = core::cmp::min(open, left);
        lvl.head_consumed_lots += take;
        level::consume_open(env, lvl, take);
        left -= take;
        if lvl.head_consumed_lots >= qty {
            lvl.head_seq += 1;
            lvl.head_consumed_lots = 0;
        }
    }
    want - left
}

/// The simulate step (§11/§14): the same walk in DryRun, plus the key set the
/// client should declare on both sides. Archival state is not observable from
/// inside a contract; the client marks restores from RPC (ADR-020).
pub fn quote_place(env: &Env, market: u32, is_bid: bool, limit_tick: u32, qty: u64) -> QuoteResult {
    let m = store::load_market(env, market);
    crate::market::require_tick(env, &m, limit_tick);
    let recorded = store::load_best(env, market, !is_bid);
    let start_tick = if recorded.empty {
        limit_tick
    } else if is_bid {
        core::cmp::min(recorded.tick, limit_tick)
    } else {
        core::cmp::max(recorded.tick, limit_tick)
    };
    let window = crate::iface::empty_window(env);
    let mut budget = Budget::from_market(&m);
    let mut crossed: Vec<CrossedLevel> = Vec::new(env);
    let out = walk(
        env,
        market,
        &m,
        is_bid,
        limit_tick,
        qty,
        start_tick,
        &recorded,
        &window,
        &mut budget,
        Mode::DryRun,
        Some(&mut crossed),
    );

    let opp = !is_bid;
    let mut keys: Vec<DataKey> = Vec::new(env);
    // Opposite side: every level the walk visited, every word the bounded scan
    // may read (start's word through limit's word), summary, best.
    for c in crossed.iter() {
        keys.push_back(DataKey::Level(market, opp, c.tick));
    }
    if crossed.is_empty() {
        keys.push_back(DataKey::Level(market, opp, start_tick));
    }
    let (w_lo, w_hi) = if word_of(start_tick) <= word_of(limit_tick) {
        (word_of(start_tick), word_of(limit_tick))
    } else {
        (word_of(limit_tick), word_of(start_tick))
    };
    let mut w = w_lo;
    while w <= w_hi {
        keys.push_back(DataKey::TickWord(market, opp, w));
        w += 1;
    }
    keys.push_back(DataKey::TickSummary(market, opp));
    keys.push_back(DataKey::BestTick(market, opp));
    // Own side, for the possible rest.
    keys.push_back(DataKey::Level(market, is_bid, limit_tick));
    keys.push_back(DataKey::TickWord(market, is_bid, word_of(limit_tick)));
    keys.push_back(DataKey::TickSummary(market, is_bid));
    keys.push_back(DataKey::BestTick(market, is_bid));
    keys.push_back(DataKey::FeeAccrual(market, m.base.clone()));
    keys.push_back(DataKey::FeeAccrual(market, m.quote.clone()));
    let own = store::load_level(env, market, is_bid, limit_tick);
    QuoteResult {
        start_tick,
        crossed,
        filled_lots: out.filled,
        quote_atoms: out.quote,
        tail_seq: own.tail_seq,
        keys,
    }
}
