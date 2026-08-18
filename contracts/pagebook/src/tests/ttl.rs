use crate::{DataKey, PageBook, PlaceFlags, MAX_ENTRY_TTL, MIN_PERSISTENT_TTL};
use soroban_sdk::{
    testutils::{storage::Instance as _, storage::Persistent as _, Address as _, Ledger as _},
    xdr::ScVal,
    Address, TryFromVal, Val,
};

extern crate std;

const DATA_KEY_NAMES: [&str; 9] = [
    "Config",
    "Market",
    "Level",
    "LevelPage",
    "Order",
    "FeeAccrual",
    "BestTick",
    "TickSummary",
    "TickWord",
];

fn is_pagebook_key(env: &soroban_sdk::Env, k: &Val) -> bool {
    let Ok(sc) = ScVal::try_from_val(env, k) else {
        return false;
    };
    let ScVal::Vec(Some(v)) = sc else {
        return false;
    };
    match v.first() {
        Some(ScVal::Symbol(s)) => DATA_KEY_NAMES.iter().any(|n| n.as_bytes() == s.as_slice()),
        _ => false,
    }
}

fn persistent_ttls(h: &super::harness::Harness) -> std::vec::Vec<(DataKey, u32)> {
    h.env.as_contract(&h.id, || {
        let all = h.env.storage().persistent().all();
        let mut out = std::vec::Vec::new();
        for (k, _) in all.iter() {
            if !is_pagebook_key(&h.env, &k) {
                continue;
            }
            if let Ok(key) = DataKey::try_from_val(&h.env, &k) {
                if h.env.storage().persistent().has(&key) {
                    out.push((key.clone(), h.env.storage().persistent().get_ttl(&key)));
                }
            }
        }
        out
    })
}

fn instance_ttl(h: &super::harness::Harness) -> u32 {
    h.env
        .as_contract(&h.id, || h.env.storage().instance().get_ttl())
}

fn lookup(rows: &[(DataKey, u32)], key: &DataKey) -> Option<u32> {
    rows.iter().find(|(k, _)| k == key).map(|(_, t)| *t)
}

/// Advance a few hundred ledgers, run `call`, and assert every pre-existing
/// persistent PageBook key it touched kept its TTL. Created keys (minimum TTL)
/// and deleted keys are skipped. Instance TTL must not move: only keepalive
/// and admin ops bump it.
fn assert_hot_path_unchanged<F: FnOnce()>(h: &super::harness::Harness, call: F) {
    let seq = h.env.ledger().sequence();
    h.env.ledger().set_sequence_number(seq + 500);
    let before = persistent_ttls(h);
    let inst_before = instance_ttl(h);
    let touched = super::footprint::keys_touched(h, call);
    let after = persistent_ttls(h);
    let inst_after = instance_ttl(h);
    assert_eq!(
        inst_after, inst_before,
        "instance TTL moved on a market op: {inst_before} -> {inst_after}"
    );
    for key in touched {
        if matches!(key, DataKey::Config) {
            continue;
        }
        let Some(ttl_before) = lookup(&before, &key) else {
            continue;
        };
        let Some(ttl_after) = lookup(&after, &key) else {
            continue;
        };
        assert_eq!(
            ttl_after, ttl_before,
            "TTL changed for {key:?}: {ttl_before} -> {ttl_after}"
        );
    }
}

fn no_rest() -> PlaceFlags {
    PlaceFlags {
        post_only: false,
        fill_or_kill: false,
        no_rest: true,
    }
}

#[test]
fn instance_ttl_is_readable() {
    let env = super::env();
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let id = env.register(PageBook, (&admin, &recipient));
    let ttl = env.as_contract(&id, || env.storage().instance().get_ttl());
    assert!(ttl > 0);
}

#[test]
fn advancing_past_ttl_does_not_drop_config_in_test_host() {
    let env = super::env();
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let id = env.register(PageBook, (&admin, &recipient));
    let ttl = env.as_contract(&id, || env.storage().instance().get_ttl());
    let seq = env.ledger().sequence();
    env.ledger()
        .set_sequence_number(seq.saturating_add(ttl).saturating_add(10));
    let still_there = env.as_contract(&id, || env.storage().instance().has(&DataKey::Config));
    assert!(
        still_there,
        "documented test-host behaviour (ADR-016): expiry does not evict; archival is a soak-only path"
    );
}

