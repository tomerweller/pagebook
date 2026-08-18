#![allow(deprecated)]

use soroban_sdk::{symbol_short, Address, Env, Symbol};

pub fn rested(
    env: &Env,
    market: u32,
    owner: &Address,
    nonce: u64,
    is_bid: bool,
    tick: u32,
    generation: u32,
    seq: u32,
) {
    env.events().publish(
        (symbol_short!("rested"), market),
        (owner.clone(), nonce, is_bid, tick, generation, seq),
    );
}

/// `is_bid` is the side of the level that was consumed (the makers' side), as
/// for `swept`; the taker is on the other side.
pub fn filled(env: &Env, market: u32, is_bid: bool, tick: u32, lots: u64, quote: i128) {
    env.events().publish(
        (symbol_short!("filled"), market),
        (is_bid, tick, lots, quote),
    );
}

pub fn swept(env: &Env, market: u32, is_bid: bool, tick: u32, generation: u32) {
    env.events()
        .publish((symbol_short!("swept"), market), (is_bid, tick, generation));
}

pub fn settled(
    env: &Env,
    market: u32,
    owner: &Address,
    nonce: u64,
    filled_lots: u64,
    refunded_lots: u64,
) {
    env.events().publish(
        (symbol_short!("settled"), market),
        (owner.clone(), nonce, filled_lots, refunded_lots),
    );
}

pub fn top_changed(env: &Env, market: u32, is_bid: bool, old: u32, new: u32) {
    env.events().publish(
        (Symbol::new(env, "top_changed"), market),
        (is_bid, old, new),
    );
}
