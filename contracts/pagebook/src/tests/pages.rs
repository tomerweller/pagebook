//! Overflow pages (architecture §2, 05 M3): inline → page 0, LEVEL_CAP,
//! tombstones inside a page, consume windows at the inline/page edge, the
//! stale-slot rule (invariant 9), empty-level reset over a dirty page, and
//! replace into/out of a page.

extern crate std;

use super::footprint::keys_touched;
use super::harness::{flags, mint, rest_ask, setup, window, Harness};
use crate::{ConsumeWindow, DataKey, Error, PageRange, PlaceFlags, SlotWindow};
use pagebook_types::{level_cap, INLINE_SLOTS, MAX_PAGES};
use soroban_sdk::{testutils::Address as _, Address};

fn no_rest() -> PlaceFlags {
    PlaceFlags {
        post_only: false,
        fill_or_kill: false,
        no_rest: true,
    }
}

/// A consume window covering pages 0..=1 at `tick` (what a client declares
/// after simulating a level whose head is inline).
fn consume_win(h: &Harness, tick: u32) -> SlotWindow {
    let mut consume = soroban_sdk::Vec::new(&h.env);
    consume.push_back(ConsumeWindow {
        tick,
        pages: PageRange { first: 0, last: 1 },
    });
    SlotWindow {
        consume,
        append: PageRange { first: 0, last: 1 },
    }
}

fn take_bid(
    h: &Harness,
    taker: &Address,
    limit: u32,
    qty: u64,
    nonce: u64,
    win: &SlotWindow,
) -> u64 {
    mint(h, &h.quote, taker, 1_000_000);
    let (_, filled, _) = h.client().place(
        taker,
        &h.market,
        &true,
        &limit,
        &qty,
        &limit,
        &nonce,
        win,
        &no_rest(),
    );
    filled
}

fn has_page(h: &Harness, is_bid: bool, tick: u32, page: u32) -> bool {
    h.env.as_contract(&h.id, || {
        h.env
            .storage()
            .persistent()
            .has(&DataKey::LevelPage(h.market, is_bid, tick, page))
    })
}

#[test]
fn thirty_third_rest_crosses_into_page_zero() {
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 1..=INLINE_SLOTS as u64 {
        rest_ask(&h, &maker, 20, 1, n);
    }
    assert!(!has_page(&h, false, 20, 0), "inline queue needs no page");
    let touched = keys_touched(&h, || rest_ask(&h, &maker, 20, 1, 33));
    assert!(touched.contains(&DataKey::LevelPage(h.market, false, 20, 0)));
    assert!(has_page(&h, false, 20, 0));
    let o = h.client().order(&h.market, &maker, &33);
    assert_eq!(o.seq, INLINE_SLOTS);
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.tail_seq, 33);
    assert_eq!(lvl.open_lots, 33);
}

#[test]
fn sixty_fifth_rest_is_level_full() {
    let h = setup();
    let cap = level_cap(MAX_PAGES);
    assert_eq!(cap, 64);
    let maker = Address::generate(&h.env);
    for n in 1..=u64::from(cap) {
        rest_ask(&h, &maker, 20, 1, n);
    }
    mint(&h, &h.base, &maker, 1_000);
    super::assert_err(
        h.client().try_place(
            &maker,
            &h.market,
            &false,
            &20,
            &1,
            &20,
            &65,
            &window(&h),
            &flags(),
        ),
        Error::LevelFull,
    );
    assert_eq!(h.client().level(&h.market, &false, &20).tail_seq, cap);
}

#[test]
fn settle_in_page_zero_writes_tombstone_and_take_skips_it() {
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 1..=40u64 {
        rest_ask(&h, &maker, 20, 1, n);
    }
    // nonce 35 → seq 34, inside page 0.
    assert_eq!(h.client().order(&h.market, &maker, &35).seq, 34);
    let touched = keys_touched(&h, || {
        let (paid, refunded) = h.client().settle(&maker, &h.market, &35);
        assert_eq!(paid, 0);
        assert_eq!(refunded, 1);
    });
    assert!(
        touched.contains(&DataKey::LevelPage(h.market, false, 20, 0)),
        "tombstone written into page 0"
    );
    assert_eq!(h.client().level(&h.market, &false, &20).open_lots, 39);
    // A partial take of 38 walks the head through the tombstone: 39 slots
    // scanned, head lands on seq 39.
    let taker = Address::generate(&h.env);
    let filled = take_bid(&h, &taker, 20, 38, 1, &consume_win(&h, 20));
    assert_eq!(filled, 38);
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.head_seq, 39);
    assert_eq!(lvl.open_lots, 1);
    // The last order is open; the first is filled.
    assert_eq!(h.client().settle(&maker, &h.market, &40), (0, 1));
    assert_eq!(h.client().settle(&maker, &h.market, &1), (20, 0));
}

