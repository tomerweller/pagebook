# Implementation plan (proposal — deviate with a decision note)

*Revised after adversarial review — see `decisions/001-adversarial-review-round-1.md`.*

## Workspace layout

```
pagebook/
├── Cargo.toml                 # workspace
├── contracts/
│   └── pagebook/              # the contract crate (soroban-sdk)
│       └── src/
│           ├── lib.rs         # contract trait impl, entry points only
│           ├── admin.rs       # init, admin rotation, pause, upgrade, fee recipient
│           ├── market.rs      # market create/config, quantization + bound checks
│           ├── keys.rs        # ALL storage keys + TTL policy in one place
│           ├── level.rs       # Level/Page packed encoding, positional queue, claim state machine
│           ├── bitmap.rs      # L0/L1 ops: set/clear/next_set_tick(at_or_after)
│           ├── matching.rs    # fill loop, sweep/partial, scan caps, best maintenance
│           ├── settle.rs      # vault SAC transfers, fee accrual (ceil), route netting
│           ├── events.rs      # typed event emitters
│           └── errors.rs      # contracterror enum
├── crates/pagebook-types/     # order_id packing, packed entry layouts, shared with client SDK (no_std)
└── docs/
    └── decisions/             # ADRs for deviations
```

## Public interface (sketch)

```rust
pub struct FillFlags { pub post_only: bool, pub fill_or_kill: bool, pub no_rest: bool }

pub trait PageBook {
    // ---- admin (see architecture §6) ----
    fn init(e: Env, admin: Address, fee_recipient: Address);
    fn set_admin(e: Env, new_admin: Address);
    fn set_fee_recipient(e: Env, recipient: Address);
    fn set_paused(e: Env, paused: bool);       // pause blocks fill/rest; never cancel/claim
    fn upgrade(e: Env, wasm_hash: BytesN<32>);

    /// Admin-gated in v1 (architecture §6). Enforces tick_min ≥ 1 and
    /// max_order_lots × tick_max × tick_size ≤ i128::MAX / 4.
    fn create_market(e: Env, base: Address, quote: Address, lot_size: u64,
                     tick_size: u64, tick_min: u32, tick_max: u32,
                     taker_fee_bps: u32, min_order_lots: u64, max_order_lots: u64)
        -> MarketId;

    /// Cross and/or rest. `start_tick` = client's simulated best opposite tick;
    /// matching never visits better ticks (architecture §3/§4 — this is what makes
    /// fills survive concurrent quote improvement).
    /// Returns (order_id | None, filled_lots, quote_atoms).
    fn fill(e: Env, taker: Address, mkt: MarketId, is_bid: bool,
            limit_tick: u32, qty_lots: u64, start_tick: u32, flags: FillFlags)
        -> (Option<u128>, u64, i128);

    /// Multi-leg atomic route; legs.len() ≤ MAX_ROUTE_LEGS; deltas netted in memory,
    /// one transfer per token.
    fn route(e: Env, taker: Address, legs: Vec<FillLeg>) -> Vec<LegResult>;

    /// Claim proceeds and/or cancel remainder; the only maker exit path.
    fn cancel(e: Env, owner: Address, mkt: MarketId, order_id: u128) -> (i128, i128);

    // Views (RO footprints; for routers/UIs):
    fn best(e: Env, mkt: MarketId, is_bid: bool) -> Option<u32>;
    fn level(e: Env, mkt: MarketId, is_bid: bool, tick: u32) -> LevelInfo;
    fn quote_fill(e: Env, mkt: MarketId, is_bid: bool, limit_tick: u32, qty: u64)
        -> QuoteResult;  // returns start_tick + the contiguous band a client should declare

    /// Permissionless crank: transfers accrued fees to the configured recipient.
    fn claim_fees(e: Env, mkt: MarketId, token: Address) -> i128;
}
```

Error taxonomy (`contracterror`): `AlreadyInit, NotInit, NotAdmin, Paused, MarketExists,
UnknownMarket, BadQuantization, TickOutOfBand, BadStartTick, QtyOutOfBounds, Crossed
(post_only), Unfilled (FoK), LevelFull, NotOwner, UnknownOrder, Overflow, FeeTooHigh,
TooManyLegs`.

## Order of work

- **M0 — scaffold.** Workspace, CI (`fmt`, `clippy`, test), `keys.rs` +
  `pagebook-types` packed entry layouts, a serialized-size test per entry type at max
  occupancy (budgets from architecture §1 — these assume the packed-`Bytes` encoding;
  `contracttype` maps blow the Level budget ~2.5×, which is why packing is mandated,
  not optional). Empty contract deploys to testnet.
