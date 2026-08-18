//! Resource-fee gates against architecture §17 (M4 item 3, ADR-024).
//!
//! `env.cost_estimate().fee()` uses the soroban-sdk 27.0.6 snapshot of Stellar
//! mainnet rates from 2026-07-10:
//!   fee_per_write_entry            2,500
//!   fee_per_write_1kb                875
//!   fee_per_instruction_increment      7 (per 10k)
//!   fee_per_contract_event_1kb     5,000
//!   fee_per_transaction_size_1kb     406 (not modelled by InvocationResources)
//!   persistent rent denominator    1,215
//!   fee_per_rent_1kb              12,000  (deliberately inflated vs the live
//!                                         1,000/KB floor §17 assumes)
//!
//! Every gate first sets the test ledger's TTLs to mainnet's (minimum persistent
//! 2,073,600 ledgers, maximum 3,110,400), because rent is charged per ledger of
//! TTL: at the test host's default 4,096-ledger minimum the rent figures are
//! ~500× too small and the gate cannot fail. Rent is then rescaled by
//! 1,000/12,000 so it is comparable with §17's 1,667 stroops per byte per
//! 120-day minimum. Rent is charged on the FULL ledger entry (payload + key +
//! ~56 B framing), which is why §17's per-entry rent table (post ADR-024) is
//! higher than a payload-only estimate.
//!
//! The execution slice compared with §17 is instructions + write_entries +
//! write_bytes + contract_events. `total − persistent_entry_rent` is not
//! comparable: the snapshot still charges disk-read fees on live writes (P23
//! live reads are free) and the test host bills temporary_entry_rent for the
//! auth nonce on authenticated calls. A native test contract does not model wasm
//! instantiation, so the instruction component is a lower bound.
//!
//! Gates are the corrected §17 rows (measured at calibration) × 1.25.

extern crate std;

use super::harness::{flags, mint, rest_ask, setup, window};
use crate::{PlaceFlags, ReplaceItem};
use pagebook_types::WORD_TICKS;
use soroban_sdk::{testutils::Address as _, Address, Env};

const RENT_RESCALE_NUM: i64 = 1_000;
const RENT_RESCALE_DEN: i64 = 12_000;

fn no_rest() -> PlaceFlags {
    PlaceFlags {
        post_only: false,
        fill_or_kill: false,
        no_rest: true,
    }
}

/// Set the ledger to mainnet TTLs so created entries pay 120-day rent.
fn mainnet_ttls(env: &Env) {
    use soroban_sdk::testutils::Ledger as _;
    env.ledger().set_min_persistent_entry_ttl(2_073_600);
    env.ledger().set_max_entry_ttl(3_110_400);
}

/// `exec_row` and `rent_row` are the corrected §17 figures in stroops (the
/// execution slice, and persistent rent at the 1,000/KB floor over the 120-day
/// minimum). Both are gated at ×1.25; a `rent_row` of 0 asserts zero rent.
fn gate(name: &str, env: &Env, exec_row: i64, rent_row: i64) {
    let fee = env.cost_estimate().fee();
    let exec = fee
        .instructions
        .saturating_add(fee.write_entries)
        .saturating_add(fee.write_bytes)
        .saturating_add(fee.contract_events);
    let rent = fee.persistent_entry_rent * RENT_RESCALE_NUM / RENT_RESCALE_DEN;
    let exec_gate = exec_row.saturating_mul(5) / 4;
    let rent_gate = rent_row.saturating_mul(5) / 4;
    std::println!(
        "fee[{name}]: total={} instructions={} disk_read_entries={} write_entries={} disk_read_bytes={} write_bytes={} contract_events={} persistent_entry_rent={} temporary_entry_rent={} exec={} rent_rescaled={} (rows: exec {exec_row}, rent {rent_row}; gates {exec_gate} / {rent_gate})",
        fee.total,
        fee.instructions,
        fee.disk_read_entries,
        fee.write_entries,
        fee.disk_read_bytes,
        fee.write_bytes,
        fee.contract_events,
        fee.persistent_entry_rent,
        fee.temporary_entry_rent,
        exec,
        rent
    );
    assert!(
        exec <= exec_gate,
        "{name}: execution slice {exec} > gate {exec_gate} (§17 row {exec_row})"
    );
    if rent_row == 0 {
        assert_eq!(rent, 0, "{name}: expected zero rent, got {rent}");
    } else {
        assert!(
            rent <= rent_gate,
            "{name}: rescaled rent {rent} > gate {rent_gate} (§17 row {rent_row})"
        );
    }
}

