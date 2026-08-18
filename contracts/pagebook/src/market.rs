use crate::errors::Error;
use crate::math::overflow_bound_ok;
use crate::store;
use pagebook_types::{
    level_cap, Market, FEE_BPS_MAX, INLINE_SLOTS, MAX_LEVELS_CROSSED, MAX_PAGES, MAX_SLOTS_SCANNED,
    PAGE_SLOTS, TICK_INDEX_SPAN,
};
use soroban_sdk::{token::StellarAssetClient, Address, Env};

pub fn create_market(
    env: &Env,
    base: Address,
    quote: Address,
    lot_size: u64,
    tick_size: u64,
    tick_min: u32,
    tick_max: u32,
    taker_fee_bps: u32,
    min_order_lots: u64,
    max_order_lots: u64,
) -> u32 {
    let mut config = store::load_config(env);
    config.admin.require_auth();
    if base == quote {
        env.panic_with_error(Error::SameToken);
    }
    if tick_min < 1 || tick_min >= tick_max || tick_max > TICK_INDEX_SPAN {
        env.panic_with_error(Error::TickOutOfBand);
    }
    if lot_size < 1 || tick_size < 1 {
        env.panic_with_error(Error::BadQuantization);
    }
    if min_order_lots < 1 || min_order_lots > max_order_lots {
        env.panic_with_error(Error::QtyOutOfBounds);
    }
    if taker_fee_bps > FEE_BPS_MAX {
        env.panic_with_error(Error::FeeTooHigh);
    }
    prove_bounds(
        env,
        MAX_PAGES,
        max_order_lots,
        tick_max,
        tick_size,
        lot_size,
    );
    let vault = env.current_contract_address();
    if !StellarAssetClient::new(env, &base).authorized(&vault)
        || !StellarAssetClient::new(env, &quote).authorized(&vault)
    {
        env.panic_with_error(Error::TokenNotAuthorized);
    }
    let id = config.market_counter;
    if id == u32::MAX {
        env.panic_with_error(Error::Overflow);
    }
    config.market_counter = id + 1;
    store::save_config(env, &config);
    let market = Market {
        base,
        quote,
        lot_size,
        tick_size,
        tick_min,
        tick_max,
        taker_fee_bps,
        min_order_lots,
        max_order_lots,
        max_levels_crossed: MAX_LEVELS_CROSSED,
        max_slots_scanned: MAX_SLOTS_SCANNED,
        inline_slots: INLINE_SLOTS,
        page_slots: PAGE_SLOTS,
        max_pages: MAX_PAGES,
    };
    store::save_market(env, id, &market);
    id
}

pub fn set_market_caps(
    env: &Env,
    market: u32,
    max_levels_crossed: u32,
    max_slots_scanned: u32,
    taker_fee_bps: u32,
    min_order_lots: u64,
    max_order_lots: u64,
    max_pages: u32,
) {
    let config = store::load_config(env);
    config.admin.require_auth();
    let mut m = store::load_market(env, market);
    if taker_fee_bps > FEE_BPS_MAX {
        env.panic_with_error(Error::FeeTooHigh);
    }
    if min_order_lots < 1 || min_order_lots > max_order_lots {
        env.panic_with_error(Error::QtyOutOfBounds);
    }
    if max_pages < m.max_pages {
        env.panic_with_error(Error::QtyOutOfBounds);
    }
    prove_bounds(
        env,
        max_pages,
        max_order_lots,
        m.tick_max,
        m.tick_size,
        m.lot_size,
    );
    m.max_levels_crossed = max_levels_crossed;
    m.max_slots_scanned = max_slots_scanned;
    m.taker_fee_bps = taker_fee_bps;
    m.min_order_lots = min_order_lots;
    m.max_order_lots = max_order_lots;
    m.max_pages = max_pages;
    store::save_market(env, market, &m);
}

fn prove_bounds(
    env: &Env,
    max_pages: u32,
    max_order_lots: u64,
    tick_max: u32,
    tick_size: u64,
    lot_size: u64,
) {
    let cap = level_cap(max_pages);
    if !overflow_bound_ok(cap, max_order_lots, tick_size, tick_max)
        || !overflow_bound_ok(cap, max_order_lots, lot_size, 1)
    {
        env.panic_with_error(Error::Overflow);
    }
    // `open_lots` and `head_consumed_lots` are u64: a full level of max-size
    // orders must fit (the i128 bounds above do not imply this).
    if (cap as u128) * (max_order_lots as u128) > u64::MAX as u128 {
        env.panic_with_error(Error::Overflow);
    }
}

pub fn require_qty(env: &Env, m: &Market, qty: u64) {
    if qty < m.min_order_lots || qty > m.max_order_lots {
        env.panic_with_error(Error::QtyOutOfBounds);
    }
}

pub fn require_tick(env: &Env, m: &Market, tick: u32) {
    if tick < m.tick_min || tick >= m.tick_max {
        env.panic_with_error(Error::TickOutOfBand);
    }
}

pub fn require_start(env: &Env, m: &Market, start_tick: u32) {
    if start_tick < m.tick_min || start_tick >= m.tick_max {
        env.panic_with_error(Error::BadStartTick);
    }
}
