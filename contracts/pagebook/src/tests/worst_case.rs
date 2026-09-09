//! Constructed worst-case shapes for M4 resource gates (architecture §17,
//! docs/08-worst-case-matrix.md).
//!
//! The 32-level / 32-word sweep is the entry-count ceiling: one ask in each of
//! 32 words, then a bid that takes them all, 72 writes. With occupancy-sized
//! slot vectors (ADR-036, ADR-037) a swept `Level` is written empty, so the
//! write-byte ceiling is a rewrite of a level at `level_cap`: the "deep"
//! shapes below rest into or replace onto levels that already hold
//! `LEVEL_CAP - 1` orders, so every `Level` write is at its maximum. Gates are
//! measured + slack.

extern crate std;

use super::footprint::footprint_of;
use super::harness::{flags, mint, no_rest, setup, Harness, TX_WRITE_BYTES_CAP};
use crate::DataKey;
use pagebook_types::{LEVEL_CAP, WORD_TICKS};
use soroban_sdk::{testutils::Address as _, Address};

const WORDS: u32 = 32;
const TICK_MAX: u32 = WORDS * WORD_TICKS;
const CAL_MAX_SWEEP_WRITES: u32 = 72;
const CAL_MAX_SWEEP_BYTES: u32 = 21_004;
const CAL_BATCH40_WRITES: u32 = 124;
const CAL_BATCH40_BYTES: u32 = 31_452;
pub const CAL_REFRESH40_BYTES: u32 = 21_320;
const CAL_DEEP_REST_BYTES: u32 = 1_796;
const CAL_DEEP_BATCH8_BYTES: u32 = 12_680;
const DEEP_BATCH_ITEMS: u64 = 8;
const SLACK_WRITES: u32 = 2;
const SLACK_BYTES: u32 = 512;

fn ask_tick(word: u32) -> u32 {
    WORD_TICKS * word + 5
}

fn rest_ask_on(h: &Harness, market: u32, maker: &Address, tick: u32, qty: u64, nonce: u64) {
    mint(h, &h.base, maker, 1_000_000_000);
    h.client()
        .place(maker, &market, &false, &tick, &qty, &tick, &nonce, &flags());
}

