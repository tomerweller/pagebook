use soroban_sdk::{contracttype, Address};

/// Venue configuration (architecture §1). Instance storage; a plain named
/// struct — its rent rides on the instance TTL the `keepalive` crank pays, so
/// the map encoding's extra bytes cost nothing that matters (ADR-022).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub fee_recipient: Address,
    pub paused: bool,
    pub market_counter: u32,
}

/// Per-market parameters (architecture §1). Written at creation and by
/// `set_market_caps` only, read (free) by every op: a named struct, not a
/// packed body — one-time rent per market is the only cost (ADR-022).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Market {
    pub base: Address,
    pub quote: Address,
    pub lot_size: u64,
    pub tick_size: u64,
    pub tick_min: u32,
    pub tick_max: u32,
    pub taker_fee_bps: u32,
    pub min_order_lots: u64,
    pub max_order_lots: u64,
    pub max_levels_crossed: u32,
    pub max_slots_scanned: u32,
    pub inline_slots: u32,
    pub page_slots: u32,
    pub max_pages: u32,
}

/// Best tick per side (architecture §5): `empty` set means no recorded best.
/// Written on most takes and many rests, but at ~56 B the map encoding costs
/// tens of stroops per write; readability wins (ADR-022).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BestTick {
    pub empty: bool,
    pub tick: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    pub is_bid: bool,
    pub tick: u32,
    pub generation: u32,
    pub seq: u32,
    pub qty_lots: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeAccrual {
    pub accrued: i128,
}