- **M1 — single level end-to-end.** Init/admin/pause skeleton; market creation with
  bound checks; rest/cancel/claim against one level (no bitmap walk, inline queue
  only); positional slot lifecycle unit tests (slot(seq) is a pure function; head
  advance is counter-only; eager-advance convention); vault escrow + settlement;
  conservation invariant test. This proves the claim state machine (architecture §2
  table) — the riskiest logic — before any book traversal exists.
- **M2 — matching.** Multi-level fill loop, `start_tick` clamping, sweep-vs-partial,
  generation semantics, `Best` maintenance (incl. stale-bit lazy clearing), bitmap
  L0/L1 walk, `MAX_LEVELS_PER_FILL` + `MAX_SLOTS_SCANNED` termination (remainder
  refunded — book never crossed), post_only/FoK/no_rest. Property tests (below), plus
  the **sim-to-apply race tests** — the padding rule gets coverage here, not first on
  testnet: simulate a fill, mutate the book (better-priced rest; new level inside the
  band; level emptied), re-apply with the stale `start_tick`/band and assert the
  defined outcome (better-priced order untouched, fill succeeds; walk-past-band is the
  only failure).
- **M3 — pages + fees + route.** Overflow pages incl. deletion-behind-head and
  `LevelFull` at generation capacity; taker fee accrual (ceil) + `claim_fees` to
  recipient; `route` with in-memory netting and `MAX_ROUTE_LEGS`.
- **M4 — resource hardening.** Footprint-count assertions per op; write-bytes
  measurement per op against the budget table (the max-sweep row is a worst-case
  ceiling — 32 levels in 32 distinct L0 words — construct that shape explicitly); TTL
  extension policy. Archival: SDK tests can expire entries and assert TTL values and
  that `Level` counters survive restore — but P23 auto-restore is a
  simulation/tx-build feature, not host behavior, so the auto-restore *path* is
  exercised only in the testnet soak with a book-driving bot (which must include a
  quote-improving spammer to hit the race paths under real inclusion latency).
- **M5 — client SDK sketch.** Key computation + band-padding helper (`quote_fill` →
  `start_tick` + contiguous key band), since padding is a client-side responsibility.

## Testing strategy

- **Property/fuzz (proptest):** random op sequences (rest/fill/cancel interleavings) vs
  a naive in-memory reference book. Assert: identical fills (price-time priority scoped
  by `start_tick`), conservation, claim path-independence (invariant 4), bitmap/Best
  coherence (weakened invariant 3: `total_open > 0` ⇒ bit set; stale bits cleared on
  visit), `total_open` (invariant 2), **book never crossed after any op (invariant 8)**.
- **Differential claims:** for every random history, claim every order at the end and
  assert Σ payouts + fees == Σ deposits exactly (fee dust included — the ceil is the
  only rounding; any other discrepancy is a bug).
- **Adversarial shapes:** max-depth single level (pages), 32-level worst-dispersal
  sweeps, **tombstone-poisoned head** (K dust rests, cancel 2..K−1, assert scan cap +
  persisted progress), stale-bit storms from cancel-to-empty, cap-terminated fills with
  crossing remainders, generation reset at sweep, seq monotonicity, `LevelFull` at
  `N + P × MAX_PAGES`.
- **Resource tests (the novel part):** the SDK test env exposes budget/footprint data —
  assert per-op entry counts and write bytes against architecture §4's table. These are
  regression gates, like Deepstate's `.gas-snapshot.runtime` but for footprints.
- **Archival tests:** cold level expired in test env → touched → counters intact;
  dormant `OrderRef` expired → claim still settles. (Auto-restore path itself: testnet
  soak only — see M4.)

## Open questions for the implementer to resolve (with decision notes)

1. Inline level capacity N, page capacity P, `MAX_PAGES`, `MAX_SLOTS_SCANNED` — tune
   from measured entry sizes/fees (start N=32, P=32).
2. Exact TTL targets and whether ops re-bump neighbors' TTLs opportunistically.
3. `quote_fill` return shape for the padding helper (keys vs opaque footprint XDR).
4. Whether `route` legs share pad budget or declare independently — load-bearing now
   that padding is a contiguous band: 400 footprint entries split across legs bounds
   route depth.
5. Self-trade prevention flag in v1 (cheap: compare owner on head consume — but that
   reads `OrderRef` in the hot path; likely defer).
6. Fee *split* (protocol/integrator) — custody and recipient are now defined
   (architecture §6); Deepstate's dual-fee model remains a reasonable template for the
   split (both capped, both on taker output).
7. Whether cancel-at-head should also advance past tombstones in its declared page
   (cheap win) or stay counter-minimal.
