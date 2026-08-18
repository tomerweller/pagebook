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
pub struct PageRange {
    pub first: u32,
    pub last: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConsumeWindow {
    pub tick: u32,
    pub pages: PageRange,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlotWindow {
    pub consume: Vec<ConsumeWindow>,
    pub append: PageRange,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplaceItem {
    pub nonce: u64,
    pub is_bid: bool,
    pub tick: u32,
    pub qty_lots: u64,
    pub window: SlotWindow,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LevelInfo {
    pub generation: u32,
    pub head_seq: u32,
    pub tail_seq: u32,
    pub head_consumed_lots: u64,
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
    pub window: SlotWindow,
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

impl PageRange {
    pub fn contains(&self, page: u32) -> bool {
        page >= self.first && page <= self.last
    }
}

pub fn default_append() -> PageRange {
    PageRange { first: 0, last: 1 }
}

/// One level the simulated walk visited, with its head position at simulation
/// (the client's consume window is pages `[page(head_seq), page(head_seq)+1]`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CrossedLevel {
    pub tick: u32,
    pub head_seq: u32,
    pub open_lots: u64,
}

/// `quote_place` output: the simulate step of the client protocol (§14). `keys`
/// is every PageBook key the walk and a possible rest can touch on both sides
/// (band levels visited, words start..limit, summaries, bests, own-side rest
/// keys, fee accruals); the client adds `Order(taker, nonce)`, both vault
/// balances, the pad band, and consume/append page windows, and marks archived
/// keys for restore from RPC (ADR-020).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QuoteResult {
    pub start_tick: u32,
    pub crossed: Vec<CrossedLevel>,
    pub filled_lots: u64,
    pub quote_atoms: i128,
    pub tail_seq: u32,
    pub keys: Vec<DataKey>,
}

/// Structural validation shared by every entry point that takes a window
/// (BadWindow): at most one consume entry per crossable level, ranges ordered.
pub fn validate_window(env: &soroban_sdk::Env, m: &pagebook_types::Market, w: &SlotWindow) {
    if w.consume.len() > m.max_levels_crossed {
        env.panic_with_error(crate::errors::Error::BadWindow);
    }
    if w.append.first > w.append.last {
        env.panic_with_error(crate::errors::Error::BadWindow);
    }
    for c in w.consume.iter() {
        if c.pages.first > c.pages.last {
            env.panic_with_error(crate::errors::Error::BadWindow);
        }
    }
}

pub fn empty_window(env: &soroban_sdk::Env) -> SlotWindow {
    SlotWindow {
        consume: Vec::new(env),
        append: default_append(),
    }
}
