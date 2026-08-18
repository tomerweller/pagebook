pub const INLINE_SLOTS: u32 = 32;
pub const PAGE_SLOTS: u32 = 32;
pub const MAX_PAGES: u32 = 1;
pub const MAX_LEVELS_CROSSED: u32 = 32;
pub const MAX_SLOTS_SCANNED: u32 = 64;
pub const MAX_ROUTE_LEGS: u32 = 4;
pub const MAX_REPLACE_BATCH: u32 = 64;
pub const FEE_BPS_MAX: u32 = 1_000;
pub const FEE_BPS_DENOM: i128 = 10_000;
pub const WORD_TICKS: u32 = 2048;
pub const SUMMARY_WORDS: u32 = 2048;
pub const TICK_INDEX_SPAN: u32 = WORD_TICKS * SUMMARY_WORDS;
pub const PACKED_VERSION: u8 = 1;
pub const BEST_TICK_EMPTY_BIT: u8 = 1;
pub const BITMAP_BYTES: usize = 256;

pub const LEVEL_HEADER_BYTES: usize = 1 + 4 + 4 + 4 + 8 + 8;
pub const LEVEL_BYTES: usize = LEVEL_HEADER_BYTES + (INLINE_SLOTS as usize) * 8;
pub const LEVEL_PAGE_BYTES: usize = 1 + (PAGE_SLOTS as usize) * 8;
pub const BEST_TICK_BYTES: usize = 1 + 1 + 4;
pub const TICK_BITMAP_BYTES: usize = 1 + BITMAP_BYTES;

pub const BUDGET_CONFIG: usize = 150;
pub const BUDGET_MARKET: usize = 250;
pub const BUDGET_LEVEL: usize = 384;
pub const BUDGET_LEVEL_PAGE: usize = 320;
pub const BUDGET_ORDER: usize = 160;
pub const BUDGET_FEE_ACCRUAL: usize = 50;
pub const BUDGET_BEST_TICK: usize = 40;
pub const BUDGET_TICK_BITMAP: usize = 268;
pub const MARKET_BODY_BYTES: usize = 1 + 8 + 8 + 4 + 4 + 4 + 8 + 8 + 4 + 4 + 4 + 4 + 4;

// The §0.3 creation bound reserves 4 × MAX_ROUTE_LEGS of headroom for summed
// per-token flows; a replace_batch sums up to MAX_REPLACE_BATCH escrows and only
// fits because each escrow is bounded by i128::MAX / (16 × LEVEL_CAP) with
// LEVEL_CAP ≥ MAX_REPLACE_BATCH (ADR-021). Keep that relation explicit.
const _: () = assert!(MAX_REPLACE_BATCH <= INLINE_SLOTS + PAGE_SLOTS * MAX_PAGES);
