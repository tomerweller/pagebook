#![no_std]
#![allow(clippy::too_many_arguments)]

mod admin;
mod errors;
mod events;
mod iface;
mod keys;
mod level;
mod market;
mod matching;
mod math;
mod replace;
mod rest;
mod settle;
mod store;
mod views;

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env};

pub use errors::Error;
pub use iface::{
    empty_window, ConsumeWindow, LevelInfo, OrderInfo, PageRange, PlaceFlags, PlaceLeg,
    ReplaceItem, SlotWindow,
};
pub use keys::{DataKey, MAX_ENTRY_TTL, MIN_PERSISTENT_TTL};
pub use pagebook_types::{Config, MarketId};

#[cfg(test)]
mod tests;

#[contract]
pub struct PageBook;

#[contractimpl]
impl PageBook {
    pub fn __constructor(env: Env, admin: Address, fee_recipient: Address) {
        admin::construct(&env, admin, fee_recipient);
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        admin::set_admin(&env, new_admin);
    }

    pub fn set_fee_recipient(env: Env, recipient: Address) {
        admin::set_fee_recipient(&env, recipient);
    }

    pub fn set_paused(env: Env, paused: bool) {
        admin::set_paused(&env, paused);
    }

    pub fn upgrade(env: Env, wasm_hash: BytesN<32>) {
        admin::upgrade(&env, wasm_hash);
    }

    pub fn keepalive(env: Env) {
        admin::keepalive(&env);
    }

    pub fn set_market_caps(
        env: Env,
        market: u32,
        max_levels_crossed: u32,
        max_slots_scanned: u32,
        taker_fee_bps: u32,
        min_order_lots: u64,
        max_order_lots: u64,
        max_pages: u32,
    ) {
        market::set_market_caps(
            &env,
            market,
            max_levels_crossed,
            max_slots_scanned,
            taker_fee_bps,
            min_order_lots,
            max_order_lots,
            max_pages,
        );
    }

    pub fn create_market(
        env: Env,
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
        market::create_market(
            &env,
            base,
            quote,
            lot_size,
            tick_size,
            tick_min,
            tick_max,
            taker_fee_bps,
            min_order_lots,
            max_order_lots,
        )
    }

    pub fn place(
        env: Env,
        taker: Address,
        market: u32,
        is_bid: bool,
        limit_tick: u32,
        qty_lots: u64,
        start_tick: u32,
        nonce: u64,
        window: SlotWindow,
        flags: PlaceFlags,
    ) -> (bool, u64, i128) {
        matching::place(
            &env, taker, market, is_bid, limit_tick, qty_lots, start_tick, nonce, window, flags,
        )
    }

    pub fn settle(env: Env, owner: Address, market: u32, nonce: u64) -> (i128, i128) {
        replace::do_settle(&env, owner, market, nonce)
    }

    pub fn replace(
        env: Env,
        owner: Address,
        market: u32,
        nonce: u64,
        is_bid: bool,
        tick: u32,
        qty_lots: u64,
        window: SlotWindow,
    ) -> (i128, i128) {
        replace::replace(&env, owner, market, nonce, is_bid, tick, qty_lots, window)
    }

    pub fn best(env: Env, market: u32, is_bid: bool) -> Option<u32> {
        views::best(&env, market, is_bid)
    }

    pub fn level(env: Env, market: u32, is_bid: bool, tick: u32) -> LevelInfo {
        views::level(&env, market, is_bid, tick)
    }

    pub fn order(env: Env, market: u32, owner: Address, nonce: u64) -> OrderInfo {
        views::order(&env, market, owner, nonce)
    }

    pub fn collect_fees(env: Env, market: u32, token: Address) -> i128 {
        settle::collect_fees(&env, market, token)
    }
}
