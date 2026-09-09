//! Constructed worst-case shapes for M4 resource gates (architecture §17,
//! docs/08-worst-case-matrix.md).
//!
//! The 32-level / 32-word sweep is the entry-count ceiling: one ask in each of
//! 32 words, then a bid that takes them all — 72 writes. With occupancy-sized
//! slot vectors (ADR-036) a swept `Level` is written empty, so the write-byte
//! ceiling moves to rewrites of deep levels: the "deep" shapes below rest into
//! or replace onto levels that already hold 31 orders, so every `Level` write
//! is at its 32-slot maximum. Gates are measured + slack.

extern crate std;

use super::footprint::footprint_of;
use super::harness::{flags, mint, setup, window, Harness};
use crate::{DataKey, PlaceFlags};
use pagebook_types::{INLINE_SLOTS, WORD_TICKS};
use soroban_sdk::{testutils::Address as _, Address};

const WORDS: u32 = 32;
const TICK_MAX: u32 = WORDS * WORD_TICKS;
const CAL_MAX_SWEEP_WRITES: u32 = 72;
const CAL_MAX_SWEEP_BYTES: u32 = 23_052;
const CAL_BATCH40_WRITES: u32 = 124;
const CAL_BATCH40_BYTES: u32 = 36_572;
const CAL_DEEP_REST_BYTES: u32 = 1_476;
const CAL_DEEP_BATCH40_BYTES: u32 = 51_080;
const SLACK_WRITES: u32 = 2;
const SLACK_BYTES: u32 = 512;

fn no_rest() -> PlaceFlags {
    PlaceFlags {
        post_only: false,
        fill_or_kill: false,
        no_rest: true,
    }
}

fn ask_tick(word: u32) -> u32 {
    WORD_TICKS * word + 5
}

fn rest_ask_on(h: &Harness, market: u32, maker: &Address, tick: u32, qty: u64, nonce: u64) {
    mint(h, &h.base, maker, 1_000_000_000);
    h.client().place(
        maker,
        &market,
        &false,
        &tick,
        &qty,
        &tick,
        &nonce,
        &window(h),
        &flags(),
    );
}

/// One ask in each of 32 TickWords on a market whose band covers them.
fn book_32x32(h: &Harness) -> u32 {
    let market = h.client().create_market(
        &h.base, &h.quote, &1, &1, &1, &TICK_MAX, &10, &1, &1_000_000,
    );
    h.client()
        .set_market_caps(&market, &WORDS, &64, &10, &1, &1_000_000, &1);
    let maker = Address::generate(&h.env);
    for w in 0..WORDS {
        rest_ask_on(h, market, &maker, ask_tick(w), 1, u64::from(w) + 1);
    }
    market
}

#[test]
fn bound_place_max_sweep_32_levels_32_words() {
    let h = setup();
    let market = book_32x32(&h);
    let last = ask_tick(WORDS - 1);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 10_000_000);

    let q = h.client().quote_place(&market, &true, &last, &32);
    let declared_words = q
        .keys
        .iter()
        .filter(|k| matches!(k, DataKey::TickWord(_, false, _)))
        .count();
    std::println!(
        "max-sweep quote_place: crossed={} declared opposite TickWords={} (client declares 32 words)",
        q.crossed.len(),
        declared_words
    );
    assert_eq!(q.crossed.len(), WORDS);
    assert_eq!(
        declared_words, WORDS as usize,
        "client TickWord declarations for this shape are 32 words"
    );

    let ((rested, filled, _), fp) = footprint_of(&h.env, &h.id, || {
        h.client().place(
            &taker,
            &market,
            &true,
            &last,
            &32,
            &ask_tick(0),
            &1,
            &window(&h),
            &no_rest(),
        )
    });
    assert!(!rested);
    assert_eq!(filled, 32);
    let max_writes = CAL_MAX_SWEEP_WRITES + SLACK_WRITES;
    let max_bytes = CAL_MAX_SWEEP_BYTES + SLACK_BYTES;
    std::println!(
        "footprint[place max take 32 levels / 32 words]: memory_read_entries={} write_entries={} write_bytes={} (gates {} / {}; §17 was ~70 / ~22 KB)",
        fp.memory_read_entries,
        fp.write_entries,
        fp.write_bytes,
        max_writes,
        max_bytes
    );
    assert!(
        fp.write_entries <= max_writes,
        "place max sweep: write_entries {} > gate {max_writes} (measured {}; §17 ~70)",
        fp.write_entries,
        fp.write_entries
    );
    assert!(
        fp.write_bytes <= max_bytes,
        "place max sweep: write_bytes {} > gate {max_bytes} (measured {}; §17 ~22 KB)",
        fp.write_bytes,
        fp.write_bytes
    );
}