/// One ask in each of 32 TickWords on a market whose band covers them.
fn book_32x32(h: &Harness) -> u32 {
    let market = h.client().create_market(
        &h.base, &h.quote, &1, &1, &1, &TICK_MAX, &10, &1, &1_000_000,
    );
    h.client()
        .set_market_caps(&market, &WORDS, &64, &10, &1, &1_000_000, &64);
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
            &no_rest(),
        )
    });
    assert!(!rested);
    assert_eq!(filled, 32);
    let max_writes = CAL_MAX_SWEEP_WRITES + SLACK_WRITES;
    let max_bytes = CAL_MAX_SWEEP_BYTES + SLACK_BYTES;
    std::println!(
        "footprint[place max take 32 levels / 32 words]: memory_read_entries={} write_entries={} write_bytes={} (gates {} / {}; §17 row 72 / 21.0 KB)",
        fp.memory_read_entries,
        fp.write_entries,
        fp.write_bytes,
        max_writes,
        max_bytes
    );
    assert!(
        fp.write_entries <= max_writes,
        "place max sweep: write_entries {} > gate {max_writes} (measured {}; §17 72)",
        fp.write_entries,
        fp.write_entries
    );
    assert!(
        fp.write_bytes <= max_bytes,
        "place max sweep: write_bytes {} > gate {max_bytes} (measured {}; §17 21.0 KB)",
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
        });
    }
    let (_, fp) = footprint_of(&h.env, &h.id, || {
        h.client().replace_batch(&maker, &h.market, &items)
    });
    let max_writes = CAL_BATCH40_WRITES + SLACK_WRITES;
    let max_bytes = CAL_BATCH40_BYTES + SLACK_BYTES;
    std::println!(
        "footprint[replace_batch 40]: memory_read_entries={} write_entries={} write_bytes={} (gates {} / {}; §17 row 124 / 31.5 KB)",
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

/// Fill `tick` with `LEVEL_CAP - 1` one-lot asks from a third party, so the
/// next rest there writes the `Level` at its maximum size.
fn deepen(h: &Harness, tick: u32, nonce_base: u64) {
    let other = Address::generate(&h.env);
    for i in 0..(LEVEL_CAP - 1) as u64 {
        super::harness::rest_ask(h, &other, tick, 1, nonce_base + i);
    }
}

/// Write-byte ceiling for a rest: the 64th order at a level (a `Level` at
/// `LEVEL_CAP`, 892 B payload) plus the `Order`.
#[test]
fn bound_place_rest_into_deep_level() {
    let h = setup();
    deepen(&h, 10, 1_000);
    let maker = Address::generate(&h.env);
    mint(&h, &h.base, &maker, 1_000_000_000);
    let (_, fp) = footprint_of(&h.env, &h.id, || {
        h.client()
            .place(&maker, &h.market, &false, &10, &1, &10, &1, &flags())
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

/// Write-byte ceiling for the batch: quotes each moved onto a level that
/// already holds `LEVEL_CAP - 1` orders, so every new `Level` write is at
/// maximum size. Measured on 8 items and extrapolated to `MAX_REPLACE_BATCH`:
/// the SDK test host's metering scales with total storage size, not with the
/// footprint, and 40 items at this depth seed ~2,500 orders, past the host's
/// meter (ADR-036, ADR-037). Per-item cost is the slope; the fixed part is the
/// two SAC balances and the authorization nonce.
#[test]
fn bound_replace_batch_onto_deep_levels() {
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 1..=DEEP_BATCH_ITEMS {
        super::harness::rest_ask(&h, &maker, 10 + n as u32, 2, n);
    }
    for n in 1..=DEEP_BATCH_ITEMS as u32 {
        deepen(&h, 100 + n, 10_000 * u64::from(n));
    }
    let mut items = soroban_sdk::Vec::new(&h.env);
    for n in 1..=DEEP_BATCH_ITEMS {
        items.push_back(crate::ReplaceItem {
            nonce: n,
            is_bid: false,
            tick: 100 + n as u32,
            qty_lots: 3,
        });
    }
    h.env.cost_estimate().budget().reset_unlimited();
    h.client().replace_batch(&maker, &h.market, &items);
    let res = h.env.cost_estimate().resources();
    let max_bytes = CAL_DEEP_BATCH8_BYTES + SLACK_BYTES;
    const FIXED: u32 = 2 * 224 + 72;
    let per_item = (res.write_bytes - FIXED) / DEEP_BATCH_ITEMS as u32;
    let forty = FIXED + per_item * pagebook_types::MAX_REPLACE_BATCH;
    std::println!(
        "footprint[replace_batch {DEEP_BATCH_ITEMS} onto deep levels]: write_entries={} write_bytes={} (gate {}); per item {} B, extrapolated to 40 items: {} B",
        res.write_entries,
        res.write_bytes,
        max_bytes,
        per_item,
        forty
    );
    assert_eq!(res.write_entries, 3 * DEEP_BATCH_ITEMS as u32 + 3);
    assert!(
        res.write_bytes <= max_bytes,
        "replace_batch onto deep levels: write_bytes {} > gate {max_bytes}",
        res.write_bytes
    );
    assert!(
        forty <= TX_WRITE_BYTES_CAP,
        "a 40-item deep batch must fit the per-tx write-byte cap: {forty}"
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
        res.write_bytes <= TX_WRITE_BYTES_CAP,
        "write bytes {} > {TX_WRITE_BYTES_CAP}",
        res.write_bytes
    );
    assert!(
        res.contract_events_size_bytes <= 16_384,
        "event bytes {} > 16,384",
        res.contract_events_size_bytes
    );
}

/// The §17 "full refresh" row: 40 quotes re-sized in place (same tick).
#[test]
fn bound_replace_batch_forty_same_tick_refresh() {
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
            tick: 10 + n as u32,
            qty_lots: 3,
        });
    }
    let (_, fp) = footprint_of(&h.env, &h.id, || {
        h.client().replace_batch(&maker, &h.market, &items)
    });
    let max_bytes = CAL_REFRESH40_BYTES + SLACK_BYTES;
    std::println!(
        "footprint[replace_batch 40 same-tick refresh]: memory_read_entries={} write_entries={} write_bytes={} (gate {})",
        fp.memory_read_entries,
        fp.write_entries,
        fp.write_bytes,
        max_bytes
    );
    assert!(
        fp.write_bytes <= max_bytes,
        "replace_batch 40 refresh: write_bytes {} > gate {max_bytes}",
        fp.write_bytes
    );
}
