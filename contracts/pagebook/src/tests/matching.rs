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
        .any(|k| matches!(k, crate::DataKey::Level(_, true, 20))));
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
fn better_priced_inflight_rest_blocks_crossing_rest() {
    // Simulate against ask 20, then an ask arrives at 15 (better than
    // start_tick). The walk never visits 15 (invariant 5) but the recorded best
    // moved to 15 and crosses limit 30, so the remainder is refunded (inv. 8),
    // never rested crossing, and BestTick(asks) is not touched by this walk.
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 20, 1, 1);
    let q = h.client().quote_place(&h.market, &true, &30, &5);
    assert_eq!(q.start_tick, 20);
    rest_ask(&h, &maker, 15, 1, 2);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (rested, filled, _) = h.client().place(
        &taker,
        &h.market,
        &true,
        &30,
        &5,
        &q.start_tick,
        &9,
        &window(&h),
        &flags(),
    );
    assert_eq!(filled, 1, "takes the level at start_tick");
    assert!(
        !rested,
        "book still crosses (ask 15 < 30): refund, never rest"
    );
    assert_eq!(h.client().best(&h.market, &false), Some(15));
    assert_eq!(h.client().level(&h.market, &false, &15).open_lots, 1);
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

#[test]
fn sweep_to_gap_then_rest_remainder() {
    // asks 2@10 and 2@20; bid limit 15 for 5: sweeps 10, next set tick 20 does
    // not cross, so the remainder rests at 15 and BestTick(asks) moves to 20.
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 2, 1);
    rest_ask(&h, &maker, 20, 2, 2);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (rested, filled, _q) = h.client().place(
        &taker,
        &h.market,
        &true,
        &15,
        &5,
        &10,
        &1,
        &window(&h),
        &flags(),
    );
    assert_eq!(filled, 2);
    assert!(rested, "remainder rests at 15");
    assert_eq!(h.client().best(&h.market, &false), Some(20));
    assert_eq!(h.client().best(&h.market, &true), Some(15));
}

#[test]
fn stale_best_after_cancel_does_not_block_rest_in_gap() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 2, 1);
    rest_ask(&h, &maker, 20, 2, 2);
    h.client().settle(&maker, &h.market, &1);
    assert_eq!(
        h.client().best(&h.market, &false),
        Some(10),
        "stale-better allowed"
    );
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (rested, filled, _) = h.client().place(
        &taker,
        &h.market,
        &true,
        &15,
        &5,
        &10,
        &1,
        &window(&h),
        &flags(),
    );
    assert_eq!(filled, 0);
    assert!(rested);
    assert_eq!(
        h.client().best(&h.market, &false),
        Some(20),
        "walk healed the stale best"
    );
}

#[test]
fn worse_start_tick_never_moves_best_tick() {
    // asks 5@100 and 5@180; a taker choosing start_tick 150 sweeps 180 but must
    // not move BestTick(asks) (100 is live and unvisited), and its remainder must
    // not rest crossing.
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 100, 5, 1);
    rest_ask(&h, &maker, 180, 5, 2);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 10_000_000);
    let (rested, filled, _) = h.client().place(
        &taker,
        &h.market,
        &true,
        &200,
        &7,
        &150,
        &1,
        &window(&h),
        &flags(),
    );
    assert_eq!(filled, 5);
    assert!(!rested, "recorded best 100 crosses 200: refund");
    assert_eq!(h.client().best(&h.market, &false), Some(100));
    // and the empty variant: only ask 100 live, start 150 finds nothing
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 100, 5, 1);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 10_000_000);
    let (rested, filled, _) = h.client().place(
        &taker,
        &h.market,
        &true,
        &200,
        &7,
        &150,
        &1,
        &window(&h),
        &flags(),
    );
    assert_eq!(filled, 0);
    assert!(!rested);
    assert_eq!(h.client().best(&h.market, &false), Some(100));
    let post_only = h.client().try_place(
        &taker,
        &h.market,
        &true,
        &120,
        &1,
        &120,
        &2,
        &window(&h),
        &PlaceFlags {
            post_only: true,
            fill_or_kill: false,
            no_rest: false,
        },
    );
    super::assert_err(post_only, Error::Crossed);
}

#[test]
fn remainder_below_min_is_refunded_not_reverted() {
    // min_order_lots = 10 (harness); ask 15@10; bid 20 crosses 15, remainder 5
    // < min: the take stands and the 5 is refunded.
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 15, 1);
    h.client()
        .set_market_caps(&h.market, &32, &64, &10, &10, &1_000_000, &1);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (rested, filled, _) = h.client().place(
        &taker,
        &h.market,
        &true,
        &10,
        &20,
        &10,
        &1,
        &window(&h),
        &flags(),
    );
    assert_eq!(filled, 15);
    assert!(!rested, "5-lot remainder is below min_order_lots: refunded");
}

