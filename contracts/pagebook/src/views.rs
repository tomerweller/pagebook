use crate::errors::Error;
use crate::iface::{LevelInfo, OrderInfo};
use crate::level;
use crate::store;
use soroban_sdk::{Address, Env};

pub fn best(env: &Env, market: u32, is_bid: bool) -> Option<u32> {
    let b = store::load_best(env, market, is_bid);
    if b.empty {
        None
    } else {
        Some(b.tick)
    }
}

pub fn level(env: &Env, market: u32, is_bid: bool, tick: u32) -> LevelInfo {
    let lvl = store::load_level(env, market, is_bid, tick);
    LevelInfo {
        generation: lvl.generation,
        head_seq: lvl.head_seq,
        tail_seq: lvl.tail_seq,
        head_consumed_lots: lvl.head_consumed_lots,
        open_lots: lvl.open_lots,
    }
}

pub fn order(env: &Env, market: u32, owner: Address, nonce: u64) -> OrderInfo {
    let o = store::load_order(env, market, &owner, nonce)
        .unwrap_or_else(|| env.panic_with_error(Error::UnknownOrder));
    let lvl = store::load_level(env, market, o.is_bid, o.tick);
    let (filled_lots, refund_lots) = level::preview_settle(o.generation, o.seq, o.qty_lots, &lvl);
    OrderInfo {
        is_bid: o.is_bid,
        tick: o.tick,
        generation: o.generation,
        seq: o.seq,
        qty_lots: o.qty_lots,
        filled_lots,
        refund_lots,
    }
}
