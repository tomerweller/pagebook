use crate::errors::Error;
use crate::keys::DataKey;
use pagebook_types::{
    BestTick, Config, ConfigStore, FeeAccrual, Level, LevelPage, Market, MarketStore, Order,
    BEST_TICK_BYTES, LEVEL_BYTES, LEVEL_PAGE_BYTES,
};
use soroban_sdk::{Address, Bytes, Env};

pub fn load_config(env: &Env) -> Config {
    let store: ConfigStore = env
        .storage()
        .instance()
        .get(&DataKey::Config)
        .unwrap_or_else(|| env.panic_with_error(Error::NotAdmin));
    Config::from_store(store)
}

pub fn save_config(env: &Env, config: &Config) {
    env.storage()
        .instance()
        .set(&DataKey::Config, &config.to_store());
}

pub fn load_market(env: &Env, market: u32) -> Market {
    let store: MarketStore = env
        .storage()
        .persistent()
        .get(&DataKey::Market(market))
        .unwrap_or_else(|| env.panic_with_error(Error::UnknownMarket));
    Market::from_store(store).unwrap_or_else(|| env.panic_with_error(Error::Overflow))
}

pub fn save_market(env: &Env, market: u32, m: &Market) {
    env.storage()
        .persistent()
        .set(&DataKey::Market(market), &m.to_store(env));
}

pub fn load_level(env: &Env, market: u32, is_bid: bool, tick: u32) -> Level {
    let key = DataKey::Level(market, is_bid, tick);
    match env.storage().persistent().get::<_, Bytes>(&key) {
        Some(bytes) => {
            if bytes.len() != LEVEL_BYTES as u32 {
                env.panic_with_error(Error::Overflow);
            }
            let mut raw = [0u8; LEVEL_BYTES];
            bytes.copy_into_slice(&mut raw);
            Level::decode(&raw).unwrap_or_else(|| env.panic_with_error(Error::Overflow))
        }
        None => Level::default(),
    }
}

pub fn level_exists(env: &Env, market: u32, is_bid: bool, tick: u32) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::Level(market, is_bid, tick))
}

pub fn save_level(env: &Env, market: u32, is_bid: bool, tick: u32, level: &Level) {
    let bytes = Bytes::from_array(env, &level.encode());
    env.storage()
        .persistent()
        .set(&DataKey::Level(market, is_bid, tick), &bytes);
}

pub fn load_page(env: &Env, market: u32, is_bid: bool, tick: u32, page: u32) -> LevelPage {
    let key = DataKey::LevelPage(market, is_bid, tick, page);
    match env.storage().persistent().get::<_, Bytes>(&key) {
        Some(bytes) => {
            if bytes.len() != LEVEL_PAGE_BYTES as u32 {
                env.panic_with_error(Error::Overflow);
            }
            let mut raw = [0u8; LEVEL_PAGE_BYTES];
            bytes.copy_into_slice(&mut raw);
            LevelPage::decode(&raw).unwrap_or_else(|| env.panic_with_error(Error::Overflow))
        }
        None => LevelPage::default(),
    }
}

pub fn save_page(env: &Env, market: u32, is_bid: bool, tick: u32, page: u32, p: &LevelPage) {
    let bytes = Bytes::from_array(env, &p.encode());
    env.storage()
        .persistent()
        .set(&DataKey::LevelPage(market, is_bid, tick, page), &bytes);
}

pub fn load_best(env: &Env, market: u32, is_bid: bool) -> BestTick {
    let key = DataKey::BestTick(market, is_bid);
    match env.storage().persistent().get::<_, Bytes>(&key) {
        Some(bytes) => {
            if bytes.len() != BEST_TICK_BYTES as u32 {
                env.panic_with_error(Error::Overflow);
            }
            let mut raw = [0u8; BEST_TICK_BYTES];
            bytes.copy_into_slice(&mut raw);
            BestTick::decode(&raw).unwrap_or_else(|| env.panic_with_error(Error::Overflow))
        }
        None => BestTick {
            empty: true,
            tick: 0,
        },
    }
}

pub fn save_best(env: &Env, market: u32, is_bid: bool, best: &BestTick) {
    let bytes = Bytes::from_array(env, &best.encode());
    env.storage()
        .persistent()
        .set(&DataKey::BestTick(market, is_bid), &bytes);
}

pub fn load_order(env: &Env, market: u32, owner: &Address, nonce: u64) -> Option<Order> {
    env.storage()
        .persistent()
        .get(&DataKey::Order(market, owner.clone(), nonce))
}

pub fn save_order(env: &Env, market: u32, owner: &Address, nonce: u64, order: &Order) {
    env.storage()
        .persistent()
        .set(&DataKey::Order(market, owner.clone(), nonce), order);
}

pub fn del_order(env: &Env, market: u32, owner: &Address, nonce: u64) {
    env.storage()
        .persistent()
        .remove(&DataKey::Order(market, owner.clone(), nonce));
}

pub fn load_fees(env: &Env, market: u32, token: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::FeeAccrual(market, token.clone()))
        .map(|f: FeeAccrual| f.accrued)
        .unwrap_or(0)
}

pub fn save_fees(env: &Env, market: u32, token: &Address, accrued: i128) {
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
