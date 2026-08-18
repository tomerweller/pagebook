use crate::{Config, DataKey, PageBook, PageBookClient};
use soroban_sdk::{
    testutils::{storage::Instance as _, storage::Persistent as _, Address as _},
    xdr::{Limits, ScVal, WriteXdr},
    Address, Env, TryFromVal, Val,
};

/// Every PageBook key the call loaded or saved (reads and writes), from the
/// test-only store trace (ADR-020). Use to assert `touched ⊆ declared`.
extern crate std;

pub fn keys_touched<F: FnOnce()>(_h: &super::harness::Harness, call: F) -> std::vec::Vec<DataKey> {
    crate::store::trace::start();
    call();
    crate::store::trace::stop()
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Footprint {
    pub written_keys: soroban_sdk::Vec<DataKey>,
    pub write_bytes: u32,
    pub write_entries: u32,
    pub memory_read_entries: u32,
    pub disk_read_entries: u32,
}

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

/// The test env's `all()` returns every contract's entries (SAC balances
/// included); only PageBook's own `DataKey`s are decoded, since decoding a
/// foreign enum key through the host is a hard error, not an `Err`.
fn is_pagebook_key(env: &Env, k: &Val) -> bool {
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

fn map_keys(env: &Env, map: &soroban_sdk::Map<Val, Val>) -> soroban_sdk::Vec<(DataKey, Val)> {
    let mut out = soroban_sdk::Vec::new(env);
    for (k, v) in map.iter() {
        if !is_pagebook_key(env, &k) {
            continue;
        }
        if let Ok(key) = DataKey::try_from_val(env, &k) {
            out.push_back((key, v));
        }
    }
    out
}

fn xdr_val_len(env: &Env, val: &Val) -> u32 {
    let scval = ScVal::try_from_val(env, val).unwrap();
    scval.to_xdr(Limits::none()).unwrap().len() as u32
}

pub fn footprint_of<F, R>(env: &Env, contract: &Address, call: F) -> (R, Footprint)
where
    F: FnOnce() -> R,
{
    let before_p = env.as_contract(contract, || env.storage().persistent().all());
    let before_i = env.as_contract(contract, || env.storage().instance().all());
    let result = call();
    // Read the meter right after the call: `as_contract` below is itself a
    // metered invocation and would reset the last-invocation resources.
    let resources = env.cost_estimate().resources();
    let after_p = env.as_contract(contract, || env.storage().persistent().all());
    let after_i = env.as_contract(contract, || env.storage().instance().all());

    let before = {
        let mut all = map_keys(env, &before_p);
        for pair in map_keys(env, &before_i).iter() {
            all.push_back(pair);
        }
        all
    };
    let after = {
        let mut all = map_keys(env, &after_p);
        for pair in map_keys(env, &after_i).iter() {
            all.push_back(pair);
        }
        all
    };

    let mut written = soroban_sdk::Vec::new(env);
    let mut write_bytes = 0u32;
    for (key, val) in after.iter() {
        let mut changed = true;
        for (bk, bv) in before.iter() {
            if bk == key {
                let a = ScVal::try_from_val(env, &bv).unwrap();
                let b = ScVal::try_from_val(env, &val).unwrap();
                changed = a != b;
                break;
            }
        }
        if changed {
            written.push_back(key);
            write_bytes = write_bytes.saturating_add(xdr_val_len(env, &val));
        }
    }
    for (key, _) in before.iter() {
        let mut gone = true;
        for (ak, _) in after.iter() {
            if ak == key {
                gone = false;
                break;
            }
        }
        if gone {
            written.push_back(key);
        }
    }

    (
        result,
        Footprint {
            written_keys: written,
            write_bytes: resources.write_bytes.max(write_bytes),
            write_entries: resources.write_entries,
            memory_read_entries: resources.memory_read_entries,
            disk_read_entries: resources.disk_read_entries,
        },
    )
}

#[test]
fn constructor_writes_config_only() {
    let env = super::env();
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let id = env.register(PageBook, (&admin, &recipient));
    let stored: Config = env.as_contract(&id, || {
        let store = env.storage().instance().get(&DataKey::Config).unwrap();
        Config::from_store(store)
    });
    assert_eq!(stored.admin, admin);
    assert_eq!(stored.fee_recipient, recipient);
    assert!(!stored.paused);
    assert_eq!(stored.market_counter, 0);

    let persistent = env.as_contract(&id, || env.storage().persistent().all());
    assert_eq!(persistent.len(), 0);
}

#[test]
fn keepalive_footprint_has_no_persistent_writes() {
    let env = super::env();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let id = env.register(PageBook, (&admin, &recipient));
    let client = PageBookClient::new(&env, &id);
    let (_, fp) = footprint_of(&env, &id, || client.keepalive());
    let persistent = env.as_contract(&id, || env.storage().persistent().all());
    assert_eq!(persistent.len(), 0);
    for key in fp.written_keys.iter() {
        assert_ne!(key, DataKey::Market(0));
    }
}

#[test]
fn set_paused_write_set_is_instance_config() {
    let env = super::env();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let id = env.register(PageBook, (&admin, &recipient));
    let client = PageBookClient::new(&env, &id);
    let (_, fp) = footprint_of(&env, &id, || client.set_paused(&true));
    assert!(fp.written_keys.iter().any(|k| k == DataKey::Config));
    let stored: Config = env.as_contract(&id, || {
        let store = env.storage().instance().get(&DataKey::Config).unwrap();
        Config::from_store(store)
    });
    assert!(stored.paused);
}

#[test]
fn place_rest_does_not_write_instance() {
    let h = super::harness::setup();
    let maker = Address::generate(&h.env);
    let before = h
        .env
        .as_contract(&h.id, || h.env.storage().instance().all());
    super::harness::rest_ask(&h, &maker, 10, 2, 1);
    let after = h
        .env
        .as_contract(&h.id, || h.env.storage().instance().all());
    assert_eq!(before.len(), after.len());
}

#[test]
fn settle_does_not_write_instance() {
    let h = super::harness::setup();
    let maker = Address::generate(&h.env);
    super::harness::rest_ask(&h, &maker, 10, 2, 1);
    let before = h
        .env
        .as_contract(&h.id, || h.env.storage().instance().all());
    h.client().settle(&maker, &h.market, &1);
    let after = h
        .env
        .as_contract(&h.id, || h.env.storage().instance().all());
    assert_eq!(before.len(), after.len());
}

// ---------------------------------------------------------------------------
// Per-entry-point resource gates (architecture §17, ADR-021). Each gate is the
// measured value at calibration plus a small slack (+2 in-memory read entries,
// +1 write entry) so any regression that adds a storage access shows up; the
// §17 rows are the design ceilings and every gate sits under them. Every
// assertion prints the measured numbers.
// ---------------------------------------------------------------------------

use super::harness::{flags, mint, rest_ask, rest_bid, setup, window, Harness};
use crate::{PlaceFlags, PlaceLeg, ReplaceItem};

fn assert_within(name: &str, fp: &Footprint, max_reads: u32, max_writes: u32) {
    std::println!(
        "footprint[{name}]: memory_read_entries={} write_entries={} write_bytes={} (gates {max_reads} / {max_writes})",
        fp.memory_read_entries,
        fp.write_entries,
        fp.write_bytes
    );
    assert!(
        fp.memory_read_entries <= max_reads,
        "{name}: memory_read_entries {} > gate {max_reads}",
        fp.memory_read_entries
    );
    assert!(
        fp.write_entries <= max_writes,
        "{name}: write_entries {} > gate {max_writes}",
        fp.write_entries
    );
}

fn no_rest() -> PlaceFlags {
    PlaceFlags {
        post_only: false,
        fill_or_kill: false,
        no_rest: true,
    }
}

fn place_fp(
    h: &Harness,
    who: &Address,
    is_bid: bool,
    limit: u32,
    qty: u64,
    start: u32,
    nonce: u64,
    f: PlaceFlags,
) -> Footprint {
    let (_, fp) = footprint_of(&h.env, &h.id, || {
        h.client().place(
            who,
            &h.market,
            &is_bid,
            &limit,
            &qty,
            &start,
            &nonce,
            &window(h),
            &f,
        )
    });
    fp
}

#[test]
fn bound_place_rest_existing_level() {
    let h = setup();
    let a = Address::generate(&h.env);
    let b = Address::generate(&h.env);
    rest_ask(&h, &a, 10, 2, 1);
    mint(&h, &h.base, &b, 1_000);
    let fp = place_fp(&h, &b, false, 10, 2, 10, 1, flags());
    assert_within("place rest existing level", &fp, 15, 6);
}

#[test]
fn bound_place_rest_new_level() {
    let h = setup();
    let a = Address::generate(&h.env);
    mint(&h, &h.base, &a, 1_000);
    let fp = place_fp(&h, &a, false, 10, 2, 10, 1, flags());
    assert_within("place rest new level", &fp, 17, 9);
}

#[test]
fn bound_place_take_eight_levels() {
    let h = setup();
    let maker = Address::generate(&h.env);
    for i in 0..8u32 {
        rest_ask(&h, &maker, 10 + i, 1, u64::from(i) + 1);
    }
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let fp = place_fp(&h, &taker, true, 17, 8, 10, 1, no_rest());
    assert_within("place take 8 levels", &fp, 24, 18);
}

#[test]
fn bound_place_take_eight_levels_then_rest() {
    let h = setup();
    let maker = Address::generate(&h.env);
    for i in 0..8u32 {
        rest_ask(&h, &maker, 10 + i, 1, u64::from(i) + 1);
    }
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let ((rested, filled, _), fp) = footprint_of(&h.env, &h.id, || {
        h.client().place(
            &taker,
            &h.market,
            &true,
            &20,
            &10,
            &10,
            &1,
            &window(&h),
            &flags(),
        )
    });
    assert!(rested);
    assert_eq!(filled, 8);
    // 8-level take plus a rest at a new level (the two rows composed).
    assert_within("place take 8 levels + rest", &fp, 29, 23);
}

#[test]
fn bound_settle() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 2, 1);
    let (_, fp) = footprint_of(&h.env, &h.id, || h.client().settle(&maker, &h.market, &1));
    assert_within("settle", &fp, 11, 6);
}

