use crate::{Config, DataKey, PageBook};
use pagebook_types::{
    BestTick, FeeAccrual, Level, LevelPage, Market, Order, TickBitmap, BITMAP_BYTES,
    BUDGET_BEST_TICK, BUDGET_CONFIG, BUDGET_FEE_ACCRUAL, BUDGET_LEVEL, BUDGET_LEVEL_PAGE,
    BUDGET_MARKET, BUDGET_ORDER, BUDGET_TICK_BITMAP, INLINE_SLOTS, PAGE_SLOTS,
};
use soroban_sdk::{
    testutils::Address as _,
    xdr::{Limits, ScVal, WriteXdr},
    Address, BytesN, Env, IntoVal, TryFromVal, Val,
};

extern crate std;

fn xdr_bytes(env: &Env, val: impl IntoVal<Env, Val>) -> std::vec::Vec<u8> {
    let val: Val = val.into_val(env);
    let scval = ScVal::try_from_val(env, &val).unwrap();
    scval.to_xdr(Limits::none()).unwrap()
}

fn xdr_len(env: &Env, val: impl IntoVal<Env, Val>) -> usize {
    xdr_bytes(env, val).len()
}

fn level_with_slots(env: &Env, n: u32) -> Level {
    let mut level = Level {
        generation: u32::MAX,
        head_seq: u32::MAX,
        tail_seq: u32::MAX,
        head_consumed_lots: u64::MAX,
        open_lots: u64::MAX,
        slots: soroban_sdk::Vec::new(env),
    };
    for i in 0..n {
        level.set_slot(i, u64::MAX);
    }
    level
}

#[test]
fn level_under_budget_at_max_occupancy() {
    let env = super::env();
    let n = xdr_len(&env, level_with_slots(&env, INLINE_SLOTS));
    assert!(n <= BUDGET_LEVEL, "Level XDR {n} > {BUDGET_LEVEL}");
}

/// The occupancy-sized vec is the design point (ADR-036): an empty or
/// one-order level must be far below the max-occupancy size, or the sparse
/// book pays the deep-book price.
#[test]
fn level_size_scales_with_occupancy() {
    let env = super::env();
    let empty = xdr_len(&env, Level::empty(&env));
    let one = xdr_len(&env, level_with_slots(&env, 1));
    let full = xdr_len(&env, level_with_slots(&env, INLINE_SLOTS));
    std::println!("Level XDR: empty={empty} one_slot={one} full={full}");
    assert!(empty <= 200, "empty Level XDR {empty} > 200");
    assert_eq!(one - empty, 12, "one u64 slot is 12 XDR bytes");
    assert_eq!(full - empty, 12 * INLINE_SLOTS as usize);
}

#[test]
fn level_page_under_budget_at_max_occupancy() {
    let env = super::env();
    let mut page = LevelPage::empty(&env);
    for i in 0..PAGE_SLOTS {
        page.set_slot(i, u64::MAX);
    }
    let n = xdr_len(&env, page);
    assert!(
        n <= BUDGET_LEVEL_PAGE,
        "LevelPage XDR {n} > {BUDGET_LEVEL_PAGE}"
    );
    let empty = xdr_len(&env, LevelPage::empty(&env));
    assert!(empty <= 50, "empty LevelPage XDR {empty} > 50");
}

#[test]
fn best_tick_under_budget() {
    let env = super::env();
    let best = BestTick {
        empty: true,
        tick: u32::MAX,
    };
    let n = xdr_len(&env, best);
    assert!(
        n <= BUDGET_BEST_TICK,
        "BestTick XDR {n} > {BUDGET_BEST_TICK}"
    );
}

#[test]
fn tick_bitmaps_under_budget() {
    let env = super::env();
    let mut bm = TickBitmap::default();
    for i in 0..2048u32 {
        bm.set(i);
    }
    let bytes = BytesN::<BITMAP_BYTES>::from_array(&env, &bm.bits);
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
    let n = xdr_len(&env, config);
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
    let n = xdr_len(&env, market);
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
    // every key is small (it counts toward footprint bytes on every tx) and no
    // two distinct keys collide when XDR-encoded
    let mut seen: std::vec::Vec<std::vec::Vec<u8>> = std::vec::Vec::new();
    for key in keys {
        let bytes = xdr_bytes(&env, key);
        assert!(bytes.len() <= 120, "DataKey XDR {} B", bytes.len());
        assert!(
            !seen.contains(&bytes),
            "distinct DataKeys must encode distinctly"
        );
        seen.push(bytes);
    }
}

#[test]
fn contract_registers() {
    let env = super::env();
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let _id = env.register(PageBook, (&admin, &recipient));
}
