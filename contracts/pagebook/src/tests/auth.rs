use super::harness::setup;
use crate::Error;
use soroban_sdk::{testutils::Address as _, Address, BytesN};

#[test]
fn set_admin_requires_auth() {
    let h = setup();
    h.env.set_auths(&[]);
    let next = Address::generate(&h.env);
    assert!(h.client().try_set_admin(&next).is_err());
}

#[test]
fn set_paused_requires_auth() {
    let h = setup();
    h.env.set_auths(&[]);
    assert!(h.client().try_set_paused(&true).is_err());
}

#[test]
fn create_market_requires_admin() {
    let h = setup();
    h.env.set_auths(&[]);
    assert!(h
        .client()
        .try_create_market(&h.base, &h.quote, &1, &1, &1, &10, &0, &1, &10)
        .is_err());
}

#[test]
fn place_requires_taker_auth() {
    let h = setup();
    let taker = Address::generate(&h.env);
    h.env.set_auths(&[]);
    assert!(h
        .client()
        .try_place(
            &taker,
            &h.market,
            &false,
            &10,
            &1,
            &10,
            &1,
            &super::harness::window(&h),
            &super::harness::flags(),
        )
        .is_err());
}

#[test]
fn settle_requires_owner_auth() {
    let h = setup();
    let maker = Address::generate(&h.env);
    super::harness::rest_ask(&h, &maker, 10, 1, 1);
    h.env.set_auths(&[]);
    assert!(h.client().try_settle(&maker, &h.market, &1).is_err());
}

#[test]
fn upgrade_without_auth_fails() {
    let h = setup();
    h.env.set_auths(&[]);
    let hash = BytesN::from_array(&h.env, &[1u8; 32]);
    assert!(h.client().try_upgrade(&hash).is_err());
}

#[test]
fn unknown_order() {
    let h = setup();
    let maker = Address::generate(&h.env);
    super::assert_err(
        h.client().try_settle(&maker, &h.market, &99),
        Error::UnknownOrder,
    );
}