#[test]
fn bound_replace() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 2, 1);
    let (_, fp) = footprint_of(&h.env, &h.id, || {
        h.client()
            .replace(&maker, &h.market, &1, &false, &12, &3, &window(&h))
    });
    assert_within("replace", &fp, 15, 8);
}

#[test]
fn bound_replace_batch_five_items() {
    let h = setup();
    let maker = Address::generate(&h.env);
    for n in 1..=5u64 {
        rest_ask(&h, &maker, 10 + n as u32, 2, n);
    }
    let mut items = soroban_sdk::Vec::new(&h.env);
    for n in 1..=5u64 {
        items.push_back(ReplaceItem {
            nonce: n,
            is_bid: false,
            tick: 20 + n as u32,
            qty_lots: 3,
            window: window(&h),
        });
    }
    let (_, fp) = footprint_of(&h.env, &h.id, || {
        h.client().replace_batch(&maker, &h.market, &items)
    });
    // §17: one quote ≈ 14 / 8, a 40-quote refresh ≈ 130 / 90 — so about
    // 3 footprint / 2.1 writes per extra item on top of the first.
    assert_within("replace_batch 5", &fp, 27, 20);
}

#[test]
fn bound_route_two_legs() {
    let h = setup();
    let maker = Address::generate(&h.env);
    for i in 0..8u32 {
        rest_ask(&h, &maker, 10 + i, 1, u64::from(i) + 1);
    }
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    let leg = |limit: u32, start: u32, nonce: u64| PlaceLeg {
        market: h.market,
        is_bid: true,
        limit_tick: limit,
        qty_lots: 4,
        start_tick: start,
        nonce,
        window: window(&h),
        flags: no_rest(),
    };
    let mut legs = soroban_sdk::Vec::new(&h.env);
    legs.push_back(leg(13, 10, 1));
    legs.push_back(leg(17, 14, 2));
    let (out, fp) = footprint_of(&h.env, &h.id, || h.client().route(&taker, &legs));
    assert_eq!(out.get(0).unwrap().1, 4);
    assert_eq!(out.get(1).unwrap().1, 4);
    // Two legs sweeping 4 levels each: bounded by the 8-level take row.
    assert_within("route 2 legs (8 levels)", &fp, 24, 18);
}

