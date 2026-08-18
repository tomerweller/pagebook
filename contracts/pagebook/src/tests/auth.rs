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

/// ADR-021: the taker's pay-in is a pure function of the call's arguments, so an
/// auth tree signed at simulation (top-level `place` + the exact SAC
/// `transfer(taker, vault, escrow)` sub-invocation) still authorizes the apply
/// after the book changed in flight. Here: simulate a rest-only bid (asks empty),
/// an ask lands inside the band, apply fills part and rests the rest — same
/// pay-in, different fills — under a real (non-mocked-all) auth tree.
#[test]
fn signed_pay_in_survives_a_race_that_changes_the_fill() {
    use super::harness::{mint, rest_ask, window};
    use crate::{PlaceFlags, SlotWindow};
    use soroban_sdk::token::TokenClient;
    fn bal(h: &super::harness::Harness, token: &Address, who: &Address) -> i128 {
        TokenClient::new(&h.env, token).balance(who)
    }
    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
    use soroban_sdk::IntoVal;

    let h = setup();
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let maker = Address::generate(&h.env);
    // Book at simulation: one ask 1 @ 25. Bid 5 @ 30 from start_tick 25 would
    // fill 1 @ 25 and rest 4 @ 30; the pay-in is the full escrow 5 × 30 = 150.
    rest_ask(&h, &maker, 25, 1, 1);
    let (is_bid, limit, qty, start, nonce) = (true, 30u32, 5u64, 25u32, 7u64);
    let escrow: i128 = 5 * 30 * 1;
    let w: SlotWindow = window(&h);
    let f = PlaceFlags::none();

    // In flight: another ask lands at 27, inside the band and worse than
    // start_tick, so the apply fills 2 and rests 3: different fills, same pay-in.
    rest_ask(&h, &maker, 27, 1, 2);

    // The taker signed exactly this tree at simulation.
    let vault = h.id.clone();
    let quote = h.quote.clone();
    let place_args = (
        taker.clone(),
        h.market,
        is_bid,
        limit,
        qty,
        start,
        nonce,
        w.clone(),
        f.clone(),
    )
        .into_val(&h.env);
    let transfer_args = (taker.clone(), vault.clone(), escrow).into_val(&h.env);
    h.env.mock_auths(&[MockAuth {
        address: &taker,
        invoke: &MockAuthInvoke {
            contract: &h.id,
            fn_name: "place",
            args: place_args,
            sub_invokes: &[MockAuthInvoke {
                contract: &quote,
                fn_name: "transfer",
                args: transfer_args,
                sub_invokes: &[],
            }],
        },
    }]);
    let (rested, filled, spent) = h.client().place(
        &taker, &h.market, &is_bid, &limit, &qty, &start, &nonce, &w, &f,
    );
    // Filled 2 (25 + 27 = 52 spent), rested 3 @ 30 (escrow 90), 8 quote came
    // back: the signed pay-in of 150 was still exact.
    assert_eq!(filled, 2);
    assert_eq!(spent, 52);
    assert!(rested);
    assert_eq!(bal(&h, &h.quote, &taker), 1_000_000 - 52 - 90);
}
