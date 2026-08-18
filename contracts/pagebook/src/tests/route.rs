//! `route` across two markets with in-memory netting (architecture §8) and
//! the all-or-nothing rule for `route` and `replace_batch` (§10).

extern crate std;

use super::harness::{flags, mint, rest_ask, rest_bid, setup, window, Harness};
use crate::{Error, PlaceFlags, PlaceLeg, ReplaceItem};
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    token::TokenClient,
    xdr::{ContractEventBody, ScSymbol, ScVal, StringM},
    Address,
};

fn no_rest() -> PlaceFlags {
    PlaceFlags {
        post_only: false,
        fill_or_kill: false,
        no_rest: true,
    }
}

fn fok() -> PlaceFlags {
    PlaceFlags {
        post_only: false,
        fill_or_kill: true,
        no_rest: false,
    }
}

/// Number of SAC `transfer` events emitted by `token` in the last invocation.
fn transfer_events(h: &Harness, token: &Address) -> usize {
    let sym = ScVal::Symbol(ScSymbol(StringM::try_from("transfer").unwrap()));
    h.env
        .events()
        .all()
        .filter_by_contract(token)
        .events()
        .iter()
        .filter(|e| {
            let ContractEventBody::V0(v0) = &e.body;
            v0.topics.first() == Some(&sym)
        })
        .count()
}

fn bal(h: &Harness, token: &Address, who: &Address) -> i128 {
    TokenClient::new(&h.env, token).balance(who)
}

/// A second market on the same pair (lot 1, tick 1, band [1, 1000)).
fn second_market(h: &Harness) -> u32 {
    h.client()
        .create_market(&h.base, &h.quote, &1, &1, &1, &1000, &10, &1, &1_000_000)
}

fn rest_ask_in(h: &Harness, market: u32, maker: &Address, tick: u32, qty: u64, nonce: u64) {
    mint(h, &h.base, maker, 1_000_000);
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

fn leg(h: &Harness, market: u32, limit: u32, qty: u64, nonce: u64, f: PlaceFlags) -> PlaceLeg {
    PlaceLeg {
        market,
        is_bid: true,
        limit_tick: limit,
        qty_lots: qty,
        start_tick: limit,
        nonce,
        window: window(h),
        flags: f,
    }
}

#[test]
fn route_two_markets_nets_to_one_transfer_per_token() {
    let h = setup();
    let m2 = second_market(&h);
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 4, 1);
    rest_ask_in(&h, m2, &maker, 12, 6, 2);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let q0 = bal(&h, &h.quote, &taker);
    let b0 = bal(&h, &h.base, &taker);
    let vq0 = bal(&h, &h.quote, &h.id);
    let vb0 = bal(&h, &h.base, &h.id);

    let mut legs = soroban_sdk::Vec::new(&h.env);
    legs.push_back(leg(&h, h.market, 10, 4, 1, no_rest()));
    legs.push_back(leg(&h, m2, 12, 6, 2, no_rest()));
    let out = h.client().route(&taker, &legs);
    assert_eq!(out.get(0).unwrap(), (false, 4, 40));
    assert_eq!(out.get(1).unwrap(), (false, 6, 72));

    // One transfer per token, both legs netted.
    assert_eq!(
        transfer_events(&h, &h.quote),
        1,
        "quote: one netted transfer"
    );
    assert_eq!(transfer_events(&h, &h.base), 1, "base: one netted transfer");
    // Taker paid 40 + 72 quote and received 10 base minus the fee on each
    // leg (ceil(4 × 10 bps) = 1, ceil(6 × 10 bps) = 1).
    assert_eq!(q0 - bal(&h, &h.quote, &taker), 112);
    assert_eq!(bal(&h, &h.base, &taker) - b0, 10 - 2);
    assert_eq!(bal(&h, &h.quote, &h.id) - vq0, 112);
    assert_eq!(vb0 - bal(&h, &h.base, &h.id), 8);
    assert_eq!(h.client().collect_fees(&h.market, &h.base), 1);
    assert_eq!(h.client().collect_fees(&m2, &h.base), 1);
}

