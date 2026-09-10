//! Queue depth (architecture §2, ADR-037): one `Level` entry holds every slot of
//! the generation. Depth past 32, `LevelFull` at `level_cap`, tombstones and
//! settles deep in the queue, a sweep emptying the vector, reset-on-rest at
//! depth, replace into and out of a deep level, head-slot decrement on a
//! partial take, and a raised `level_cap`.

extern crate std;

use super::footprint::keys_touched;
use super::harness::{flags, mint, no_rest, rest_ask, setup, Harness};
use crate::{DataKey, Error};
use pagebook_types::{Level, LEVEL_CAP, LEVEL_CAP_MAX};
use soroban_sdk::{testutils::Address as _, Address};

fn take_bid(h: &Harness, taker: &Address, limit: u32, qty: u64, nonce: u64) -> u64 {
    mint(h, &h.quote, taker, 1_000_000);
    let (_, filled, _) = h.client().place(
        taker,
        &h.market,
        &true,
        &limit,
        &qty,
        &limit,
        &nonce,
        &no_rest(),
    );
    filled
}

fn raw_level(h: &Harness, is_bid: bool, tick: u32) -> Level {
    super::harness::raw_level(h, is_bid, tick).expect("Level entry")
}

#[test]
fn the_vector_is_the_queue() {
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 1..=3u64 {
        rest_ask(&h, &maker, 20, 1, n);
    }
    assert_eq!(raw_level(&h, false, 20).tail(), 3);
    assert_eq!(h.client().level(&h.market, &false, &20).depth, 3);

    // Past 32 the same entry keeps growing: no second key is touched.
    for n in 4..=40u64 {
        rest_ask(&h, &maker, 20, 1, n);
    }
    let touched = keys_touched(&h, || rest_ask(&h, &maker, 20, 1, 41));
    assert!(touched
        .iter()
        .all(|k| !matches!(k, DataKey::Level(_, _, t) if *t != 20)));
    assert_eq!(raw_level(&h, false, 20).tail(), 41);
    assert_eq!(h.client().order(&h.market, &maker, &41).seq, 40);

    // A mid-queue cancel tombstones in place: the tail does not move.
    h.client().settle(&maker, &h.market, &36);
    let lvl = raw_level(&h, false, 20);
    assert_eq!(lvl.tail(), 41);
    assert_eq!(lvl.slot(35), 0);
    assert_eq!(lvl.open_lots, 40);

    // A sweep empties the vector.
    let taker = Address::generate(&h.env);
    assert_eq!(take_bid(&h, &taker, 20, 40, 1), 40);
    let lvl = raw_level(&h, false, 20);
    assert_eq!(lvl.tail(), 0);
    assert_eq!(lvl.open_lots, 0);
    assert_eq!(lvl.head_seq, 0);
}

#[test]
fn rest_past_level_cap_is_level_full() {
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 1..=u64::from(LEVEL_CAP) {
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
            &(u64::from(LEVEL_CAP) + 1),
            &flags(),
        ),
        Error::LevelFull,
    );
    assert_eq!(h.client().level(&h.market, &false, &20).depth, LEVEL_CAP);
}

/// `level_cap` is a market parameter: raised to `LEVEL_CAP_MAX`, the same
/// level takes 128 orders and fails at the 129th.
#[test]
fn raised_level_cap_allows_a_deeper_queue() {
    let h = setup();
    h.client()
        .set_market_caps(&h.market, &32, &10, &1, &1_000_000, &LEVEL_CAP_MAX);
    let maker = Address::generate(&h.env);
    for n in 1..=u64::from(LEVEL_CAP_MAX) {
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
            &(u64::from(LEVEL_CAP_MAX) + 1),
            &flags(),
        ),
        Error::LevelFull,
    );
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.depth, LEVEL_CAP_MAX);
    assert_eq!(lvl.open_lots, u64::from(LEVEL_CAP_MAX));
    // The deep queue is still FIFO end to end; a 100-lot take on a 128-deep
    // level takes 100 in one call.
    let taker = Address::generate(&h.env);
    assert_eq!(take_bid(&h, &taker, 20, 100, 1), 100);
    assert_eq!(h.client().level(&h.market, &false, &20).head_seq, 100);
    assert_eq!(h.client().settle(&maker, &h.market, &1), (20, 0));
    assert_eq!(h.client().settle(&maker, &h.market, &101), (0, 1));
}

