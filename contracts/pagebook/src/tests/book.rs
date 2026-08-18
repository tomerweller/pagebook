use super::harness::{flags, mint, rest_ask, rest_bid, setup, window};
use crate::{Error, PlaceFlags};
use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _},
    token::TokenClient,
    Address,
};

#[test]
fn rest_and_settle_open_refunds() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 5, 1);
    let before = TokenClient::new(&h.env, &h.base).balance(&maker);
    let (paid, refunded) = h.client().settle(&maker, &h.market, &1);
    assert_eq!(paid, 0);
    assert_eq!(refunded, 5);
    let after = TokenClient::new(&h.env, &h.base).balance(&maker);
    assert_eq!(after - before, 5);
    assert!(h.client().try_order(&h.market, &maker, &1).is_err());
}

#[test]
fn nonce_exists_then_reuse_after_settle() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 5, 7);
    super::assert_err(
        h.client().try_place(
            &maker,
            &h.market,
            &false,
            &11,
            &5,
            &11,
            &7,
            &window(&h),
            &flags(),
        ),
        Error::OrderExists,
    );
    h.client().settle(&maker, &h.market, &7);
    rest_ask(&h, &maker, 12, 5, 7);
    let info = h.client().order(&h.market, &maker, &7);
    assert_eq!(info.tick, 12);
}

#[test]
fn empty_level_reset_reuses_seqs() {
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 0..64u64 {
        rest_ask(&h, &maker, 20, 1, n);
        h.client().settle(&maker, &h.market, &n);
    }
    let err = h.client().try_place(
        &maker,
        &h.market,
        &false,
        &20,
        &1,
        &20,
        &200,
        &window(&h),
        &flags(),
    );
    assert!(err.is_ok());
    let lvl = h.client().level(&h.market, &false, &20);
    assert!(lvl.generation >= 1);
    assert_eq!(lvl.tail_seq, 1);
}

#[test]
fn replace_reuses_order_entry() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 5, 1);
    let before = h
        .env
        .as_contract(&h.id, || h.env.storage().persistent().all().len());
    h.client()
        .replace(&maker, &h.market, &1, &false, &10, &8, &window(&h));
    let after = h
        .env
        .as_contract(&h.id, || h.env.storage().persistent().all().len());
    assert_eq!(before, after);
    let info = h.client().order(&h.market, &maker, &1);
    assert_eq!(info.tick, 10);
    assert_eq!(info.qty_lots, 8);
}

#[test]
fn take_then_settle_pays_maker() {
    let h = setup();
    let maker = Address::generate(&h.env);
    let taker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 10, 1);
    mint(&h, &h.quote, &taker, 1_000_000);
    let (rested, filled, quote) = h.client().place(
        &taker,
        &h.market,
        &true,
        &10,
        &4,
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
    assert_eq!(filled, 4);
    assert_eq!(quote, 40);
    let (paid, refunded) = h.client().settle(&maker, &h.market, &1);
    assert_eq!(paid, 40);
    assert_eq!(refunded, 6);
}

#[test]
fn settle_then_sweep_drops_open_lots() {
    let h = setup();
    let maker = Address::generate(&h.env);
    let taker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 10, 1);
    mint(&h, &h.quote, &taker, 1_000_000);
    h.client().place(
        &taker,
        &h.market,
        &true,
        &10,
        &3,
        &10,
        &1,
        &window(&h),
        &PlaceFlags {
            post_only: false,
            fill_or_kill: false,
            no_rest: true,
        },
    );
    h.client().settle(&maker, &h.market, &1);
    let lvl = h.client().level(&h.market, &false, &10);
    assert_eq!(lvl.open_lots, 0);
}

#[test]
fn paused_blocks_place_not_settle() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 5, 1);
    h.client().set_paused(&true);
    super::assert_err(
        h.client().try_place(
            &maker,
            &h.market,
            &false,
            &11,
            &5,
            &11,
            &2,
            &window(&h),
            &flags(),
        ),
        Error::Paused,
    );
    let (paid, refunded) = h.client().settle(&maker, &h.market, &1);
    assert_eq!(paid, 0);
    assert_eq!(refunded, 5);
}

#[test]
fn post_only_rejects_cross() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 5, 1);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    super::assert_err(
        h.client().try_place(
            &taker,
            &h.market,
            &true,
            &10,
            &1,
            &10,
            &1,
            &window(&h),
            &PlaceFlags {
                post_only: true,
                fill_or_kill: false,
                no_rest: false,
            },
        ),
        Error::Crossed,
    );
}

#[test]
fn slot_is_positional() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 5, 3, 1);
    rest_ask(&h, &maker, 5, 7, 2);
    let a = h.client().order(&h.market, &maker, &1);
    let b = h.client().order(&h.market, &maker, &2);
    assert_eq!(a.seq, 0);
    assert_eq!(b.seq, 1);
    assert_eq!(a.qty_lots, 3);
    assert_eq!(b.qty_lots, 7);
}

#[test]
fn rest_bid_escrows_quote() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_bid(&h, &maker, 8, 4, 1);
    let vault = TokenClient::new(&h.env, &h.quote).balance(&h.id);
    assert_eq!(vault, 32);
}