#[test]
fn ttl_constants_match_architecture() {
    assert_eq!(MIN_PERSISTENT_TTL, 2_073_600);
    assert_eq!(MAX_ENTRY_TTL, 3_110_400);
}

#[test]
fn keepalive_and_admin_ops_extend_instance_ttl() {
    let env = super::env();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let id = env.register(PageBook, (&admin, &recipient));
    let client = crate::PageBookClient::new(&env, &id);
    let before = env.as_contract(&id, || env.storage().instance().get_ttl());
    // move time on so an extension is observable, then crank
    let seq = env.ledger().sequence();
    env.ledger().set_sequence_number(seq + 1_000);
    client.keepalive();
    let after = env.as_contract(&id, || env.storage().instance().get_ttl());
    let max = env.as_contract(&id, || env.storage().max_ttl());
    assert!(after >= before, "keepalive extends: {after} >= {before}");
    assert_eq!(after, max, "keepalive extends to the max TTL");
    env.ledger().set_sequence_number(seq + 2_000);
    client.set_paused(&false);
    let after_admin = env.as_contract(&id, || env.storage().instance().get_ttl());
    assert!(
        after_admin >= after,
        "admin ops also bump: {after_admin} >= {after}"
    );
}

#[test]
fn place_rest_does_not_extend_existing_ttl() {
    let h = super::harness::setup();
    let a = Address::generate(&h.env);
    let b = Address::generate(&h.env);
    super::harness::rest_ask(&h, &a, 10, 2, 1);
    super::harness::mint(&h, &h.base, &b, 1_000);
    assert_hot_path_unchanged(&h, || {
        h.client().place(
            &b,
            &h.market,
            &false,
            &10,
            &2,
            &10,
            &2,
            &super::harness::window(&h),
            &super::harness::flags(),
        );
    });
}

#[test]
fn place_take_does_not_extend_existing_ttl() {
    let h = super::harness::setup();
    let maker = Address::generate(&h.env);
    super::harness::rest_ask(&h, &maker, 10, 4, 1);
    let taker = Address::generate(&h.env);
    super::harness::mint(&h, &h.quote, &taker, 1_000_000);
    assert_hot_path_unchanged(&h, || {
        h.client().place(
            &taker,
            &h.market,
            &true,
            &10,
            &2,
            &10,
            &1,
            &super::harness::window(&h),
            &no_rest(),
        );
    });
}

#[test]
fn settle_does_not_extend_existing_ttl() {
    let h = super::harness::setup();
    let maker = Address::generate(&h.env);
    super::harness::rest_ask(&h, &maker, 10, 2, 1);
    assert_hot_path_unchanged(&h, || {
        h.client().settle(&maker, &h.market, &1);
    });
}

#[test]
fn replace_does_not_extend_existing_ttl() {
    let h = super::harness::setup();
    let maker = Address::generate(&h.env);
    super::harness::rest_ask(&h, &maker, 10, 2, 1);
    assert_hot_path_unchanged(&h, || {
        h.client().replace(
            &maker,
            &h.market,
            &1,
            &false,
            &12,
            &3,
            &super::harness::window(&h),
        );
    });
}

#[test]
fn collect_fees_does_not_extend_existing_ttl() {
    let h = super::harness::setup();
    let maker = Address::generate(&h.env);
    super::harness::rest_ask(&h, &maker, 10, 100, 1);
    let taker = Address::generate(&h.env);
    super::harness::mint(&h, &h.quote, &taker, 1_000_000);
    h.client().place(
        &taker,
        &h.market,
        &true,
        &10,
        &100,
        &10,
        &1,
        &super::harness::window(&h),
        &no_rest(),
    );
    assert_hot_path_unchanged(&h, || {
        h.client().collect_fees(&h.market, &h.base);
    });
}
