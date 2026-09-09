use crate::errors::Error;
use crate::keys::DataKey;
use pagebook_types::{BestTick, Config, FeeAccrual, Level, Market, Order};
use soroban_sdk::{Address, Env};

pub fn load_config(env: &Env) -> Config {
    note(&DataKey::Config);
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .unwrap_or_else(|| env.panic_with_error(Error::NotInitialized))
}

pub fn save_config(env: &Env, config: &Config) {
    note(&DataKey::Config);
    env.storage().instance().set(&DataKey::Config, config);
}

pub fn load_market(env: &Env, market: u32) -> Market {
    note(&DataKey::Market(market));
    env.storage()
        .persistent()
        .get(&DataKey::Market(market))
        .unwrap_or_else(|| env.panic_with_error(Error::UnknownMarket))
}

pub fn save_market(env: &Env, market: u32, m: &Market) {
    note(&DataKey::Market(market));
    env.storage().persistent().set(&DataKey::Market(market), m);
}

/// A missing `Level` is the empty queue; a present one of the wrong shape fails
/// the SDK's typed conversion rather than decoding as something else.
pub fn load_level(env: &Env, market: u32, is_bid: bool, tick: u32) -> Level {
    let key = DataKey::Level(market, is_bid, tick);
    note(&key);
    env.storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Level::empty(env))
}

pub fn save_level(env: &Env, market: u32, is_bid: bool, tick: u32, level: &Level) {
    let key = DataKey::Level(market, is_bid, tick);
    note(&key);
    env.storage().persistent().set(&key, level);
}

pub fn load_best(env: &Env, market: u32, is_bid: bool) -> BestTick {
    let key = DataKey::BestTick(market, is_bid);
    note(&key);
    env.storage().persistent().get(&key).unwrap_or(BestTick {
        empty: true,
        tick: 0,
    })
}

pub fn save_best(env: &Env, market: u32, is_bid: bool, best: &BestTick) {
    note(&DataKey::BestTick(market, is_bid));
    env.storage()
        .persistent()
        .set(&DataKey::BestTick(market, is_bid), best);
}

pub fn load_order(env: &Env, market: u32, owner: &Address, nonce: u64) -> Option<Order> {
    note(&DataKey::Order(market, owner.clone(), nonce));
    env.storage()
        .persistent()
        .get(&DataKey::Order(market, owner.clone(), nonce))
}

pub fn save_order(env: &Env, market: u32, owner: &Address, nonce: u64, order: &Order) {
    note(&DataKey::Order(market, owner.clone(), nonce));
    env.storage()
        .persistent()
        .set(&DataKey::Order(market, owner.clone(), nonce), order);
}

pub fn del_order(env: &Env, market: u32, owner: &Address, nonce: u64) {
    note(&DataKey::Order(market, owner.clone(), nonce));
    env.storage()
        .persistent()
        .remove(&DataKey::Order(market, owner.clone(), nonce));
}

pub fn load_fees(env: &Env, market: u32, token: &Address) -> i128 {
    note(&DataKey::FeeAccrual(market, token.clone()));
    env.storage()
        .persistent()
        .get(&DataKey::FeeAccrual(market, token.clone()))
        .map(|f: FeeAccrual| f.accrued)
        .unwrap_or(0)
}

pub fn save_fees(env: &Env, market: u32, token: &Address, accrued: i128) {
    note(&DataKey::FeeAccrual(market, token.clone()));
    env.storage().persistent().set(
        &DataKey::FeeAccrual(market, token.clone()),
        &FeeAccrual { accrued },
    );
}

pub fn require_not_paused(env: &Env) {
    if load_config(env).paused {
        env.panic_with_error(Error::Paused);
    }
}

#[inline]
pub fn note(key: &DataKey) {
    #[cfg(test)]
    trace::record(key);
    #[cfg(not(test))]
    let _ = key;
}

/// Test-only key trace (ADR-016 rung 2 for reads, ADR-020): every key this
/// module or `bitmap` loads or saves is recorded, so tests can assert
/// `touched ⊆ declared` (invariant 6) without a host footprint API.
#[cfg(test)]
pub mod trace {
    extern crate std;
    use super::DataKey;
    use std::cell::RefCell;
    use std::vec::Vec;

    std::thread_local! {
        static KEYS: RefCell<Option<Vec<DataKey>>> = const { RefCell::new(None) };
    }

    pub fn start() {
        KEYS.with(|k| *k.borrow_mut() = Some(Vec::new()));
    }

    pub fn stop() -> Vec<DataKey> {
        KEYS.with(|k| k.borrow_mut().take().unwrap_or_default())
    }

    pub fn record(key: &DataKey) {
        KEYS.with(|k| {
            if let Some(v) = k.borrow_mut().as_mut() {
                if !v.contains(key) {
                    v.push(key.clone());
                }
            }
        });
    }
}
