//! Resource-fee gates against architecture §17 (M4 item 3).
//!
//! `env.cost_estimate().fee()` uses the soroban-sdk 27.0.6 snapshot of Stellar
//! mainnet rates from 2026-07-10:
//!   fee_per_write_entry            2,500
//!   fee_per_write_1kb                875
//!   fee_per_instruction_increment      7 (per 10k)
//!   fee_per_contract_event_1kb     5,000
//!   fee_per_transaction_size_1kb     406
//!   persistent rent denominator    1,215
//!   fee_per_rent_1kb              12,000  (deliberately inflated vs the live
//!                                         1,000/KB floor §17 assumes)
//!
//! Rent is rescaled by 1,000/12,000 before comparison with a named §17 rent
//! component. A native test contract does not model wasm instantiation, so the
//! instruction component is a lower bound. Tx-size fees are also omitted by
//! InvocationResources.
//!
//! `total − persistent_entry_rent` is not comparable to §17: the snapshot
//! charges disk-read fees on live writes (P23 live reads are free) and the
//! test host bills a flat ~2.19e6 stroops of temporary_entry_rent on
//! authenticated calls. Non-rent here is the execution slice §17 prices:
//! instructions + write_entries + write_bytes + contract_events. The test
//! host's persistent TTL is not the 120-day minimum, so rescaled
//! persistent_entry_rent is far below a mainnet create; the rent assertion
//! still runs as specified.

extern crate std;

use super::harness::{flags, mint, rest_ask, setup, window};
use crate::{PlaceFlags, ReplaceItem};
use pagebook_types::WORD_TICKS;
use soroban_sdk::{testutils::Address as _, Address, Env};

const STROOPS_PER_XLM: i64 = 10_000_000;
const RENT_RESCALE_NUM: i64 = 1_000;
const RENT_RESCALE_DEN: i64 = 12_000;

fn no_rest() -> PlaceFlags {
    PlaceFlags {
        post_only: false,
        fill_or_kill: false,
        no_rest: true,
    }
}

fn xlm_stroops(xlm_millionths: i64) -> i64 {
    // 29_000 means 0.029 XLM.
    xlm_millionths * STROOPS_PER_XLM / 1_000_000
}

fn gate(name: &str, env: &Env, row_xlm_millionths: i64, rent_xlm_millionths: Option<i64>) {
    let fee = env.cost_estimate().fee();
    // Execution slice: what §17 means by the non-rent part of a row.
    let non_rent = fee
        .instructions
        .saturating_add(fee.write_entries)
        .saturating_add(fee.write_bytes)
        .saturating_add(fee.contract_events);
    let rent_rescaled = fee.persistent_entry_rent * RENT_RESCALE_NUM / RENT_RESCALE_DEN;
    let row = xlm_stroops(row_xlm_millionths);
    let non_rent_gate = row.saturating_mul(3) / 2;
    std::println!(
        "fee[{name}]: total={} instructions={} disk_read_entries={} write_entries={} disk_read_bytes={} write_bytes={} contract_events={} persistent_entry_rent={} temporary_entry_rent={} total_minus_persistent={} exec_non_rent={} rent_rescaled={} (§17 row {} stroops, non-rent gate {}, rent named {:?})",
        fee.total,
        fee.instructions,
        fee.disk_read_entries,
        fee.write_entries,
        fee.disk_read_bytes,
        fee.write_bytes,
        fee.contract_events,
        fee.persistent_entry_rent,
        fee.temporary_entry_rent,
        fee.total - fee.persistent_entry_rent,
        non_rent,
        rent_rescaled,
        row,
        non_rent_gate,
        rent_xlm_millionths
    );
    assert!(
        non_rent <= non_rent_gate,
        "{name}: non-rent {non_rent} > §17×1.5 gate {non_rent_gate} (total {}, rent {})",
        fee.total,
        fee.persistent_entry_rent
    );
    if let Some(named) = rent_xlm_millionths {
        let rent_gate = xlm_stroops(named).saturating_mul(3) / 2;
        assert!(
            rent_rescaled <= rent_gate,
            "{name}: rescaled rent {rent_rescaled} > §17 rent×1.5 gate {rent_gate}"
        );
    }
}

#[test]
fn fee_place_rest_existing_level() {
    let h = setup();
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
    // Order rent 0.027 of the 0.029 row.
    gate("place rest existing level", &h.env, 29_000, Some(27_000));
}

#[test]
fn fee_place_rest_new_level() {
    let h = setup();
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
    // Order 0.027 + Level 0.064 of the 0.094 row.
    gate("place rest new level", &h.env, 94_000, Some(91_000));
}

#[test]
fn fee_settle() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 2, 1);
    h.client().settle(&maker, &h.market, &1);
    gate("settle", &h.env, 2_000, None);
}

#[test]
fn fee_replace() {
    let h = setup();
    let maker = Address::generate(&h.env);
    rest_ask(&h, &maker, 10, 2, 1);
    h.client()
        .replace(&maker, &h.market, &1, &false, &12, &3, &window(&h));
    gate("replace", &h.env, 3_000, None);
}

#[test]
fn fee_replace_batch_forty() {
    let h = setup();
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
    gate("replace_batch 40 quotes", &h.env, 30_000, None);
}

#[test]
fn fee_place_take_eight_levels() {
    let h = setup();
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
    gate("place take 8 levels", &h.env, 9_000, None);
}

#[test]
fn fee_place_take_eight_then_rest() {
    let h = setup();
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
    // Remainder Order rent 0.027 of the 0.037 row.
    gate("place take 8 levels + rest", &h.env, 37_000, Some(27_000));
}

#[test]
fn fee_place_max_take_32() {
    let h = setup();
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
    gate("place max take 32 levels", &h.env, 27_000, None);
}

#[test]
fn fee_create_market() {
    let h = setup();
    h.client()
        .create_market(&h.base, &h.quote, &1, &1, &1, &1000, &10, &1, &1_000_000);
    // Market rent dominates the post-ADR-022 0.085 row.
    gate("create_market", &h.env, 85_000, Some(82_000));
}

#[test]
fn fee_collect_fees() {
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
    h.client().collect_fees(&h.market, &h.base);
    gate("collect_fees", &h.env, 1_000, None);
}
