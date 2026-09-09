use crate::keys::DataKey;
use soroban_sdk::{contracttype, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlaceFlags {
    pub post_only: bool,
    pub fill_or_kill: bool,
    pub no_rest: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplaceItem {
    pub nonce: u64,
    pub is_bid: bool,
    pub tick: u32,
    pub qty_lots: u64,
}

/// The `level` view (architecture §11): the counters and the queue depth
/// (`slots.len()`, the next seq to be assigned).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LevelInfo {
    pub generation: u32,
    pub head_seq: u32,
    pub depth: u32,
    pub open_lots: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderInfo {
    pub is_bid: bool,
    pub tick: u32,
    pub generation: u32,
    pub seq: u32,
    pub qty_lots: u64,
    pub filled_lots: u64,
    pub refund_lots: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlaceLeg {
    pub market: u32,
    pub is_bid: bool,
    pub limit_tick: u32,
    pub qty_lots: u64,
    pub start_tick: u32,
    pub nonce: u64,
    pub flags: PlaceFlags,
}

impl PlaceFlags {
    pub fn none() -> Self {
        Self {
            post_only: false,
            fill_or_kill: false,
            no_rest: false,
        }
    }
}

/// One level the simulated walk visited, with its open lots at simulation.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CrossedLevel {
    pub tick: u32,
    pub open_lots: u64,
}

/// `quote_place` output: the simulate step of the client protocol (§14). `keys`
/// is every PageBook key the walk and a possible rest can touch on both sides
/// (band levels visited, words start..limit, summaries, bests, own-side rest
/// keys, fee accruals); the client adds `Order(taker, nonce)`, both vault
/// balances, the pad band, and marks archived keys for restore from RPC
/// (ADR-020).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QuoteResult {
    pub start_tick: u32,
    pub crossed: Vec<CrossedLevel>,
    pub filled_lots: u64,
    pub quote_atoms: i128,
    pub keys: Vec<DataKey>,
}
