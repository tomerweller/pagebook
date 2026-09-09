use crate::{Config, DataKey, PageBook};
use pagebook_types::{
    BestTick, FeeAccrual, Level, Market, Order, TickBitmap, BITMAP_BYTES, BUDGET_BEST_TICK,
    BUDGET_CONFIG, BUDGET_FEE_ACCRUAL, BUDGET_LEVEL, BUDGET_MARKET, BUDGET_ORDER,
    BUDGET_TICK_BITMAP, LEVEL_CAP, LEVEL_CAP_MAX,
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
        open_lots: u64::MAX,
        slots: soroban_sdk::Vec::new(env),
    };
    for _ in 0..n {
        level.push_slot(u64::MAX);
    }
    level
}

#[test]
fn level_under_budget_at_default_cap() {
    let env = super::env();
    let n = xdr_len(&env, level_with_slots(&env, LEVEL_CAP));
    assert!(n <= BUDGET_LEVEL, "Level XDR {n} > {BUDGET_LEVEL}");
}

/// The occupancy-sized vector is the design point (ADR-036, ADR-037): the
/// entry is 124 B empty and grows 12 B per slot, so a sparse level stays small
/// and only a deep queue approaches the budget. Pinned at 0, 1, 32 and 64.
#[test]
fn level_size_scales_with_occupancy() {
    let env = super::env();
    let empty = xdr_len(&env, Level::empty(&env));
    let one = xdr_len(&env, level_with_slots(&env, 1));
    let thirty_two = xdr_len(&env, level_with_slots(&env, 32));
    let full = xdr_len(&env, level_with_slots(&env, LEVEL_CAP));
    let max = xdr_len(&env, level_with_slots(&env, LEVEL_CAP_MAX));
    std::println!("Level XDR: empty={empty} one={one} 32={thirty_two} 64={full} 128={max}");
    assert_eq!(empty, 124);
    assert_eq!(one, 136);
    assert_eq!(thirty_two, 508);
    assert_eq!(full, 892);
    assert_eq!(max, 1_660);
    // The heaviest legal shape at LEVEL_CAP_MAX: 40 Levels at cap plus the
    // fixed part of a fresh-tick batch must fit the per-tx write-byte cap.
    let on_ledger = max as u32 + 108;
    assert!(40 * on_ledger + 21_320 <= 132_096);
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
        level_cap: u32::MAX,
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