#[test]
fn route_two_legs_shares_budget_and_nets() {
    // Two legs on the same market: both succeed under one auth; the second leg
    // sees the budget the first leg left.
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 2, 1);
    rest_ask(&h, &maker, 12, 2, 2);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let leg = |limit: u32, qty: u64, nonce: u64| crate::PlaceLeg {
        market: h.market,
        is_bid: true,
        limit_tick: limit,
        qty_lots: qty,
        start_tick: 10,
        nonce,
        window: window(&h),
        flags: PlaceFlags {
            post_only: false,
            fill_or_kill: false,
            no_rest: true,
        },
    };
    let mut legs = soroban_sdk::Vec::new(&h.env);
    legs.push_back(leg(10, 2, 1));
    legs.push_back(leg(12, 2, 2));
    let out = h.client().route(&taker, &legs);
    assert_eq!(out.len(), 2);
    assert_eq!(out.get(0).unwrap().1, 2);
    assert_eq!(out.get(1).unwrap().1, 2);
    assert_eq!(h.client().level(&h.market, &false, &12).open_lots, 0);
}

#[test]
fn route_shared_levels_budget_caps_second_leg() {
    let h = setup();
    h.client()
        .set_market_caps(&h.market, &2, &64, &10, &1, &1_000_000, &1);
    let maker = Address::generate(&h.env);
    for (i, t) in [10u32, 11, 12, 13].iter().enumerate() {
        rest_ask(&h, &maker, *t, 1, i as u64 + 1);
    }
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let leg = |limit: u32, qty: u64, nonce: u64| crate::PlaceLeg {
        market: h.market,
        is_bid: true,
        limit_tick: limit,
        qty_lots: qty,
        start_tick: 10,
        nonce,
        window: window(&h),
        flags: PlaceFlags {
            post_only: false,
            fill_or_kill: false,
            no_rest: true,
        },
    };
    let mut legs = soroban_sdk::Vec::new(&h.env);
    legs.push_back(leg(13, 2, 1)); // uses the whole budget of 2 levels
    legs.push_back(leg(13, 2, 2)); // no budget left: takes nothing
    let out = h.client().route(&taker, &legs);
    assert_eq!(out.get(0).unwrap().1, 2);
    assert_eq!(out.get(1).unwrap().1, 0);
}

#[test]
fn replace_batch_two_items_succeeds() {
    let h = setup();
    let owner = Address::generate(&h.env);
    rest_ask(&h, &owner, 10, 2, 1);
    rest_ask(&h, &owner, 12, 2, 2);
    let mut items = soroban_sdk::Vec::new(&h.env);
    for (nonce, tick) in [(1u64, 11u32), (2, 13)] {
        items.push_back(crate::ReplaceItem {
            nonce,
            is_bid: false,
            tick,
            qty_lots: 2,
            window: window(&h),
        });
    }
    let out = h.client().replace_batch(&owner, &h.market, &items);
    assert_eq!(out.len(), 2);
    assert_eq!(h.client().level(&h.market, &false, &11).open_lots, 2);
    assert_eq!(h.client().level(&h.market, &false, &13).open_lots, 2);
    assert_eq!(h.client().level(&h.market, &false, &10).open_lots, 0);
}

#[test]
fn walk_never_reads_word_past_limit() {
    // ask 2@50 (word 0) and 1@5000 (word 2); bid limit 100 qty 5 sweeps 50 and
    // must not touch TickWord(asks, 2). Checked via the recorded footprint.
    let mut h = setup();
    // a wider band so tick 5000 (word 2) exists
    h.market = h
        .client()
        .create_market(&h.base, &h.quote, &1, &1, &1, &10_000, &10, &1, &1_000_000);
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 50, 2, 1);
    rest_ask(&h, &maker, 5000, 1, 2);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let touched = super::footprint::keys_touched(&h, || {
        h.client().place(
            &taker,
            &h.market,
            &true,
            &100,
            &5,
            &50,
            &1,
            &window(&h),
            &flags(),
        );
    });
    assert!(!touched.contains(&crate::DataKey::TickWord(h.market, false, 2)));
    assert!(touched.contains(&crate::DataKey::TickWord(h.market, false, 0)));
    // BestTick(asks) stays on the swept tick (stale-better), the remainder rests at 100
    assert_eq!(h.client().best(&h.market, &false), Some(50));
    assert_eq!(h.client().best(&h.market, &true), Some(100));
}
