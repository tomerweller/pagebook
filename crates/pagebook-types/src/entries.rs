use soroban_sdk::{contracttype, Address, Env, Vec};

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
    pub level_cap: u32,
}

/// One price level's FIFO queue (architecture §2): counters plus the quantity
/// slots of the current generation, all in one entry (ADR-037). `slots.len()`
/// is the tail: appends push, a sweep or empty-level reset empties the vector,
/// so every held slot is meaningful and the entry is exactly as large as the
/// queue is deep (124 B empty, 12 B per slot). Slot `s` lives at index `s`.
/// A slot holds the order's *open* lots: a partial take decrements the head
/// slot in place, and a zero slot, whether a cancel or consumption put it
/// there, is skipped.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Level {
    pub generation: u32,
    pub head_seq: u32,
    pub open_lots: u64,
    pub slots: Vec<u64>,
}

impl Level {
    pub fn empty(env: &Env) -> Self {
        Self {
            generation: 0,
            head_seq: 0,
            open_lots: 0,
            slots: Vec::new(env),
        }
    }

    /// First seq not yet assigned this generation.
    pub fn tail(&self) -> u32 {
        self.slots.len()
    }

    /// Open lots at slot `s`; a slot the vector does not hold reads as zero,
    /// never a panic.
    pub fn slot(&self, s: u32) -> u64 {
        self.slots.get(s).unwrap_or(0)
    }

    /// Overwrite a held slot (a tombstone, or the head after a partial take).
    /// A position past the tail is not held and the write is dropped; the
    /// append discipline never produces one.
    pub fn set_slot(&mut self, s: u32, qty: u64) {
        if s < self.slots.len() {
            self.slots.set(s, qty);
        }
    }

    /// Append the next slot and return its seq.
    pub fn push_slot(&mut self, qty: u64) -> u32 {
        let seq = self.slots.len();
        self.slots.push_back(qty);
        seq
    }

    /// Drop every slot (a sweep or reset-on-rest starts a generation with an
    /// empty queue).
    pub fn clear_slots(&mut self, env: &Env) {
        self.slots = Vec::new(env);
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_push_overwrite_and_clear() {
        let env = Env::default();
        let mut level = Level::empty(&env);
        assert_eq!(level.tail(), 0);
        assert_eq!(level.slot(0), 0, "past the tail reads as zero");
        assert_eq!(level.push_slot(10), 0);
        assert_eq!(level.push_slot(20), 1);
        assert_eq!(level.tail(), 2);
        level.set_slot(0, 0);
        assert_eq!(level.tail(), 2, "a tombstone does not change the tail");
        assert_eq!(level.slot(0), 0);
        assert_eq!(level.slot(1), 20);
        level.set_slot(5, 7);
        assert_eq!(level.tail(), 2, "a write past the tail is dropped");
        assert_eq!(level.slot(5), 0);
        level.clear_slots(&env);
        assert_eq!(level.tail(), 0);
    }
}