#[test]
fn bound_replace_batch_forty_quotes() {
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 1..=40u64 {
        super::harness::rest_ask(&h, &maker, 10 + n as u32, 2, n);
    }
    let mut items = soroban_sdk::Vec::new(&h.env);
    for n in 1..=40u64 {
        items.push_back(crate::ReplaceItem {
            nonce: n,
            is_bid: false,
            tick: 100 + n as u32,
            qty_lots: 3,
            window: window(&h),
        });
    }
    let (_, fp) = footprint_of(&h.env, &h.id, || {
        h.client().replace_batch(&maker, &h.market, &items)
    });
    let max_writes = CAL_BATCH40_WRITES + SLACK_WRITES;
    let max_bytes = CAL_BATCH40_BYTES + SLACK_BYTES;
    std::println!(
        "footprint[replace_batch 40]: memory_read_entries={} write_entries={} write_bytes={} (gates {} / {}; §17 was ~90 / ~24 KB)",
        fp.memory_read_entries,
        fp.write_entries,
        fp.write_bytes,
        max_writes,
        max_bytes
    );
    assert!(
        fp.write_entries <= max_writes,
        "replace_batch 40: write_entries {} > gate {max_writes} (measured {})",
        fp.write_entries,
        fp.write_entries
    );
    assert!(
        fp.write_bytes <= max_bytes,
        "replace_batch 40: write_bytes {} > gate {max_bytes} (measured {})",
        fp.write_bytes,
        fp.write_bytes
    );
}

/// Fill `tick` with `INLINE_SLOTS - 1` one-lot asks from a third party, so the
/// next rest there writes the `Level` at its maximum size.
fn deepen(h: &Harness, tick: u32, nonce_base: u64) {
    let other = Address::generate(&h.env);
    for i in 0..(INLINE_SLOTS - 1) as u64 {
        super::harness::rest_ask(h, &other, tick, 1, nonce_base + i);
    }
}

/// Write-byte ceiling for a rest: the 32nd order at a level (a full 32-slot
/// `Level`, 572 B payload) plus the `Order`.
#[test]
fn bound_place_rest_into_deep_level() {
    let h = setup();
    deepen(&h, 10, 1_000);
    let maker = Address::generate(&h.env);
    mint(&h, &h.base, &maker, 1_000_000_000);
    let (_, fp) = footprint_of(&h.env, &h.id, || {
        h.client().place(
            &maker,
            &h.market,
            &false,
            &10,
            &1,
            &10,
            &1,
            &window(&h),
            &flags(),
        )
    });
    let max_bytes = CAL_DEEP_REST_BYTES + SLACK_BYTES;
    std::println!(
        "footprint[place rest into deep level]: memory_read_entries={} write_entries={} write_bytes={} (gate {})",
        fp.memory_read_entries,
        fp.write_entries,
        fp.write_bytes,
        max_bytes
    );
    assert!(
        fp.write_bytes <= max_bytes,
        "rest into deep level: write_bytes {} > gate {max_bytes}",
        fp.write_bytes
    );
}

