use crate::constants::{INLINE_SLOTS, PAGE_SLOTS};
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
    pub inline_slots: u32,
    pub page_slots: u32,
    pub max_pages: u32,
}

/// One price level's FIFO queue (architecture §2): counters plus the inline
/// quantity slots. `slots` is occupancy-sized — `slots.len() ==
/// min(tail_seq, INLINE_SLOTS)` — so a sparse or freshly swept level is a
/// small entry and only a deep queue approaches the budget (ADR-036). Slot
/// `s` lives at index `s`; seq is implicit in position.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Level {
    pub generation: u32,
    pub head_seq: u32,
    pub tail_seq: u32,
    pub head_consumed_lots: u64,
    pub open_lots: u64,
    pub slots: Vec<u64>,
}

impl Level {
    pub fn empty(env: &Env) -> Self {
        Self {
            generation: 0,
            head_seq: 0,
            tail_seq: 0,
            head_consumed_lots: 0,
            open_lots: 0,
            slots: Vec::new(env),
        }
    }

    /// Quantity at inline slot `s`; a slot the vec does not hold reads as a
    /// tombstone (zero), never a panic.
    pub fn slot(&self, s: u32) -> u64 {
        slot_get(&self.slots, s)
    }

    /// Write inline slot `s`, growing the vec when `s` is the next position.
    pub fn set_slot(&mut self, s: u32, qty: u64) {
        slot_set(&mut self.slots, s, qty, INLINE_SLOTS);
    }

    /// Drop every inline slot (a sweep or reset-on-rest starts a generation
    /// with an empty queue).
    pub fn clear_slots(&mut self, env: &Env) {
        self.slots = Vec::new(env);
    }
}

/// Overflow slots for one level (architecture §2), occupancy-sized like the
/// inline slots: page `p` holds seqs `INLINE_SLOTS + p·PAGE_SLOTS …` and its
/// vec is as long as the queue has reached into it this generation.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LevelPage {
    pub slots: Vec<u64>,
}

impl LevelPage {
    pub fn empty(env: &Env) -> Self {
        Self {
            slots: Vec::new(env),
        }
    }

    pub fn slot(&self, i: u32) -> u64 {
        slot_get(&self.slots, i)
    }

    pub fn set_slot(&mut self, i: u32, qty: u64) {
        slot_set(&mut self.slots, i, qty, PAGE_SLOTS);
    }
}

fn slot_get(slots: &Vec<u64>, i: u32) -> u64 {
    slots.get(i).unwrap_or(0)
}

/// Positional write that keeps `len == occupancy`: an index inside the vec is
/// overwritten, the next index is appended, and a gap (which the append
/// discipline never produces) is zero-filled up to `cap` so the position stays
/// addressable without panicking.
fn slot_set(slots: &mut Vec<u64>, i: u32, qty: u64, cap: u32) {
    let i = core::cmp::min(i, cap.saturating_sub(1));
    while slots.len() < i {
        slots.push_back(0);
    }
    if i < slots.len() {
        slots.set(i, qty);
    } else {
        slots.push_back(qty);
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
    fn slots_grow_by_append_and_overwrite_in_place() {
        let env = Env::default();
        let mut level = Level::empty(&env);
        assert_eq!(level.slots.len(), 0);
        assert_eq!(level.slot(0), 0);
        level.set_slot(0, 10);
        level.set_slot(1, 20);
        assert_eq!(level.slots.len(), 2);
        level.set_slot(0, 0);
        assert_eq!(
            level.slots.len(),
            2,
            "a tombstone does not change occupancy"
        );
        assert_eq!(level.slot(0), 0);
        assert_eq!(level.slot(1), 20);
        assert_eq!(level.slot(5), 0, "past the vec reads as zero");
        level.clear_slots(&env);
        assert_eq!(level.slots.len(), 0);
    }

    #[test]
    fn a_gap_is_zero_filled_and_the_cap_holds() {
        let env = Env::default();
        let mut page = LevelPage::empty(&env);
        page.set_slot(3, 7);
        assert_eq!(page.slots.len(), 4);
        assert_eq!(page.slot(2), 0);
        assert_eq!(page.slot(3), 7);
        page.set_slot(PAGE_SLOTS + 10, 1);
        assert_eq!(page.slots.len(), PAGE_SLOTS);
        assert_eq!(page.slot(PAGE_SLOTS - 1), 1);
    }
}