/// Rent per created entry at the 1,000/KB floor over the 120-day minimum
/// (stroops), from the full ledger-entry size (payload + key + framing).
/// §17 "Rent per entry" carries the same numbers.
const RENT_ORDER: i64 = 460_000; // 276 B
const RENT_LEVEL: i64 = 673_000; // 404 B
const RENT_TICK_WORD: i64 = 627_000; // 376 B
const RENT_TICK_SUMMARY: i64 = 620_000; // 372 B
const RENT_BEST_TICK: i64 = 260_000; // 156 B
const RENT_FEE_ACCRUAL: i64 = 307_000; // 184 B
const RENT_MARKET: i64 = 967_000; // 580 B
const RENT_SAC_BALANCE: i64 = 373_000; // 224 B, a caller's first balance in a token

#[test]
fn fee_place_rest_existing_level() {
    let h = setup();
    mainnet_ttls(&h.env);
    let a = Address::generate(&h.env);
    let b = Address::generate(&h.env);
    rest_ask(&h, &a, 10, 2, 1);
    mint(&h, &h.base, &b, 1_000);
    h.client().place(
        &b,
        &h.market,
        &false,
        &10,
        &2,
        &10,
        &1,
        &window(&h),
        &flags(),
    );
    // §17: exec ~16k stroops; rent = one Order.
    gate("place rest existing level", &h.env, 16_000, RENT_ORDER);
}

#[test]
fn fee_place_rest_new_level() {
    let h = setup();
    mainnet_ttls(&h.env);
    let a = Address::generate(&h.env);
    mint(&h, &h.base, &a, 1_000);
    h.client().place(
        &a,
        &h.market,
        &false,
        &10,
        &2,
        &10,
        &1,
        &window(&h),
        &flags(),
    );
    // Empty book: Order + Level + TickWord + TickSummary + BestTick are created.
    gate(
        "place rest new level (empty book)",
        &h.env,
        25_000,
        RENT_ORDER + RENT_LEVEL + RENT_TICK_WORD + RENT_TICK_SUMMARY + RENT_BEST_TICK,
    );
}

#[test]
fn fee_settle() {
    let h = setup();
    mainnet_ttls(&h.env);
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 2, 1);
    h.client().settle(&maker, &h.market, &1);
    gate("settle", &h.env, 15_500, 0);
}

#[test]
fn fee_replace() {
    let h = setup();
    mainnet_ttls(&h.env);
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 2, 1);
    h.client()
        .replace(&maker, &h.market, &1, &false, &12, &3, &window(&h));
    // replace to a new tick: the Order is reused (no rent) but the new Level is created.
    gate("replace (new tick)", &h.env, 24_000, RENT_LEVEL);
}

#[test]
fn fee_replace_batch_forty() {
    let h = setup();
    mainnet_ttls(&h.env);
    let maker = Address::generate(&h.env);
    for n in 1..=40u64 {
        rest_ask(&h, &maker, 10 + n as u32, 2, n);
    }
    let mut items = soroban_sdk::Vec::new(&h.env);
    for n in 1..=40u64 {
        items.push_back(ReplaceItem {
            nonce: n,
            is_bid: false,
            tick: 100 + n as u32,
            qty_lots: 3,
            window: window(&h),
        });
    }
    h.client().replace_batch(&maker, &h.market, &items);
    // Every quote moves to a fresh tick: 40 Levels created (worst case, §17).
    gate(
        "replace_batch 40 quotes (new ticks)",
        &h.env,
        435_000,
        40 * RENT_LEVEL,
    );
}