/// Write-byte ceiling for the batch: 40 quotes each moved onto a level that
/// already holds 31 orders, so all 40 new `Level` writes are at maximum size.
#[test]
fn bound_replace_batch_forty_onto_deep_levels() {
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 1..=40u64 {
        super::harness::rest_ask(&h, &maker, 10 + n as u32, 2, n);
    }
    for n in 1..=40u32 {
        deepen(&h, 100 + n, 10_000 * u64::from(n));
    }
    let mut items = soroban_sdk::Vec::new(&h.env);
    for n in 1..=40u64 {
        items.push_back(crate::ReplaceItem {
            nonce: n,
            is_bid: false,
            tick: 100 + n as u32,
            qty_lots: 3,
            window: window(&h),
        });
    }
    // The SDK test host's metering scales with total storage size, not with
    // the footprint: with the ~1,300 orders this shape seeds, the invocation
    // costs ~100x its network instructions and `footprint_of`'s snapshot trips
    // the 400M per-tx cap. So the budget is lifted, the host meter is read
    // directly (any later host call resets it), and only bytes are asserted.
    // Per-op network cost is in ADR-036: a full-level rewrite is ~+180k
    // instructions over a one-slot one.
    h.env.cost_estimate().budget().reset_unlimited();
    h.client().replace_batch(&maker, &h.market, &items);
    let res = h.env.cost_estimate().resources();
    let max_writes = CAL_BATCH40_WRITES + SLACK_WRITES;
    let max_bytes = CAL_DEEP_BATCH40_BYTES + SLACK_BYTES;
    std::println!(
        "footprint[replace_batch 40 onto deep levels]: memory_read_entries={} write_entries={} write_bytes={} (gates {} / {})",
        res.memory_read_entries,
        res.write_entries,
        res.write_bytes,
        max_writes,
        max_bytes
    );
    assert!(res.write_entries <= max_writes);
    assert!(
        res.write_bytes <= max_bytes,
        "replace_batch 40 onto deep levels: write_bytes {} > gate {max_bytes}",
        res.write_bytes
    );
    assert!(
        res.write_bytes <= 132_096,
        "deep batch must fit the per-tx write-byte cap"
    );
}

/// MAX_REPLACE_BATCH must be reachable on-chain in its worst shape (every item
/// on its own word, every item to a fresh tick): footprint ≤ 400 entries,
/// writes ≤ 200, contract events ≤ 16,384 B, write bytes ≤ 132,096 (03). At the
/// earlier 64 the events alone were ~22 KB (ADR-024).
#[test]
fn max_replace_batch_dispersed_fits_every_per_tx_limit() {
    let h = setup();
    let market = h.client().create_market(
        &h.base,
        &h.quote,
        &1,
        &1,
        &1,
        &(2 * pagebook_types::MAX_REPLACE_BATCH * WORD_TICKS + 10),
        &10,
        &1,
        &1_000_000,
    );
    let maker = Address::generate(&h.env);
    let n = pagebook_types::MAX_REPLACE_BATCH;
    for i in 0..n {
        rest_ask_on(&h, market, &maker, ask_tick(2 * i), 2, i as u64 + 1);
    }
    let mut items = soroban_sdk::Vec::new(&h.env);
    for i in 0..n {
        items.push_back(crate::ReplaceItem {
            nonce: i as u64 + 1,
            is_bid: false,
            tick: ask_tick(2 * i + 1),
            qty_lots: 3,
            window: window(&h),
        });
    }
    // read the meter right after the call (any later host call resets it)
    h.client().replace_batch(&maker, &market, &items);
    let res = h.env.cost_estimate().resources();
    let entries = res.memory_read_entries + res.disk_read_entries;
    std::println!(
        "footprint[replace_batch {n} dispersed]: entries={} write_entries={} write_bytes={} events_bytes={}",
        entries,
        res.write_entries,
        res.write_bytes,
        res.contract_events_size_bytes
    );
    assert!(entries <= 400, "footprint entries {entries} > 400");
    assert!(
        res.write_entries <= 200,
        "write entries {} > 200",
        res.write_entries
    );
    assert!(
        res.write_bytes <= 132_096,
        "write bytes {} > 132,096",
        res.write_bytes
    );
    assert!(
        res.contract_events_size_bytes <= 16_384,
        "event bytes {} > 16,384",
        res.contract_events_size_bytes
    );
}
