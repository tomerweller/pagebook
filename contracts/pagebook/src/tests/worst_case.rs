//! Constructed worst-case shapes for M4 resource gates (architecture §17,
//! docs/08-worst-case-matrix.md).
//!
//! The 32-level / 32-word sweep is the design ceiling: one ask in each of 32
//! words, then a bid that takes them all. §17 quoted ~70 writes / ~22 KB; the
//! host meters 72 / 26,640 (see 08). Gates are measured + slack.

extern crate std;

use super::footprint::footprint_of;
use super::harness::{flags, mint, setup, window, Harness};
use crate::{DataKey, PlaceFlags};
use pagebook_types::WORD_TICKS;
use soroban_sdk::{testutils::Address as _, Address};

const WORDS: u32 = 32;
const TICK_MAX: u32 = WORDS * WORD_TICKS;
const CAL_MAX_SWEEP_WRITES: u32 = 72;
const CAL_MAX_SWEEP_BYTES: u32 = 26_640;
const CAL_BATCH40_WRITES: u32 = 124;
const CAL_BATCH40_BYTES: u32 = 44_256;
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
