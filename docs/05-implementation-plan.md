# Implementation plan (proposal — deviate with a decision note)

*Revised after adversarial reviews — see `decisions/001-adversarial-review-round-1.md`
and `decisions/003-adversarial-review-round-2-resolutions.md`.*

## Workspace layout

```
pagebook/
├── Cargo.toml                 # workspace
├── contracts/
│   └── pagebook/              # the contract crate (soroban-sdk)
│       └── src/
│           ├── lib.rs         # contract trait impl, entry points only
│           ├── admin.rs       # constructor, admin rotation, pause, upgrade, keepalive
│           ├── market.rs      # market create/config, quantization + §0 bound checks
│           ├── keys.rs        # ALL storage keys + TTL policy in one place
│           ├── level.rs       # Level/Page packed encoding, positional queue, resets, claim state machine
│           ├── bitmap.rs      # L0/L1 ops: set/clear/next_set_tick(at_or_after)
│           ├── matching.rs    # fill loop, sweep/partial, caps + windows, best maintenance
│           ├── settle.rs      # vault SAC transfers, fee accrual (ceil), route netting
│           ├── events.rs      # typed event emitters
│           └── errors.rs      # contracterror enum
├── crates/pagebook-types/     # nonce/coordinate types, packed entry layouts, shared with client SDK (no_std)
└── docs/
    └── decisions/             # ADRs for deviations
```

## Public interface (sketch)

```rust
pub struct FillFlags { pub post_only: bool, pub fill_or_kill: bool, pub no_rest: bool }

/// Slot-access windows the client declared pages for (architecture §3/§4).
/// Exact encoding is implementer's choice (decision note) — semantically:
/// per-band-level consume windows + the taker's own append window.
pub struct SlotWindow { /* ... */ }

pub trait PageBook {
    // ---- deploy-time; no init entry point, no first-caller race (architecture §6) ----
    // __constructor(e: Env, admin: Address, fee_recipient: Address);

    // ---- admin (admin.require_auth() on all four) ----
    fn set_admin(e: Env, new_admin: Address);
    fn set_fee_recipient(e: Env, recipient: Address);
    fn set_paused(e: Env, paused: bool);       // pause blocks fill/rest; never cancel/claim
    fn upgrade(e: Env, wasm_hash: BytesN<32>);

    /// Admin-gated in v1. Enforces tick_min ≥ 1, fee_bps ≤ FEE_BPS_MAX, and the §0
    /// creation bounds (LEVEL_CAP × max_order_lots × price / base, with route headroom).
    fn create_market(e: Env, base: Address, quote: Address, lot_size: u64,
                     tick_size: u64, tick_min: u32, tick_max: u32,
                     taker_fee_bps: u32, min_order_lots: u64, max_order_lots: u64)
        -> MarketId;

    /// Cross and/or rest. taker.require_auth().
    /// `start_tick` = client's simulated best opposite tick — matching never visits
    /// better ticks. `nonce` = client-chosen order handle (OrderRef key is
    /// (taker, nonce), declarable pre-submission). `window` = declared slot access;
    /// window edges end the fill gracefully (refund) or fail rest as RetryRest —
    /// only walking past the padded band traps.
    /// Returns (rested: bool, filled_lots, quote_atoms).
    fn fill(e: Env, taker: Address, mkt: MarketId, is_bid: bool,
            limit_tick: u32, qty_lots: u64, start_tick: u32, nonce: u64,
            window: SlotWindow, flags: FillFlags)
        -> (bool, u64, i128);

    /// Multi-leg atomic route; legs.len() ≤ MAX_ROUTE_LEGS and ONE shared
    /// MAX_LEVELS_PER_FILL / MAX_SLOTS_SCANNED budget across all legs (architecture
    /// §3) — a route's resource ceiling equals one max fill + per-leg constants.
    fn route(e: Env, taker: Address, legs: Vec<FillLeg>) -> Vec<LegResult>;

    /// Claim proceeds and/or cancel remainder; the only maker exit path.
    /// owner.require_auth(). Returns (paid, refunded).
    fn cancel(e: Env, owner: Address, mkt: MarketId, nonce: u64) -> (i128, i128);

    // Views (RO footprints; for routers/UIs):
    fn best(e: Env, mkt: MarketId, is_bid: bool) -> Option<u32>;
    fn level(e: Env, mkt: MarketId, is_bid: bool, tick: u32) -> LevelInfo;
    fn order(e: Env, mkt: MarketId, owner: Address, nonce: u64) -> OrderInfo; // coords + claim preview
    fn quote_fill(e: Env, mkt: MarketId, is_bid: bool, limit_tick: u32, qty: u64)
        -> QuoteResult;  // start_tick + band + slot windows the client should declare

    /// Permissionless cranks (no auth; effects defined by config, not caller):
    fn claim_fees(e: Env, mkt: MarketId, token: Address) -> i128;  // pays recipient
    fn keepalive(e: Env);   // bumps instance TTL — market ops never write instance
}
```

Error taxonomy (`contracterror`): `NotAdmin, Paused, MarketExists, UnknownMarket,
BadQuantization, TickOutOfBand, BadStartTick, QtyOutOfBounds, Crossed (post_only),
Unfilled (FoK), LevelFull, RetryRest (append outside declared window), OrderExists
(live nonce), NotOwner, UnknownOrder, Overflow, FeeTooHigh, TooManyLegs`.

## Order of work

- **M0 — scaffold.** Workspace, CI (`fmt`, `clippy`, test), `keys.rs` +
  `pagebook-types` packed entry layouts, a serialized-size test per entry type at max
  occupancy (budgets from architecture §1 — these assume the packed-`Bytes` encoding;
  `contracttype` maps blow the Level budget ~2.5×, which is why packing is mandated,
  not optional). Empty contract deploys to testnet via constructor.