/// A partial take decrements the head slot in place (§2, ADR-037): the slot
/// holds the order's open lots, the `order` view and settle read it, and the
/// head advances the moment it reaches zero.
#[test]
fn partial_take_decrements_the_head_slot() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 20, 5, 1);
    rest_ask(&h, &maker, 20, 4, 2);
    let taker = Address::generate(&h.env);
    assert_eq!(take_bid(&h, &taker, 20, 2, 1), 2);
    let lvl = raw_level(&h, false, 20);
    assert_eq!(lvl.head_seq, 0);
    assert_eq!(lvl.slot(0), 3);
    assert_eq!(lvl.slot(1), 4);
    assert_eq!(lvl.open_lots, 7);
    let o = h.client().order(&h.market, &maker, &1);
    assert_eq!((o.filled_lots, o.refund_lots), (2, 3));
    // Consuming the rest of the head advances it eagerly.
    assert_eq!(take_bid(&h, &taker, 20, 3, 2), 3);
    let lvl = raw_level(&h, false, 20);
    assert_eq!(lvl.head_seq, 1);
    assert_eq!(lvl.open_lots, 4);
    assert_eq!(h.client().settle(&maker, &h.market, &1), (100, 0));
    // Settling a partially filled head refunds its slot and moves the head on.
    assert_eq!(take_bid(&h, &taker, 20, 1, 3), 1);
    assert_eq!(h.client().settle(&maker, &h.market, &2), (20, 3));
    let lvl = raw_level(&h, false, 20);
    assert_eq!(lvl.head_seq, 2);
    assert_eq!(lvl.open_lots, 0);
}

#[test]
fn settle_deep_in_queue_tombstones_and_take_skips_it() {
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 1..=40u64 {
        rest_ask(&h, &maker, 20, 1, n);
    }
    assert_eq!(h.client().order(&h.market, &maker, &35).seq, 34);
    assert_eq!(h.client().settle(&maker, &h.market, &35), (0, 1));
    assert_eq!(h.client().level(&h.market, &false, &20).open_lots, 39);
    // A partial take of 38 walks the head through the tombstone: 39 slots
    // scanned, head lands on seq 39.
    let taker = Address::generate(&h.env);
    assert_eq!(take_bid(&h, &taker, 20, 38, 1), 38);
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.head_seq, 39);
    assert_eq!(lvl.open_lots, 1);
    assert_eq!(h.client().settle(&maker, &h.market, &40), (0, 1));
    assert_eq!(h.client().settle(&maker, &h.market, &1), (20, 0));
}

/// A sweep starts a new generation with an empty vector; orders of the swept
/// generation settle as filled, the new ones from their own slots.
#[test]
fn sweep_then_reuse_settles_both_generations() {
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 1..=40u64 {
        rest_ask(&h, &maker, 20, 1, n);
    }
    let taker = Address::generate(&h.env);
    assert_eq!(
        take_bid(&h, &taker, 20, 40, 1),
        40,
        "a sweep reads no slots"
    );
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.depth, 0);
    assert_eq!(lvl.open_lots, 0);
    let g = lvl.generation;

    for n in 101..=103u64 {
        rest_ask(&h, &maker, 20, 2, n);
    }
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.generation, g);
    assert_eq!(lvl.depth, 3);
    assert_eq!(lvl.open_lots, 6);

    // Partial take of 5: seq 0 (2), seq 1 (2), seq 2 (1 of 2).
    assert_eq!(take_bid(&h, &taker, 20, 5, 2), 5);
    let lvl = raw_level(&h, false, 20);
    assert_eq!(lvl.head_seq, 2);
    assert_eq!(lvl.slot(2), 1);
    assert_eq!(lvl.open_lots, 1);

    assert_eq!(h.client().settle(&maker, &h.market, &101), (40, 0));
    assert_eq!(h.client().settle(&maker, &h.market, &102), (40, 0));
    assert_eq!(h.client().settle(&maker, &h.market, &103), (20, 1));
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.open_lots, 0);
    assert_eq!(lvl.head_seq, 3);
    assert_eq!(h.client().settle(&maker, &h.market, &1), (20, 0));
    assert_eq!(h.client().settle(&maker, &h.market, &40), (20, 0));
    assert_eq!(take_bid(&h, &taker, 20, 1, 3), 0);
}

