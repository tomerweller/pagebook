//! Re-liquification (architecture §5/§9, 05 M2): a swept or lazily-cleared
//! tick becomes live again, the empty-side rest at a tick worse than a stale
//! recorded best, and post-only's conservative check against a stale best.

use super::harness::{mint, rest_ask, setup, window};
use crate::{DataKey, Error, PlaceFlags};
use pagebook_types::{bit_in_word, word_of, TickBitmap, TICK_BITMAP_BYTES};
use soroban_sdk::{testutils::Address as _, Address, Bytes};

fn no_rest() -> PlaceFlags {
    PlaceFlags {
        post_only: false,
        fill_or_kill: false,
        no_rest: true,
    }
}

fn post_only() -> PlaceFlags {
    PlaceFlags {
        post_only: true,
        fill_or_kill: false,
        no_rest: false,
    }
}

/// Reads the bit for `tick` straight out of the stored `TickWord`.
fn bit_set(h: &super::harness::Harness, is_bid: bool, tick: u32) -> bool {
    let key = DataKey::TickWord(h.market, is_bid, word_of(tick));
    let bytes: Option<Bytes> = h
        .env
        .as_contract(&h.id, || h.env.storage().persistent().get(&key));
    match bytes {
        None => false,
        Some(b) => {
            assert_eq!(b.len() as usize, TICK_BITMAP_BYTES);
            let mut raw = [0u8; TICK_BITMAP_BYTES];
            b.copy_into_slice(&mut raw);
            TickBitmap::decode(&raw)
                .expect("stored TickWord decodes")
                .get(bit_in_word(tick))
        }
    }
}

#[test]
fn lazy_clear_then_re_rest_same_tick() {
    // asks 2@20 and 2@30; settling the 20 leaves a stale bit. A bid limit 25
    // clears it lazily (BestTick(asks) → 30); a fresh ask at 20 sets the bit
    // again and BestTick returns to 20.
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 20, 2, 1);
    rest_ask(&h, &maker, 30, 2, 2);
    h.client().settle(&maker, &h.market, &1);
    assert!(bit_set(&h, false, 20), "cancel-to-empty leaves the bit set");
    assert_eq!(h.client().best(&h.market, &false), Some(20));

    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (rested, filled, _) = h.client().place(
        &taker,
        &h.market,
        &true,
        &25,
        &1,
        &20,
        &1,
        &window(&h),
        &no_rest(),
    );
    assert!(!rested);
    assert_eq!(filled, 0);
    assert!(!bit_set(&h, false, 20), "the walk cleared the stale bit");
    assert!(bit_set(&h, false, 30));
    assert_eq!(h.client().best(&h.market, &false), Some(30));

    rest_ask(&h, &maker, 20, 3, 3);
    assert!(bit_set(&h, false, 20), "re-rest sets the bit again");
    assert_eq!(h.client().best(&h.market, &false), Some(20));
    assert_eq!(h.client().level(&h.market, &false, &20).open_lots, 3);
    // And it is takeable: a bid limit 30 from 20 sweeps 20, then finds 30
    // through the bitmap.
    let (_, filled, quote) = h.client().place(
        &taker,
        &h.market,
        &true,
        &30,
        &5,
        &20,
        &2,
        &window(&h),
        &no_rest(),
    );
    assert_eq!(filled, 5);
    assert_eq!(quote, 60 + 60);
}

#[test]
fn empty_side_rest_worse_than_stale_best_is_found_by_the_next_walk() {
    // ask 2@20 fully swept in a one-word band: the bounded scan after the last
    // sweep reaches the band's last word and finds nothing, so the side is
    // marked empty (ADR-020). A rest at 30 then takes BestTick, and a taker
    // walking from 20 (a stale start_tick) still finds and takes it.
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 20, 2, 1);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (_, filled, _) = h.client().place(
        &taker,
        &h.market,
        &true,
        &20,
        &2,
        &20,
        &1,
        &window(&h),
        &no_rest(),
    );
    assert_eq!(filled, 2);
    assert_eq!(
        h.client().best(&h.market, &false),
        None,
        "exhaustive scan: empty"
    );
    assert!(!bit_set(&h, false, 20));
    assert_eq!(h.client().level(&h.market, &false, &20).open_lots, 0);

    rest_ask(&h, &maker, 30, 2, 2);
    assert!(bit_set(&h, false, 30));
    assert_eq!(
        h.client().best(&h.market, &false),
        Some(30),
        "empty side takes the rest"
    );

    let (rested, filled, quote) = h.client().place(
        &taker,
        &h.market,
        &true,
        &30,
        &2,
        &20,
        &2,
        &window(&h),
        &no_rest(),
    );
    assert!(!rested);
    assert_eq!(filled, 2);
    assert_eq!(quote, 60);
    assert_eq!(
        h.client().best(&h.market, &false),
        None,
        "swept, band exhausted"
    );
    assert!(!bit_set(&h, false, 30), "swept: bit cleared");
}

#[test]
fn post_only_false_reject_on_stale_best_then_success_after_heal() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 20, 2, 1);
    h.client().settle(&maker, &h.market, &1);
    assert_eq!(h.client().best(&h.market, &false), Some(20), "stale");
    let bidder = Address::generate(&h.env);
    mint(&h, &h.quote, &bidder, 1_000_000);
    // Documented behaviour (§9): post-only compares against the recorded best
    // as stored, so a bid at 20 is rejected even though nothing is live there.
    super::assert_err(
        h.client().try_place(
            &bidder,
            &h.market,
            &true,
            &20,
            &1,
            &20,
            &1,
            &window(&h),
            &post_only(),
        ),
        Error::Crossed,
    );
    // A bid strictly below the stale best is fine.
    let (rested, _, _) = h.client().place(
        &bidder,
        &h.market,
        &true,
        &19,
        &1,
        &19,
        &2,
        &window(&h),
        &post_only(),
    );
    assert!(rested);
    h.client().settle(&bidder, &h.market, &2);
    // A taker walks through the stale level and heals BestTick(asks) → empty.
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (rested, filled, _) = h.client().place(
        &taker,
        &h.market,
        &true,
        &25,
        &1,
        &20,
        &1,
        &window(&h),
        &no_rest(),
    );
    assert!(!rested);
    assert_eq!(filled, 0);
    assert_eq!(h.client().best(&h.market, &false), None);
    // Post-only at 20 now succeeds.
    let (rested, filled, _) = h.client().place(
        &bidder,
        &h.market,
        &true,
        &20,
        &1,
        &20,
        &3,
        &window(&h),
        &post_only(),
    );
    assert!(rested);
    assert_eq!(filled, 0);
    assert_eq!(h.client().best(&h.market, &true), Some(20));
    // A crossing post-only against a LIVE best still fails.
    rest_ask(&h, &maker, 30, 1, 2);
    super::assert_err(
        h.client().try_place(
            &bidder,
            &h.market,
            &true,
            &30,
            &1,
            &30,
            &4,
            &window(&h),
            &post_only(),
        ),
        Error::Crossed,
    );
}