#[test]
fn partial_take_into_page_zero_with_consume_window() {
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 1..=40u64 {
        rest_ask(&h, &maker, 20, 1, n);
    }
    let taker = Address::generate(&h.env);
    let mut filled = 0;
    let touched = keys_touched(&h, || {
        filled = take_bid(&h, &taker, 20, 35, 1, &consume_win(&h, 20));
    });
    assert_eq!(filled, 35);
    assert!(touched.contains(&DataKey::LevelPage(h.market, false, 20, 0)));
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.head_seq, 35);
    assert_eq!(lvl.open_lots, 5);
}

#[test]
fn partial_take_without_window_stops_at_inline_edge() {
    // No consume window: the head is readable while inline (32 slots), then the
    // window edge ends the walk. The remainder is refunded (never rested,
    // invariant 8), no LevelPage key is touched, and the book stays uncrossed.
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 1..=40u64 {
        rest_ask(&h, &maker, 20, 1, n);
    }
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let mut out = (false, 0u64, 0i128);
    let touched = keys_touched(&h, || {
        out = h.client().place(
            &taker,
            &h.market,
            &true,
            &20,
            &35,
            &20,
            &1,
            &window(&h),
            &flags(),
        );
    });
    assert_eq!(out.1, INLINE_SLOTS as u64, "only the inline part is taken");
    assert!(!out.0, "remainder refunded, not rested crossing");
    assert!(!touched.iter().any(|k| matches!(k, DataKey::LevelPage(..))));
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.head_seq, INLINE_SLOTS);
    assert_eq!(lvl.open_lots, 8);
    assert_eq!(h.client().best(&h.market, &false), Some(20));
    assert_eq!(h.client().best(&h.market, &true), None);
    // The next taker with a window picks up where the last one stopped.
    let filled = take_bid(&h, &taker, 20, 3, 2, &consume_win(&h, 20));
    assert_eq!(filled, 3);
    assert_eq!(h.client().level(&h.market, &false, &20).head_seq, 35);
}

#[test]
fn stale_page_slots_are_never_observable_after_sweep_reset() {
    // Invariant 9: fill 40 orders (8 of them in page 0), sweep the level
    // (generation bump, tail 0), rest 3 new orders inline. open_lots and the
    // settlement of the new orders ignore the old page contents.
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 1..=40u64 {
        rest_ask(&h, &maker, 20, 1, n);
    }
    let taker = Address::generate(&h.env);
    let filled = take_bid(&h, &taker, 20, 40, 1, &window(&h));
    assert_eq!(filled, 40, "a full sweep reads no slots");
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.tail_seq, 0);
    assert_eq!(lvl.open_lots, 0);
    assert!(
        has_page(&h, false, 20, 0),
        "the dirty page survives the sweep"
    );
    let g = lvl.generation;

    for n in 101..=103u64 {
        rest_ask(&h, &maker, 20, 2, n);
    }
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.generation, g);
    assert_eq!(lvl.tail_seq, 3);
    assert_eq!(lvl.open_lots, 6, "only the 3 new orders count");

    // Partial take of 5 with a window: seq 0 (2), seq 1 (2), seq 2 (1 of 2).
    let filled = take_bid(&h, &taker, 20, 5, 2, &consume_win(&h, 20));
    assert_eq!(filled, 5);
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.head_seq, 2);
    assert_eq!(lvl.head_consumed_lots, 1);
    assert_eq!(lvl.open_lots, 1);

    assert_eq!(h.client().settle(&maker, &h.market, &101), (40, 0));
    assert_eq!(h.client().settle(&maker, &h.market, &102), (40, 0));
    assert_eq!(h.client().settle(&maker, &h.market, &103), (20, 1));
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.open_lots, 0);
    assert_eq!(lvl.head_seq, 3);
    // Old-generation orders (including the ones that sat in page 0) still
    // settle as fully filled at the tick price.
    assert_eq!(h.client().settle(&maker, &h.market, &1), (20, 0));
    assert_eq!(h.client().settle(&maker, &h.market, &40), (20, 0));
    // A further take finds nothing: the stale page is behind head == tail.
    let filled = take_bid(&h, &taker, 20, 1, 3, &consume_win(&h, 20));
    assert_eq!(filled, 0);
}