#[test]
fn bound_create_market() {
    let h = setup();
    let (_, fp) = footprint_of(&h.env, &h.id, || {
        h.client()
            .create_market(&h.base, &h.quote, &1, &1, &1, &1000, &10, &1, &1_000_000)
    });
    // Config (instance), two SAC instances for `authorized`, the new Market.
    assert_within("create_market", &fp, 10, 4);
}

#[test]
fn bound_set_market_caps() {
    let h = setup();
    let (_, fp) = footprint_of(&h.env, &h.id, || {
        h.client()
            .set_market_caps(&h.market, &16, &32, &10, &1, &1_000_000, &1)
    });
    assert_within("set_market_caps", &fp, 6, 3);
}

#[test]
fn bound_collect_fees() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 100, 1);
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    h.client().place(
        &taker,
        &h.market,
        &true,
        &10,
        &100,
        &10,
        &1,
        &window(&h),
        &no_rest(),
    );
    let (got, fp) = footprint_of(&h.env, &h.id, || {
        h.client().collect_fees(&h.market, &h.base)
    });
    assert!(got > 0);
    // Config, FeeAccrual, SAC instance, vault + recipient balances.
    assert_within("collect_fees", &fp, 7, 4);
}

#[test]
fn bound_keepalive() {
    let h = setup();
    let (_, fp) = footprint_of(&h.env, &h.id, || h.client().keepalive());
    assert_within("keepalive", &fp, 4, 1);
}

#[test]
fn quote_place_writes_nothing() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 2, 1);
    rest_ask(&h, &maker, 12, 2, 2);
    let (q, fp) = footprint_of(&h.env, &h.id, || {
        h.client().quote_place(&h.market, &true, &12, &3)
    });
    assert_eq!(q.filled_lots, 3);
    std::println!(
        "footprint[quote_place]: memory_read_entries={} write_entries={}",
        fp.memory_read_entries,
        fp.write_entries
    );
    assert_eq!(fp.write_entries, 0);
    assert_eq!(fp.written_keys.len(), 0);
}

#[test]
fn views_write_nothing() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 2, 1);
    rest_bid(&h, &maker, 5, 2, 2);
    let (_, fp) = footprint_of(&h.env, &h.id, || h.client().best(&h.market, &false));
    assert_eq!(fp.write_entries, 0);
    let (_, fp) = footprint_of(&h.env, &h.id, || h.client().level(&h.market, &false, &10));
    assert_eq!(fp.write_entries, 0);
    let (_, fp) = footprint_of(&h.env, &h.id, || h.client().order(&h.market, &maker, &1));
    assert_eq!(fp.write_entries, 0);
    assert_eq!(fp.written_keys.len(), 0);
}
