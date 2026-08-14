# Implementation plan (proposal — deviate with a decision note)

## Workspace layout

```
pagebook/
├── Cargo.toml                 # workspace
├── contracts/
│   └── pagebook/              # the contract crate (soroban-sdk)
│       └── src/
│           ├── lib.rs         # contract trait impl, entry points only
│           ├── market.rs      # market create/config, quantization checks
│           ├── keys.rs        # ALL storage keys + TTL policy in one place
│           ├── level.rs       # Level/Page structs, queue ops, claim state machine
│           ├── bitmap.rs      # L0/L1 ops: set/clear/next_set_tick
│           ├── matching.rs    # fill loop, sweep/partial, best maintenance
│           ├── settle.rs      # vault SAC transfers, fee accrual, route netting
│           ├── events.rs      # typed event emitters
│           └── errors.rs      # contracterror enum
├── crates/pagebook-types/     # order_id packing, shared with client SDK (no_std)
└── docs/
    └── decisions/             # ADRs for deviations
```

## Public interface (sketch)

```rust
pub struct FillFlags { pub post_only: bool, pub fill_or_kill: bool, pub no_rest: bool }

pub trait PageBook {
    fn create_market(e: Env, base: Address, quote: Address, lot_size: u64,
                     tick_size: u64, tick_min: u32, tick_max: u32,
                     taker_fee_bps: u32) -> MarketId;

    /// Cross and/or rest. Returns (order_id | None, filled_lots, quote_atoms).
    fn fill(e: Env, taker: Address, mkt: MarketId, is_bid: bool,
            limit_tick: u32, qty_lots: u64, flags: FillFlags)
        -> (Option<u128>, u64, i128);

    /// Multi-leg atomic route; deltas netted in memory, one transfer per token.
    fn route(e: Env, taker: Address, legs: Vec<FillLeg>) -> Vec<LegResult>;

    /// Claim proceeds and/or cancel remainder; the only maker exit path.
    fn cancel(e: Env, owner: Address, mkt: MarketId, order_id: u128) -> (i128, i128);

    // Views (RO footprints; for routers/UIs):
    fn best(e: Env, mkt: MarketId, is_bid: bool) -> Option<u32>;
    fn level(e: Env, mkt: MarketId, is_bid: bool, tick: u32) -> LevelInfo;
    fn quote_fill(e: Env, mkt: MarketId, is_bid: bool, limit_tick: u32, qty: u64)
        -> QuoteResult;  // also returns the key set a client should pad with

    fn claim_fees(e: Env, mkt: MarketId, token: Address) -> i128;
}
```

Error taxonomy (`contracterror`): `MarketExists, UnknownMarket, BadQuantization,
TickOutOfBand, ZeroQty, Crossed (post_only), Unfilled (FoK), LevelFull, NotOwner,
UnknownOrder, Overflow, FeeTooHigh`.

## Order of work

- **M0 — scaffold.** Workspace, CI (`fmt`, `clippy`, test), `keys.rs` with every storage
  key + a serialized-size test per entry type at max occupancy (budgets from
  architecture §1). Empty contract deploys to testnet.
- **M1 — single level end-to-end.** Market creation; rest/cancel/claim against one
  level (no bitmap walk, inline queue only); vault escrow + settlement; conservation
  invariant test. This proves the claim state machine (architecture §2 table) —
  the riskiest logic — before any book traversal exists.
- **M2 — matching.** Multi-level fill loop, sweep-vs-partial, generation semantics,
  `Best` maintenance, bitmap L0/L1 walk, `MAX_LEVELS_PER_FILL`, post_only/FoK/no_rest.
  Property tests (see below).
- **M3 — pages + fees + route.** Overflow pages; taker fee accrual + `claim_fees`;
  `route` with in-memory netting.
- **M4 — resource hardening.** Footprint-count assertions per op; write-bytes
  measurement per op against the budget table; TTL extension policy + archival tests
  (SDK: expire entries in test env, assert auto-restore paths and that `Level`
  generation survives); testnet soak with a book-driving bot.
- **M5 — client SDK sketch.** Key computation + footprint padding helper
  (`quote_fill` → padded key set), since padding is a client-side responsibility.

## Testing strategy

- **Property/fuzz (proptest):** random op sequences (rest/fill/cancel interleavings) vs
  a naive in-memory reference book. Assert: identical fills (price-time priority),
  conservation, claim path-independence (invariant 4), bitmap/Best coherence
  (invariant 3), `total_open` (invariant 2).
- **Differential claims:** for every random history, claim every order at the end and
  assert Σ payouts + fees == Σ deposits exactly (no dust drift — quantization makes all
  math integer; any discrepancy is a bug, not rounding).
- **Adversarial shapes:** max-depth single level (pages), 32-level sweeps, tombstone-
  heavy queues, generation wraparound at sweep, seq monotonicity.
- **Resource tests (the novel part):** the SDK test env exposes budget/footprint data —
  assert per-op entry counts and write bytes against architecture §4's table. These are
  regression gates, like Deepstate's `.gas-snapshot.runtime` but for footprints.
- **Archival tests:** cold level archived → taker touches it → restored with counters
  intact; dormant `OrderRef` archived → claim still settles.

## Open questions for the implementer to resolve (with decision notes)

1. Inline level capacity N and page capacity P — tune from measured entry sizes/fees
   (start N=32, P=32).
2. Exact TTL targets and whether ops re-bump neighbors' TTLs opportunistically.
3. `quote_fill` return shape for the padding helper (keys vs opaque footprint XDR).
4. Whether `route` legs share pad budget or declare independently.
5. Self-trade prevention flag in v1 (cheap: compare owner on head consume — but that
   reads `OrderRef` in the hot path; likely defer).
6. Fee split (protocol/integrator) — Deepstate's dual-fee model is a reasonable
   template (both capped, both on taker output).