#[test]
fn empty_level_reset_at_cap_then_reuse() {
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
    assert_eq!(lvl.depth, 64);
    let taker = Address::generate(&h.env);
    assert_eq!(take_bid(&h, &taker, 20, 1, 1), 1);
    let g = h.client().level(&h.market, &false, &20).generation;
    rest_ask(&h, &maker, 20, 3, 200);
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.depth, 1);
    assert_eq!(lvl.open_lots, 3);
    assert_eq!(lvl.generation, g);
    assert_eq!(h.client().order(&h.market, &maker, &200).seq, 0);
    assert_eq!(h.client().settle(&maker, &h.market, &64), (20, 0));
    assert_eq!(h.client().settle(&maker, &h.market, &200), (0, 3));
}

#[test]
fn replace_into_and_out_of_a_deep_level() {
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 1..=32u64 {
        rest_ask(&h, &maker, 20, 1, n);
    }
    rest_ask(&h, &maker, 25, 4, 200);
    h.client().replace(&maker, &h.market, &200, &false, &20, &4);
    let o = h.client().order(&h.market, &maker, &200);
    assert_eq!(o.tick, 20);
    assert_eq!(o.seq, 32);
    assert_eq!(h.client().level(&h.market, &false, &20).open_lots, 36);
    assert_eq!(h.client().level(&h.market, &false, &25).open_lots, 0);
    // Out again: the slot is tombstoned, the tail keeps its seq.
    h.client().replace(&maker, &h.market, &200, &false, &25, &4);
    assert_eq!(h.client().level(&h.market, &false, &20).open_lots, 32);
    assert_eq!(h.client().level(&h.market, &false, &25).open_lots, 4);
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.depth, 33);
    let taker = Address::generate(&h.env);
    assert_eq!(take_bid(&h, &taker, 20, 30, 1), 30);
    let lvl = h.client().level(&h.market, &false, &20);
    assert_eq!(lvl.head_seq, 30);
    assert_eq!(lvl.open_lots, 2);
}

/// Settling the head advances past the whole tombstone run to the next live
/// slot in one call.
#[test]
fn settle_head_advances_past_the_whole_tombstone_run() {
    let h = setup();
    h.client()
        .set_market_caps(&h.market, &32, &10, &1, &1_000_000, &LEVEL_CAP_MAX);
    let maker = Address::generate(&h.env);
    for n in 1..=80u64 {
        rest_ask(&h, &maker, 10, 1, n);
    }
    // Tombstone seqs 1..=70; head is seq 0. Settling the head skips the whole
    // run and lands on seq 71 (order 72).
    for n in (2..=71u64).rev() {
        h.client().settle(&maker, &h.market, &n);
    }
    h.client().settle(&maker, &h.market, &1);
    assert_eq!(h.client().level(&h.market, &false, &10).head_seq, 71);
    assert_eq!(h.client().level(&h.market, &false, &10).open_lots, 9);
}

/// A taker at a level whose head sits on a long tombstone run (longer than 64)
/// reaches the live order and takes it in one call.
#[test]
fn taker_skips_a_long_tombstone_run_in_one_call() {
    let h = setup();
    h.client()
        .set_market_caps(&h.market, &32, &10, &1, &1_000_000, &LEVEL_CAP_MAX);
    let maker = Address::generate(&h.env);
    for n in 1..=80u64 {
        rest_ask(&h, &maker, 10, 1, n);
    }
    // Tombstone seqs 1..=70. A 1-lot take consumes seq 0 and leaves the head
    // on seq 1 (a zero); the next take skips 70 zeros and fills seq 71.
    for n in (2..=71u64).rev() {
        h.client().settle(&maker, &h.market, &n);
    }
    let taker = Address::generate(&h.env);
    assert_eq!(take_bid(&h, &taker, 10, 1, 1), 1);
    assert_eq!(h.client().level(&h.market, &false, &10).head_seq, 1);
    assert_eq!(take_bid(&h, &taker, 10, 1, 2), 1);
    assert_eq!(h.client().level(&h.market, &false, &10).head_seq, 72);
    assert_eq!(h.client().level(&h.market, &false, &10).open_lots, 8);
}
