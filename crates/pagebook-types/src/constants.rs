/// Default queue depth of a price level: the `level_cap` a new market gets
/// (architecture §2). A market may raise it through `set_market_caps` up to
/// `LEVEL_CAP_MAX`; the §0.3 proof re-runs on every raise (ADR-037).
pub const LEVEL_CAP: u32 = 64;
/// Ceiling on `level_cap`. The heaviest legal shape, a `replace_batch` of
/// `MAX_REPLACE_BATCH` items each rewriting a `Level` at cap, must fit the
/// 132,096 B per-transaction write-byte cap: 40 × (232 + 12 × cap) + 21,320
/// bytes (the 40 rewritten one-order levels, orders, balances and nonce) gives
/// cap ≤ 211, and 128 leaves that shape at 70% (ADR-037).
pub const LEVEL_CAP_MAX: u32 = 128;
pub const MAX_LEVELS_CROSSED: u32 = 32;
pub const MAX_SLOTS_SCANNED: u32 = 64;
pub const MAX_ROUTE_LEGS: u32 = 4;
pub const MAX_REPLACE_BATCH: u32 = 40;
pub const FEE_BPS_MAX: u32 = 1_000;
pub const FEE_BPS_DENOM: i128 = 10_000;
pub const WORD_TICKS: u32 = 2048;
pub const SUMMARY_WORDS: u32 = 2048;
pub const TICK_INDEX_SPAN: u32 = WORD_TICKS * SUMMARY_WORDS;
pub const BITMAP_BYTES: usize = 256;

// XDR sizes measured with the SDK encoder (ADR-036, ADR-037): a Level is
// 124 B empty and grows 12 B per slot held — 892 B at the default cap of 64,
// 1,660 B at LEVEL_CAP_MAX; the bitmaps are 264 B. Budgets are the measured
// maxima with a little headroom. `BUDGET_LEVEL` is the budget at the DEFAULT
// `level_cap`; a market raised past it is bounded by `BUDGET_LEVEL_MAX`
// (max occupancy, the entry-size ground rule).
pub const BUDGET_CONFIG: usize = 200;
pub const BUDGET_MARKET: usize = 500;
pub const BUDGET_LEVEL: usize = 1_000;
pub const BUDGET_LEVEL_MAX: usize = 1_750;
pub const BUDGET_ORDER: usize = 160;
pub const BUDGET_FEE_ACCRUAL: usize = 50;
pub const BUDGET_BEST_TICK: usize = 60;
pub const BUDGET_TICK_BITMAP: usize = 264;

// MAX_REPLACE_BATCH is 40, not the earlier 64: a measured replace item emits
// ~340 B of events, so 64 items exceed the 16,384 B event budget, and 64
// dispersed items exceed the 400-entry footprint and 200-write caps; 40 fits
// all three (ADR-024). The §0.3 creation bound reserves 4 × MAX_ROUTE_LEGS of
// headroom for summed per-token flows; a replace_batch sums up to
// MAX_REPLACE_BATCH escrows and fits because each escrow is bounded by
// i128::MAX / (16 × level_cap) with level_cap ≥ MAX_REPLACE_BATCH (ADR-021);
// `market.rs` enforces that lower bound on every market.
const _: () = assert!(MAX_REPLACE_BATCH <= LEVEL_CAP);
const _: () = assert!(LEVEL_CAP <= LEVEL_CAP_MAX);
