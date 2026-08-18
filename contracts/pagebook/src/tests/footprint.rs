use crate::{Config, DataKey, PageBook, PageBookClient};
use soroban_sdk::{
    testutils::{storage::Instance as _, storage::Persistent as _, Address as _},
    xdr::{Limits, ScVal, WriteXdr},
    Address, Env, TryFromVal, Val,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Footprint {
    pub written_keys: soroban_sdk::Vec<DataKey>,
    pub write_bytes: u32,
    pub write_entries: u32,
    pub memory_read_entries: u32,
    pub disk_read_entries: u32,
}

fn map_keys(env: &Env, map: &soroban_sdk::Map<Val, Val>) -> soroban_sdk::Vec<(DataKey, Val)> {
    let mut out = soroban_sdk::Vec::new(env);
    for (k, v) in map.iter() {
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

    let resources = env.cost_estimate().resources();
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