#[test]
fn fee_replace_batch_forty_same_tick_refresh_is_rent_free() {
    // The §17 / ADR-005 headline: a 40-quote refresh that re-sizes each quote in
    // place (same tick) creates nothing and pays zero rent (05 M3 gate).
    let h = setup();
    mainnet_ttls(&h.env);
    let maker = Address::generate(&h.env);
    for n in 1..=40u64 {
        rest_ask(&h, &maker, 10 + n as u32, 2, n);
    }
    let mut items = soroban_sdk::Vec::new(&h.env);
    for n in 1..=40u64 {
        items.push_back(ReplaceItem {
            nonce: n,
            is_bid: false,
            tick: 10 + n as u32,
            qty_lots: 3,
            window: window(&h),
        });
    }
    h.client().replace_batch(&maker, &h.market, &items);
    gate(
        "replace_batch 40 quotes (same tick refresh)",
        &h.env,
        315_000,
        0,
    );
}

#[test]
fn fee_place_take_eight_levels() {
    let h = setup();
    mainnet_ttls(&h.env);
    let maker = Address::generate(&h.env);
    for i in 0..8u32 {
        rest_ask(&h, &maker, 10 + i, 1, u64::from(i) + 1);
    }
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
    h.client().place(
        &taker,
        &h.market,
        &true,
        &17,
        &8,
        &10,
        &1,
        &window(&h),
        &no_rest(),
    );
    // take only: the FeeAccrual entry and the taker's first base balance are created
    gate(
        "place take 8 levels",
        &h.env,
        62_500,
        RENT_FEE_ACCRUAL + RENT_SAC_BALANCE,
    );
}

#[test]
fn fee_place_take_eight_then_rest() {
    let h = setup();
    mainnet_ttls(&h.env);
    let maker = Address::generate(&h.env);
    for i in 0..8u32 {
        rest_ask(&h, &maker, 10 + i, 1, u64::from(i) + 1);
    }
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 1_000_000);
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
    );
    // + rest at a new tick on the empty bid side, and the taker's first base balance
    gate(
        "place take 8 levels + rest",
        &h.env,
        78_000,
        RENT_ORDER
            + RENT_LEVEL
            + RENT_TICK_WORD
            + RENT_TICK_SUMMARY
            + RENT_BEST_TICK
            + RENT_FEE_ACCRUAL
            + RENT_SAC_BALANCE,
    );
}

#[test]
fn fee_place_max_take_32() {
    let h = setup();
    mainnet_ttls(&h.env);
    let market = h.client().create_market(
        &h.base,
        &h.quote,
        &1,
        &1,
        &1,
        &(32 * WORD_TICKS),
        &10,
        &1,
        &1_000_000,
    );
    h.client()
        .set_market_caps(&market, &32, &64, &10, &1, &1_000_000, &1);
    let maker = Address::generate(&h.env);
    for w in 0..32u32 {
        mint(&h, &h.base, &maker, 1_000_000_000);
        h.client().place(
            &maker,
            &market,
            &false,
            &(WORD_TICKS * w + 5),
            &1,
            &(WORD_TICKS * w + 5),
            &(u64::from(w) + 1),
            &window(&h),
            &flags(),
        );
    }
    let taker = Address::generate(&h.env);
    mint(&h, &h.quote, &taker, 10_000_000);
    h.client().place(
        &taker,
        &market,
        &true,
        &(WORD_TICKS * 31 + 5),
        &32,
        &5,
        &1,
        &window(&h),
        &no_rest(),
    );
    gate(
        "place max take 32 levels",
        &h.env,
        256_500,
        RENT_FEE_ACCRUAL + RENT_SAC_BALANCE,
    );
}

#[test]
fn fee_create_market() {
    let h = setup();
    mainnet_ttls(&h.env);
    h.client()
        .create_market(&h.base, &h.quote, &1, &1, &1, &1000, &10, &1, &1_000_000);
    gate("create_market", &h.env, 8_500, RENT_MARKET);
}

#[test]
fn fee_collect_fees() {
    let h = setup();
    mainnet_ttls(&h.env);
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
    h.client().collect_fees(&h.market, &h.base);
    gate("collect_fees", &h.env, 9_500, RENT_SAC_BALANCE);
}