#[test]
fn route_failing_second_leg_reverts_the_first() {
    let h = setup();
    let m2 = second_market(&h);
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 4, 1);
    // No liquidity in m2: a fill-or-kill leg there fails Unfilled.
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let q0 = bal(&h, &h.quote, &taker);
    let b0 = bal(&h, &h.base, &taker);
    let vq0 = bal(&h, &h.quote, &h.id);
    let vb0 = bal(&h, &h.base, &h.id);

    let mut legs = soroban_sdk::Vec::new(&h.env);
    legs.push_back(leg(&h, h.market, 10, 4, 1, no_rest()));
    legs.push_back(leg(&h, m2, 12, 6, 2, fok()));
    super::assert_err(h.client().try_route(&taker, &legs), Error::Unfilled);

    assert_eq!(bal(&h, &h.quote, &taker), q0);
    assert_eq!(bal(&h, &h.base, &taker), b0);
    assert_eq!(bal(&h, &h.quote, &h.id), vq0);
    assert_eq!(bal(&h, &h.base, &h.id), vb0);
    // The first leg's take was rolled back with it.
    assert_eq!(h.client().level(&h.market, &false, &10).open_lots, 4);
    assert_eq!(h.client().best(&h.market, &false), Some(10));
    assert!(h.client().try_order(&h.market, &taker, &1).is_err());
    assert_eq!(h.client().collect_fees(&h.market, &h.base), 0);
}

#[test]
fn replace_batch_third_item_crossed_reverts_all() {
    let h = setup();
    let owner = Address::generate(&h.env);
    rest_ask(&h, &owner, 10, 2, 1);
    rest_ask(&h, &owner, 12, 2, 2);
    rest_ask(&h, &owner, 14, 2, 3);
    let bidder = Address::generate(&h.env);
    rest_bid(&h, &bidder, 5, 1, 1);
    let ob0 = bal(&h, &h.base, &owner);
    let vb0 = bal(&h, &h.base, &h.id);

    let mut items = soroban_sdk::Vec::new(&h.env);
    for (nonce, tick) in [(1u64, 11u32), (2, 13), (3, 5)] {
        items.push_back(ReplaceItem {
            nonce,
            is_bid: false,
            tick,
            qty_lots: 3,
            window: window(&h),
        });
    }
    super::assert_err(
        h.client().try_replace_batch(&owner, &h.market, &items),
        Error::Crossed,
    );
    for t in [10u32, 12, 14] {
        assert_eq!(
            h.client().level(&h.market, &false, &t).open_lots,
            2,
            "tick {t}"
        );
    }
    for t in [11u32, 13, 5] {
        assert_eq!(
            h.client().level(&h.market, &false, &t).open_lots,
            0,
            "tick {t}"
        );
    }
    for (nonce, tick) in [(1u64, 10u32), (2, 12), (3, 14)] {
        let o = h.client().order(&h.market, &owner, &nonce);
        assert_eq!(o.tick, tick);
        assert_eq!(o.qty_lots, 2);
    }
    assert_eq!(bal(&h, &h.base, &owner), ob0);
    assert_eq!(bal(&h, &h.base, &h.id), vb0);
    assert_eq!(h.client().best(&h.market, &false), Some(10));
    assert_eq!(h.client().best(&h.market, &true), Some(5));
    // Without the crossing item the same batch lands, netted into one base
    // transfer (3 × (3 − 2) = 3 lots more escrow).
    let mut ok = soroban_sdk::Vec::new(&h.env);
    for (nonce, tick) in [(1u64, 11u32), (2, 13), (3, 15)] {
        ok.push_back(ReplaceItem {
            nonce,
            is_bid: false,
            tick,
            qty_lots: 3,
            window: window(&h),
        });
    }
    h.client().replace_batch(&owner, &h.market, &ok);
    assert_eq!(transfer_events(&h, &h.base), 1);
    assert_eq!(transfer_events(&h, &h.quote), 0);
    assert_eq!(ob0 - bal(&h, &h.base, &owner), 3);
}