#[test]
fn empty_level_reset_over_dirty_page_then_reuse() {
    // Rest 64 (cap), settle 63, take the last one (a sweep of open_lots = 1),
    // then rest again: the level resets and reuses seq 0; the old orders still
    // settle correctly.
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 1..=64u64 {
        rest_ask(&h, &maker, 20, 1, n);
    }
    for n in 1..=63u64 {
        assert_eq!(h.client().settle(&maker, &h.market, &n), (0, 1));
    }
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.open_lots, 1);
    assert_eq!(lvl.tail_seq, 64);
    let taker = Address::generate(&h.env);
    let filled = take_bid(&h, &taker, 20, 1, 1, &consume_win(&h, 20));
    assert_eq!(filled, 1);
    let g = h.client().level(&h.market, &false, &20).generation;
    rest_ask(&h, &maker, 20, 3, 200);
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.tail_seq, 1);
    assert_eq!(lvl.open_lots, 3);
    assert_eq!(lvl.generation, g);
    assert_eq!(h.client().order(&h.market, &maker, &200).seq, 0);
    assert_eq!(h.client().settle(&maker, &h.market, &64), (20, 0));
    assert_eq!(h.client().settle(&maker, &h.market, &200), (0, 3));
}

#[test]
fn replace_into_and_out_of_a_page() {
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 1..=INLINE_SLOTS as u64 {
        rest_ask(&h, &maker, 20, 1, n);
    }
    rest_ask(&h, &maker, 25, 4, 200);
    // Into page 0 (seq 32) at tick 20.
    let touched = keys_touched(&h, || {
        h.client()
            .replace(&maker, &h.market, &200, &false, &20, &4, &window(&h));
    });
    assert!(touched.contains(&DataKey::LevelPage(h.market, false, 20, 0)));
    let o = h.client().order(&h.market, &maker, &200);
    assert_eq!(o.tick, 20);
    assert_eq!(o.seq, INLINE_SLOTS);
    assert_eq!(h.client().level(&h.market, &false, &20).open_lots, 36);
    assert_eq!(h.client().level(&h.market, &false, &25).open_lots, 0);
    // Out of the page again: the slot is tombstoned in page 0.
    let touched = keys_touched(&h, || {
        h.client()
            .replace(&maker, &h.market, &200, &false, &25, &4, &window(&h));
    });
    assert!(touched.contains(&DataKey::LevelPage(h.market, false, 20, 0)));
    assert_eq!(h.client().level(&h.market, &false, &20).open_lots, 32);
    assert_eq!(h.client().level(&h.market, &false, &25).open_lots, 4);
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.tail_seq, 33, "the tombstone keeps its seq");
    // The remaining 32 lots are still takeable in FIFO order.
    let taker = Address::generate(&h.env);
    let filled = take_bid(&h, &taker, 20, 30, 1, &consume_win(&h, 20));
    assert_eq!(filled, 30);
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.head_seq, 30);
    assert_eq!(lvl.open_lots, 2);
}

/// §8: head advancement over tombstones is persisted even when the scan cap
/// ends the take before anything was consumed, so cleanup amortizes across
/// takers instead of repeating for each one.
#[test]
fn tombstone_cleanup_persists_when_nothing_was_taken() {
    use super::harness::{flags, mint, rest_ask, setup, window};
    use soroban_sdk::{testutils::Address as _, Address};
    let h = setup();
    // 20 tombstones ahead of one live order; scan cap 8 → the first taker only
    // skips 8 tombstones and takes nothing; its progress must persist.
    h.client()
        .set_market_caps(&h.market, &32, &8, &10, &1, &1_000_000, &1);
    let maker = Address::generate(&h.env);
    for n in 1..=22u64 {
        rest_ask(&h, &maker, 10, 1, n);
    }
    // tombstone seqs 19..1 (s > H), then settle the head (seq 0): head moves to
    // 1 and its eager advance skips 8 tombstones (the scan cap), stranding it at
    // 9. Two live orders remain (seqs 20, 21) so a 1-lot taker is a partial take
    // (a sweep would need no slot reads).
    for n in (2..=20u64).rev() {
        h.client().settle(&maker, &h.market, &n);
    }
    h.client().settle(&maker, &h.market, &1);
    assert_eq!(h.client().level(&h.market, &false, &10).head_seq, 9);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (_, filled, _) = h.client().place(
        &taker,
        &h.market,
        &true,
        &10,
        &1,
        &10,
        &1,
        &window(&h),
        &flags(),
    );
    assert_eq!(filled, 0, "8 more tombstones skipped, nothing taken");
    assert_eq!(
        h.client().level(&h.market, &false, &10).head_seq,
        17,
        "progress persisted although nothing was taken"
    );
    let (_, filled, _) = h.client().place(
        &taker,
        &h.market,
        &true,
        &10,
        &1,
        &10,
        &2,
        &window(&h),
        &flags(),
    );
    assert_eq!(
        filled, 1,
        "second taker skips the last 4 and reaches the live order"
    );
}
