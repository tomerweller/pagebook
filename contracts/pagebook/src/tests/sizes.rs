use crate::{Config, DataKey, PageBook};
use pagebook_types::{
    BestTick, FeeAccrual, Level, LevelPage, Market, Order, TickBitmap, BUDGET_BEST_TICK,
    BUDGET_CONFIG, BUDGET_FEE_ACCRUAL, BUDGET_LEVEL, BUDGET_LEVEL_PAGE, BUDGET_MARKET,
    BUDGET_ORDER, BUDGET_TICK_BITMAP, INLINE_SLOTS, PAGE_SLOTS,
};
use soroban_sdk::{
    testutils::Address as _,
    xdr::{Limits, ScVal, WriteXdr},
    Address, Bytes, Env, IntoVal, TryFromVal, Val,
};

fn xdr_len(env: &Env, val: impl IntoVal<Env, Val>) -> usize {
    let val: Val = val.into_val(env);
    let scval = ScVal::try_from_val(env, &val).unwrap();
    scval.to_xdr(Limits::none()).unwrap().len()
}

#[test]
fn packed_level_under_budget() {
    let env = super::env();
    let mut level = Level {
        generation: u32::MAX,
        head_seq: u32::MAX,
        tail_seq: u32::MAX,
        head_consumed_lots: u64::MAX,
        open_lots: u64::MAX,
        slots: [u64::MAX; INLINE_SLOTS as usize],
    };
    level.slots[0] = u64::MAX;
    let bytes = Bytes::from_array(&env, &level.encode());
    let n = xdr_len(&env, bytes);
    assert!(n <= BUDGET_LEVEL, "Level XDR {n} > {BUDGET_LEVEL}");
}

#[test]
fn packed_level_page_under_budget() {
    let env = super::env();
    let page = LevelPage {
        slots: [u64::MAX; PAGE_SLOTS as usize],
    };
    let bytes = Bytes::from_array(&env, &page.encode());
    let n = xdr_len(&env, bytes);
    assert!(
        n <= BUDGET_LEVEL_PAGE,
        "LevelPage XDR {n} > {BUDGET_LEVEL_PAGE}"
    );
}

#[test]
fn packed_best_tick_under_budget() {
    let env = super::env();
    let best = BestTick {
        empty: true,
        tick: u32::MAX,
    };
    let bytes = Bytes::from_array(&env, &best.encode());
    let n = xdr_len(&env, bytes);
    assert!(
        n <= BUDGET_BEST_TICK,
        "BestTick XDR {n} > {BUDGET_BEST_TICK}"
    );
}

#[test]
fn packed_tick_bitmaps_under_budget() {
    let env = super::env();
    let mut bm = TickBitmap::default();
    for i in 0..2048u32 {
        bm.set(i);
    }
    let bytes = Bytes::from_array(&env, &bm.encode());
    let n = xdr_len(&env, bytes);
    assert!(
        n <= BUDGET_TICK_BITMAP,
        "TickWord/TickSummary XDR {n} > {BUDGET_TICK_BITMAP}"
    );
}

#[test]
fn config_under_budget() {
    let env = super::env();
    let config = Config {
        admin: Address::generate(&env),
        fee_recipient: Address::generate(&env),
        paused: true,
        market_counter: u32::MAX,
    };
    let n = xdr_len(&env, config.to_store());
    assert!(n <= BUDGET_CONFIG, "Config XDR {n} > {BUDGET_CONFIG}");
}

#[test]
fn market_under_budget() {
    let env = super::env();
    let market = Market {
        base: Address::generate(&env),
        quote: Address::generate(&env),
        lot_size: u64::MAX,
        tick_size: u64::MAX,
        tick_min: 1,
        tick_max: 1 << 22,
        taker_fee_bps: 1_000,
        min_order_lots: 1,
        max_order_lots: u64::MAX,
        max_levels_crossed: 32,
        max_slots_scanned: 64,
        inline_slots: 32,
        page_slots: 32,
        max_pages: u32::MAX,
    };
    let n = xdr_len(&env, market.to_store(&env));
    assert!(n <= BUDGET_MARKET, "Market XDR {n} > {BUDGET_MARKET}");
}

#[test]
fn order_under_budget() {
    let env = super::env();
    let order = Order {
        is_bid: true,
        tick: u32::MAX,
        generation: u32::MAX,
        seq: u32::MAX,
        qty_lots: u64::MAX,
    };
    let n = xdr_len(&env, order);
    assert!(n <= BUDGET_ORDER, "Order XDR {n} > {BUDGET_ORDER}");
}

#[test]
fn fee_accrual_under_budget() {
    let env = super::env();
    let fees = FeeAccrual { accrued: i128::MAX };
    let n = xdr_len(&env, fees);
    assert!(
        n <= BUDGET_FEE_ACCRUAL,
        "FeeAccrual XDR {n} > {BUDGET_FEE_ACCRUAL}"
    );
}

#[test]
fn data_key_variants_encode() {
    let env = super::env();
    let owner = Address::generate(&env);
    let keys = [
        DataKey::Config,
        DataKey::Market(7),
        DataKey::Level(7, true, 99),
        DataKey::LevelPage(7, false, 99, 1),
        DataKey::Order(7, owner.clone(), 1),
        DataKey::FeeAccrual(7, owner),
        DataKey::BestTick(7, true),
        DataKey::TickSummary(7, false),
        DataKey::TickWord(7, true, 3),
    ];
    for key in keys {
        let n = xdr_len(&env, key);
        assert!(n > 0);
    }
}

#[test]
fn contract_registers() {
    let env = super::env();
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let _id = env.register(PageBook, (&admin, &recipient));
}