- **M1 — single level end-to-end.** Constructor/admin/pause skeleton + auth tests
  (malicious-caller per entry point); market creation with the full §0 bound checks
  (property tests at each maximum: max order, full level, route headroom, fee cap);
  rest/cancel/claim against one level (no bitmap walk, inline queue only); positional
  slot lifecycle unit tests (slot(seq) pure; head advance counter-only; eager-advance;
  **empty-level reset**: cancel a level to empty repeatedly until past `LEVEL_CAP`,
  assert reuse + old claims still pay); nonce lifecycle (`OrderExists`, reuse after
  claim); vault escrow + settlement; conservation invariant test. This proves the claim
  state machine — the riskiest logic — before any book traversal exists.
- **M2 — matching.** Multi-level fill loop, `start_tick` clamping, sweep-vs-partial,
  generation semantics, `Best` maintenance (incl. stale-bit lazy clearing), bitmap
  L0/L1 walk, cap + **window** termination (remainder refunded — book never crossed),
  post_only (conservative vs recorded `Best`, incl. stale-best false-reject test),
  FoK/no_rest. Property tests (below), plus the **sim-to-apply race tests** — the
  padding rule gets coverage here, not first on testnet: simulate a fill, mutate the
  book (better-priced rest; new level inside the band; level emptied; **head advanced
  into pages; tail pushed across a page boundary; generation bumped by a sweep**),
  re-apply with the stale `start_tick`/band/window and assert the defined outcome
  (graceful refund or `RetryRest`; a trap only when the walk passes the band).
- **M3 — pages + fees + route.** Overflow pages incl. deletion-behind-head,
  `LevelFull` at `LEVEL_CAP`, and **stale-slot tests** (invariant 9: generation reset
  over dirty pages, then reuse — decode rule `seq < tail_seq`); taker fee accrual
  (ceil) + `claim_fees` to recipient; `route` with in-memory netting, shared caps
  across legs, and event-byte assertions at the route worst case.
- **M4 — resource hardening.** Build the **worst-case state-transition matrix** first
  (per op: entries touched × bytes, incl. bitmap dispersal, windows, page cleanup, TTL
  bumps, SAC entries), then footprint-count and write-byte assertions per op against
  architecture §4's corrected table (max sweep: ~70 writes / ~22 KB — construct the
  32-level / 32-word shape explicitly); TTL policy incl. **no instance write on market
  ops** (assert instance entry absent from fill/rest/cancel write sets) + `keepalive`
  crank. Archival: SDK tests can expire entries and assert TTL values and that `Level`
  counters survive restore — but P23 auto-restore is a simulation/tx-build feature, not
  host behavior, so the auto-restore *path* is exercised only in the testnet soak with
  a book-driving bot (which must include a quote-improving spammer and a same-level
  rest storm to hit the race paths under real inclusion latency).
- **M5 — client SDK sketch.** Key computation + padding helper (`quote_fill` →
  `start_tick` + band + slot windows + nonce management), since padding is a
  client-side responsibility.

## Testing strategy

- **Property/fuzz (proptest):** random op sequences (rest/fill/cancel interleavings) vs
  a naive in-memory reference book. Assert: identical fills (price-time priority scoped
  by `start_tick`), conservation, claim path-independence (invariant 4), bitmap/Best
  coherence (weakened invariant 3), `total_open` (invariant 2 with stale-slot
  exclusion), slot validity (invariant 9), **book never crossed (invariant 8)**.
- **Differential claims:** for every random history, claim every order at the end and
  assert Σ payouts + fees == Σ deposits exactly (fee dust included — the ceil is the
  only rounding; any other discrepancy is a bug).
- **Adversarial shapes:** max-depth single level (pages), 32-level worst-dispersal
  sweeps, tombstone-poisoned head (K dust rests, cancel 2..K−1, assert scan cap +
  persisted progress), **cancel-to-empty storms → LevelFull → reset → reuse**,
  stale-bit storms, cap/window-terminated fills with crossing remainders, generation
  reset at sweep **and over dirty pages**, seq monotonicity, nonce collision/reuse,
  bound-saturating amounts on every public path.
- **Resource tests (the novel part):** the SDK test env exposes budget/footprint data —
  assert per-op entry counts and write bytes against architecture §4's table (derived
  from the worst-case matrix, not sampled). Regression gates, like Deepstate's
  `.gas-snapshot.runtime` but for footprints. Include the negative assertion: market
  ops never write the instance entry.
- **Archival tests:** cold level expired in test env → touched → counters intact;
  dormant `OrderRef` expired → claim still settles. (Auto-restore path itself: testnet
  soak only — see M4.)

## Open questions for the implementer to resolve (with decision notes)

1. Inline level capacity N, page capacity P, `MAX_PAGES`, `MAX_SLOTS_SCANNED` — tune
   from measured entry sizes/fees (start N=32, P=32).
2. Exact TTL targets and whether ops re-bump neighbors' TTLs opportunistically.
3. `quote_fill` return shape for the padding helper (keys vs opaque footprint XDR) and
   the concrete `SlotWindow` encoding (per-level page ranges vs a compact global form).
4. Self-trade prevention flag in v1 (cheap: compare owner on head consume — but that
   reads `OrderRef` in the hot path; likely defer).
5. Fee *split* (protocol/integrator) — custody and recipient are defined (architecture
   §6); Deepstate's dual-fee model remains a reasonable template for the split (both
   capped, both on taker output).
6. Whether cancel-at-head should also advance past tombstones in its declared page
   (cheap win) or stay counter-minimal.
7. Nonce policy in the client SDK (random u64 vs per-owner counter) — the contract only
   requires "not currently live for this owner".
