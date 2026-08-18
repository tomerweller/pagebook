use super::harness::{setup, Harness};
use crate::{Error, PageBook, PageBookClient};
use pagebook_types::TICK_INDEX_SPAN;
use soroban_sdk::{testutils::Address as _, Address};

#[test]
fn create_rejects_same_token() {
    let h = setup();
    super::assert_err(
        h.client()
            .try_create_market(&h.base, &h.base, &1, &1, &1, &10, &0, &1, &10),
        Error::SameToken,
    );
}

#[test]
fn create_rejects_tick_max_over_span() {
    let h = setup();
    super::assert_err(
        h.client().try_create_market(
            &h.base,
            &h.quote,
            &1,
            &1,
            &1,
            &(TICK_INDEX_SPAN + 1),
            &0,
            &1,
            &10,
        ),
        Error::TickOutOfBand,
    );
}

#[test]
fn create_rejects_zero_lot() {
    let h = setup();
    super::assert_err(
        h.client()
            .try_create_market(&h.base, &h.quote, &0, &1, &1, &10, &0, &1, &10),
        Error::BadQuantization,
    );
}

#[test]
fn create_rejects_high_fee() {
    let h = setup();
    super::assert_err(
        h.client()
            .try_create_market(&h.base, &h.quote, &1, &1, &1, &10, &1001, &1, &10),
        Error::FeeTooHigh,
    );
}

#[test]
fn create_rejects_unauthorized_token() {
    let env = super::env();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(PageBook, (&admin, &admin));
    let issuer = Address::generate(&env);
    let base = env.register_stellar_asset_contract_v2(issuer.clone());
    let quote = env.register_stellar_asset_contract_v2(issuer);
    use soroban_sdk::testutils::IssuerFlags;
    base.issuer().set_flag(IssuerFlags::RequiredFlag);
    quote.issuer().set_flag(IssuerFlags::RequiredFlag);
    let client = PageBookClient::new(&env, &id);
    super::assert_err(
        client.try_create_market(
            &base.address(),
            &quote.address(),
            &1,
            &1,
            &1,
            &10,
            &0,
            &1,
            &10,
        ),
        Error::TokenNotAuthorized,
    );
}

#[test]
fn set_market_caps_rejects_lower_max_pages() {
    let h = setup();
    super::assert_err(
        h.client()
            .try_set_market_caps(&h.market, &32, &64, &10, &1, &1_000_000, &0),
        Error::QtyOutOfBounds,
    );
}

#[test]
fn set_market_caps_retune_keeps_live_orders() {
    let h = setup();
    let maker = Address::generate(&h.env);
    super::harness::rest_ask(&h, &maker, 10, 5, 1);
    h.client()
        .set_market_caps(&h.market, &16, &32, &10, &1, &1_000_000, &1);
    let info = h.client().order(&h.market, &maker, &1);
    assert_eq!(info.qty_lots, 5);
}

#[test]
fn overflow_proof_rejects_huge_max_order() {
    let h = setup();
    super::assert_err(
        h.client().try_create_market(
            &h.base,
            &h.quote,
            &u64::MAX,
            &u64::MAX,
            &1,
            &1000,
            &0,
            &1,
            &u64::MAX,
        ),
        Error::Overflow,
    );
}

#[test]
fn first_market_id_is_zero() {
    let h = setup();
    assert_eq!(h.market, 0);
}

fn _keep_harness_type(_: &Harness) {}
