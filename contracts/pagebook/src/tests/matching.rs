use super::harness::{flags, mint, rest_ask, setup, window};
use crate::{Error, PlaceFlags};
use soroban_sdk::{testutils::Address as _, Address};

#[test]
fn multi_level_take_sweeps_in_price_order() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 2, 1);
    rest_ask(&h, &maker, 12, 2, 2);
    rest_ask(&h, &maker, 14, 2, 3);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (rested, filled, quote) = h.client().place(
        &taker,
        &h.market,
        &true,
        &14,
        &5,
        &10,
        &1,
        &window(&h),
        &PlaceFlags {
            post_only: false,
            fill_or_kill: false,
            no_rest: true,
        },
    );
    assert!(!rested);
    assert_eq!(filled, 5);
    assert_eq!(quote, 20 + 24 + 14);
}

#[test]
fn quote_place_empty_side_uses_limit() {
    let h = setup();
    let q = h.client().quote_place(&h.market, &true, &50, &10);
    assert_eq!(q.start_tick, 50);
}

#[test]
fn quote_place_includes_own_side_level() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 2, 1);
    let q = h.client().quote_place(&h.market, &true, &20, &1);
    assert!(q
        .keys
        .iter()
        .any(|k| matches!(k.key, crate::DataKey::Level(_, true, 20))));
}

#[test]
fn start_tick_clamps_better_rest() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 12, 5, 1);
    rest_ask(&h, &maker, 8, 5, 2);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (_r, filled, quote) = h.client().place(
        &taker,
        &h.market,
        &true,
        &12,
        &5,
        &12,
        &1,
        &window(&h),
        &PlaceFlags {
            post_only: false,
            fill_or_kill: false,
            no_rest: true,
        },
    );
    assert_eq!(filled, 5);
    assert_eq!(quote, 60);
}

#[test]
fn fok_unfilled() {
    let h = setup();
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    super::assert_err(
        h.client().try_place(
            &taker,
            &h.market,
            &true,
            &10,
            &5,
            &10,
            &1,
            &window(&h),
            &PlaceFlags {
                post_only: false,
                fill_or_kill: true,
                no_rest: false,
            },
        ),
        Error::Unfilled,
    );
}

#[test]
fn reliquify_after_sweep() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 2, 1);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    h.client().place(
        &taker,
        &h.market,
        &true,
        &10,
        &2,
        &10,
        &1,
        &window(&h),
        &PlaceFlags {
            post_only: false,
            fill_or_kill: false,
            no_rest: true,
        },
    );
    rest_ask(&h, &maker, 10, 3, 2);
    let lvl = h.client().level(&h.market, &false, &10);
    assert_eq!(lvl.open_lots, 3);
    assert_eq!(h.client().best(&h.market, &false), Some(10));
}

#[test]
fn stale_start_still_rests_or_refunds() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 20, 1, 1);
    let q = h.client().quote_place(&h.market, &true, &30, &1);
    rest_ask(&h, &maker, 15, 1, 2);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (rested, filled, _) = h.client().place(
        &taker,
        &h.market,
        &true,
        &30,
        &1,
        &q.start_tick,
        &9,
        &window(&h),
        &flags(),
    );
    let _ = (rested, filled);
}

#[test]
fn paused_route_fails() {
    let h = setup();
    h.client().set_paused(&true);
    let taker = Address::generate(&h.env);
    let legs = soroban_sdk::Vec::new(&h.env);
    super::assert_err(h.client().try_route(&taker, &legs), Error::Paused);
}

#[test]
fn replace_batch_too_large() {
    let h = setup();
    let owner = Address::generate(&h.env);
    let mut items = soroban_sdk::Vec::new(&h.env);
    let dummy = crate::ReplaceItem {
        nonce: 0,
        is_bid: false,
        tick: 10,
        qty_lots: 1,
        window: window(&h),
    };
    for _ in 0..65 {
        items.push_back(dummy.clone());
    }
    super::assert_err(
        h.client().try_replace_batch(&owner, &h.market, &items),
        Error::BatchTooLarge,
    );
}
