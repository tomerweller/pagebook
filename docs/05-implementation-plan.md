# Implementation plan (proposal — deviate with a decision note)

*Revised after adversarial reviews — see `decisions/001-adversarial-review-round-1.md`,
`decisions/003-adversarial-review-round-2-resolutions.md`, and
`decisions/012-adversarial-review-round-3-resolutions.md`; pre-implementation
decisions in `decisions/014-implementation-plan-readiness.md` and
`decisions/015-plan-review-for-non-interactive-build.md`.*

## Workspace layout

```
pagebook/
├── Cargo.toml                 # workspace
├── contracts/
│   └── pagebook/              # the contract crate (soroban-sdk)
│       └── src/
│           ├── lib.rs         # contract trait impl, entry points only
│           ├── admin.rs       # constructor, admin rotation, pause, upgrade, keepalive
│           ├── market.rs      # market create/config, quantization + §0.3 bound checks
│           ├── keys.rs        # DataKey enum (contracttype, full-word variants) + TTL policy
│           ├── level.rs       # Level/LevelPage packed encoding, positional queue, resets, settlement state machine
│           ├── bitmap.rs      # TickWord/TickSummary ops: set/clear/next_set_tick(from, direction) — asks ascend, bids descend
│           ├── matching.rs    # matching loop (place), sweep/partial, caps + windows, best maintenance
│           ├── settle.rs      # vault SAC transfers, fee accrual (ceil), route netting
│           ├── events.rs      # typed event emitters
│           └── errors.rs      # contracterror enum
├── crates/pagebook-types/     # nonce/coordinate types, packed entry layouts, shared with client SDK (no_std)
└── docs/
    └── decisions/             # ADRs for deviations
```

## Public interface (sketch)

```rust
pub struct PlaceFlags { pub post_only: bool, pub fill_or_kill: bool, pub no_rest: bool }

/// Slot-access windows the client declared pages for (architecture §8/§14).
/// Encoding decided in ADR-014: one consume window per set level in the band and
/// one append window for the taker's own rest. Page ranges are inclusive; a level
/// absent from `consume` has an empty window (inline slots only).
pub struct PageRange { pub first: u32, pub last: u32 }
pub struct ConsumeWindow { pub tick: u32, pub pages: PageRange }
pub struct SlotWindow {
    pub consume: Vec<ConsumeWindow>,   // ≤ MAX_LEVELS_CROSSED entries
    pub append: PageRange,             // {page(tail_sim), +1}; page 0 is always implied
}

pub trait PageBook {
    // ---- deploy-time; no init entry point, no first-caller race (architecture §12) ----
    // __constructor(e: Env, admin: Address, fee_recipient: Address);

    // ---- admin (admin.require_auth() on all four) ----
    fn set_admin(e: Env, new_admin: Address);
    fn set_fee_recipient(e: Env, recipient: Address);
    fn set_paused(e: Env, paused: bool);       // pause blocks place/route/replace; never settle or collect_fees
    fn upgrade(e: Env, wasm_hash: BytesN<32>);

    /// Retune a market's mutable caps as network limits move (SLPs; architecture §12,
    /// ADR-007). Re-runs the §0.3 overflow proof; MAX_PAGES raise-only; quantization
    /// and INLINE_SLOTS/PAGE_SLOTS are not parameters — they are frozen for the
    /// market's lifetime.
    fn set_market_caps(e: Env, market: MarketId, max_levels_crossed: u32,
                       max_slots_scanned: u32, taker_fee_bps: u32,
                       min_order_lots: u64, max_order_lots: u64, max_pages: u32);

    /// Admin-gated in v1. Enforces base ≠ quote, 1 ≤ tick_min < tick_max ≤ 2^22,
    /// fee_bps ≤ FEE_BPS_MAX, and the §0.3 creation bounds (LEVEL_CAP × max_order_lots
    /// × price / base, with route headroom). No duplicate-pair check (§0.1).
    fn create_market(e: Env, base: Address, quote: Address, lot_size: u64,
                     tick_size: u64, tick_min: u32, tick_max: u32,
                     taker_fee_bps: u32, min_order_lots: u64, max_order_lots: u64)
        -> MarketId;

    /// Cross and/or rest. taker.require_auth().
    /// `start_tick` = client's simulated best opposite tick — matching never visits
    /// better ticks. `nonce` = client-chosen order handle (Order key is
    /// (taker, nonce), declarable pre-submission). `window` = declared slot access;
    /// window edges end the take gracefully (refund) or fail the rest as RetryRest —
    /// only walking past the padded band traps.
    /// Returns (rested: bool, filled_lots, quote_atoms).
    fn place(e: Env, taker: Address, market: MarketId, is_bid: bool,
            limit_tick: u32, qty_lots: u64, start_tick: u32, nonce: u64,
            window: SlotWindow, flags: PlaceFlags)
        -> (bool, u64, i128);

    /// Multi-leg atomic route; legs.len() ≤ MAX_ROUTE_LEGS and ONE shared
    /// MAX_LEVELS_CROSSED / MAX_SLOTS_SCANNED budget across all legs (architecture
    /// §8) — a route's resource ceiling equals one maximal place + per-leg constants.
    fn route(e: Env, taker: Address, legs: Vec<PlaceLeg>) -> Vec<LegResult>;

    /// The only maker exit: pays the filled part, refunds the open part.
    /// owner.require_auth(). Returns (paid, refunded).
    fn settle(e: Env, owner: Address, market: MarketId, nonce: u64) -> (i128, i128);

    /// Maker quote update (ADR-005): settle the old order per the settlement table,
    /// rewrite the SAME Order in place (fixed size ⇒ zero rent), append at the
    /// new tick. Never matches — conservative post-only check vs recorded BestTick.
    /// owner.require_auth(). Blocked when paused (contains a rest).
    fn replace(e: Env, owner: Address, market: MarketId, nonce: u64, is_bid: bool,
               tick: u32, qty_lots: u64, window: SlotWindow) -> (i128, i128);

    /// Batched replace: items.len() ≤ MAX_REPLACE_BATCH (else BatchTooLarge), settlement
    /// deltas netted, one transfer per token. A full book refresh is one transaction.
    /// ReplaceItem = { nonce: u64, is_bid: bool, tick: u32, qty_lots: u64, window: SlotWindow }
    /// — `replace`'s arguments minus owner/market.
    fn replace_batch(e: Env, owner: Address, market: MarketId, items: Vec<ReplaceItem>)
        -> Vec<(i128, i128)>;

    // Views (RO footprints; for routers/UIs):
    fn best(e: Env, market: MarketId, is_bid: bool) -> Option<u32>;
    fn level(e: Env, market: MarketId, is_bid: bool, tick: u32) -> LevelInfo;
    fn order(e: Env, market: MarketId, owner: Address, nonce: u64) -> OrderInfo; // coords + settlement preview
    /// The simulate step (architecture §11/§14). Runs the SAME walk as `place` in
    /// dry-run mode (matching.rs `Mode::DryRun`: caps, lazy-clear decisions, and
    /// window logic identical; nothing written). Returns `start_tick`, the crossed
    /// ticks with per-level head positions, the tail position at `limit_tick`, the
    /// keys the client should declare (band `Level`s, words, own-side keys) as
    /// typed keys — not footprint XDR — and which of them are archived (ADR-014).
    fn quote_place(e: Env, market: MarketId, is_bid: bool, limit_tick: u32, qty: u64)
        -> QuoteResult;

    /// Permissionless cranks (no auth; effects defined by config, not caller):
    fn collect_fees(e: Env, market: MarketId, token: Address) -> i128;  // pays recipient
    fn keepalive(e: Env);   // bumps instance TTL — market ops never write instance
}
```

Error taxonomy (`contracterror`): `NotAdmin, Paused, SameToken (base == quote),
UnknownMarket, BadQuantization, TickOutOfBand (also tick_max > 2^22 at creation),
BadStartTick, QtyOutOfBounds, Crossed (post_only), Unfilled (FoK), LevelFull, RetryRest
(append outside declared window), OrderExists (live nonce), NotOwner, UnknownOrder,
Overflow (also a generation counter at u32::MAX), FeeTooHigh, TooManyLegs, BadWindow
(`consume.len() > MAX_LEVELS_CROSSED` or a malformed page range), BatchTooLarge
(`replace_batch` items > MAX_REPLACE_BATCH), TokenNotAuthorized (`create_market`: the
SAC reports the vault unauthorized)`. Error codes are the declaration order
above, starting at 1, and are stable across upgrades (append only). `BadStartTick` is
defined in architecture §8 (`start_tick` outside `[tick_min, tick_max)`; every in-band
value is legal). There is no `MarketExists`: the schema has no pair index and duplicate
pairs are allowed (architecture §0.1; ADR-012).

## Encoding decisions (defaults the builder uses without asking — ADR-015)

Anything not listed here follows the architecture doc; anything listed here is a
default that a decision note may change once measured.

- **`MarketId`** is `u32`, assigned from `Config`'s counter starting at 0.
- **`DataKey`** is a `#[contracttype]` enum with full-word variants and tuple fields in
  the order the architecture writes the key: `Config`, `Market(u32)`,
  `Level(u32, bool, u32)`, `LevelPage(u32, bool, u32, u32)`, `Order(u32, Address, u64)`,
  `FeeAccrual(u32, Address)`, `BestTick(u32, bool)`, `TickSummary(u32, bool)`,
  `TickWord(u32, bool, u32)`; `bool` is `is_bid`.
- **Packed layouts** (little-endian, leading `version: u8 = 1`), field order exactly as
  the architecture's contents columns: `Level` = version, generation u32, head_seq u32,
  tail_seq u32, head_consumed_lots u64, open_lots u64, then `INLINE_SLOTS` × qty u64;
  `LevelPage` = version, then `PAGE_SLOTS` × qty u64; `BestTick` = version, flags u8
  (bit 0 = empty), tick u32; `TickSummary` / `TickWord` = version, then 256 bytes of
  bitmap, bit `i` = byte `i / 8`, mask `1 << (i % 8)`. `Order`, `Market`, `Config`,
  `FeeAccrual` are `#[contracttype]` structs (small; the size tests decide if any must
  be packed).
- **`page(seq)`** for an inline seq is 0; the append window for an inline tail is
  `{0, 1}` — a `PageRange` is never empty.
- **Events**: topics = `(symbol name, market_id)`; data = the remaining fields from
  architecture §13 as a tuple in the listed order. Byte assertions count topics + data.
- **`keepalive`** extends the instance and code TTLs to the 180-day maximum
  unconditionally (no threshold logic; the crank is idempotent and cheap when nothing
  is due).
- **`authorized(vault)`**: `create_market` calls the SAC's `authorized(pagebook_address)`
  on both tokens through the SDK token client and fails `TokenNotAuthorized` (add to the
  taxonomy) if either returns false.
- **`place` return** when nothing rests and nothing fills: `(false, 0, 0)`; `settle` of a
  fully filled order returns `(paid, 0)`; `route` returns one `LegResult` per leg in
  order and fails atomically, so partial legs never surface.
- **`quote_place` on an empty-flagged side** returns `start_tick = limit_tick` and a
  one-key band (architecture §8).

## Order of work

- **M0 — scaffold.** Workspace, CI (`fmt`, `clippy`, test), `keys.rs` +
  `pagebook-types` packed entry layouts, a serialized-size test per entry type at max
  occupancy (budgets from architecture Part I — these assume the packed-`Bytes` encoding;
  `contracttype` maps blow the Level budget ~2.5×, which is why packing is mandated,
  not optional). Empty contract deploys to testnet via constructor. **Footprint-test
  spike (half a day, gates M2's test design):** confirm what the SDK test host exposes
  for the recorded footprint and budget, and land a `footprint_of(|| call)` test
  helper that returns the set of keys read and written plus write bytes. M2 and M4
  assert against it as described under Testing strategy; if exact key sets are not
  reachable, fall back to entry-count and write-byte upper bounds (CLAUDE.md) and
  record the fallback in a decision note. **Fallback ladder for the spike (in order;
  stop at the first rung that works, and record which):** (1) read the recorded
  footprint as a key set from the test host; (2) writes — diff the test-env ledger
  snapshot before/after the call and XDR-serialize the changed entries for write
  bytes; reads — a `Mode::Trace` variant of the shared walk that records every key it
  visits into a test-only buffer; (3) entry counts and write-byte upper bounds only.
  Rung 3 cannot express `recorded ⊆ declared`, so if reached, the M2 padding suite is
  marked partial in the decision note, not "done". The same spike confirms whether the
  test env can **advance ledgers past a TTL and observe expiry/restore** and whether
  TTL values are readable; if not, the two archival tests move into the M4 soak and
  only TTL-value assertions stay in-repo. **Testnet procedure** (M0 deploy, M4 gates
  and soak): `stellar keys generate --network testnet` for a builder identity, fund it
  via Friendbot (public HTTP faucet), and keep the RPC URL and key alias in an
  uncommitted `.stellar/` (already git-ignored). If the network is unreachable from
  the build sandbox, deploy is skipped and every testnet-only gate is marked *blocked*
  in a decision note; the in-repo fee gates still run from counted writes and bytes at
  the rates §17 records.
- **M1 — single level end-to-end.** Constructor/admin/pause skeleton + auth tests
  (malicious-caller per entry point); market creation with the full §0.3 bound checks
  (property tests at each maximum: max order, full level, route headroom, fee cap);
  rest/settle/**replace** against one level (no bitmap walk, inline queue only);
  positional slot lifecycle unit tests (slot(seq) pure; head advance counter-only;
  eager-advance; **empty-level reset**: empty a level via settles repeatedly until past
  `LEVEL_CAP`, assert reuse + old settlements still pay); replace equivalence property
  (replace ≡ settle+place for book state and settlement, with the `Order` entry
  reused — assert no entry create/delete in the write set); nonce lifecycle
  (`OrderExists`, reuse after settle); vault escrow + settlement (incl. escrow *delta*
  on replace); `set_market_caps` tests (auth; §0.3 re-proof rejects breaking values;
  `MAX_PAGES` lower rejected; live orders unaffected across a retune); `create_market`
  refuses an asset whose SAC reports `authorized(vault) == false` (ADR-012 L3; mock
  SAC test); conservation
  invariant test, with the settle-then-sweep case called out (settle a partial head,
  then sweep the level: `open_lots` must have dropped by the refund — ADR-012 M3);
  fee split-form equivalence property (`(o ÷ 10⁴)·bps + ceil((o mod 10⁴)·bps / 10⁴)
  == ceil(o·bps / 10⁴)` and no intermediate above `o`); `create_market` rejects
  `base == quote` and `tick_max > 2^22`. This proves the settlement
  state machine — the riskiest logic — before any book traversal exists.
- **M2 — matching.** `matching.rs` walk with a `Mode::{Apply, DryRun}` switch so
  `quote_place` and `place` share one code path; a minimal in-repo padding helper
  (`quote_place` output → declared key set + `SlotWindow`) that the race tests use as
  their simulate step — the client SDK in M5 wraps this same logic, it does not
  reinvent it. Multi-level matching loop, `start_tick` clamping, sweep-vs-partial,
  generation semantics, `BestTick` maintenance (incl. stale-bit lazy clearing, the
  empty flag, and **no scan past the last sweep** — a take that finishes on a sweep
  reads no `TickWord` beyond the swept tick's word), **re-liquification** (sweep →
  re-rest same tick; lazy-clear → re-rest; empty side → rest at a tick worse than the
  stale recorded best: bit set and `BestTick` correct in all three), bitmap
  TickWord/TickSummary walk, cap + **window** termination (remainder refunded — book never crossed),
  post_only (conservative vs recorded `BestTick`, incl. stale-best false-reject test),
  FoK/no_rest. Property tests (below), plus the **sim-to-apply race tests** — the
  padding rule gets coverage here, not first on testnet: simulate a place, mutate the
  book (better-priced rest; new level inside the band; level emptied; **head advanced
  into pages; tail pushed across a page boundary; tail pushed to `LEVEL_CAP` —
  `LevelFull`, not `RetryRest`; generation bumped by a sweep**),
  re-apply with the stale `start_tick`/band/window and assert the defined outcome
  (graceful refund or `RetryRest`; a trap only when the walk passes the band); and a
  footprint assertion that a resting place's simulated footprint contains its own-side
  `Level`, `TickWord`, `TickSummary`, and `BestTick` keys (ADR-012 H1).
- **M3 — pages + fees + route.** Overflow pages incl. deletion-behind-head,
  `LevelFull` at `LEVEL_CAP`, and **stale-slot tests** (invariant 9: generation reset
  over dirty pages, then reuse — decode rule `seq < tail_seq`); taker fee accrual
  (ceil) + `collect_fees` to recipient; `route` with in-memory netting, shared caps
  across legs, and event-byte assertions at the route worst case; `replace_batch`
  with netted settlement and the `MAX_REPLACE_BATCH` bound (fee gate: a 40-quote
  refresh: assert ~90 writes and **zero rent-bearing creates** in-repo; the ~0.03 XLM
  figure — ADR-005's headline — is measured in M4). Paused `route` fails `Paused`
  (architecture §12). `PlaceLeg` / `LegResult` shapes are decided here (decision
  note): a leg is `place`'s arguments minus `taker`; a result is `place`'s return
  tuple.
- **M4 — resource hardening.** Build the **worst-case state-transition matrix** first
  (per op: entries touched × bytes, incl. bitmap dispersal, windows, page cleanup, TTL
  bumps, SAC entries), then footprint-count and write-byte assertions per op against
  architecture §17's corrected table (max sweep: ~70 writes / ~22 KB — construct the
  32-level / 32-word shape explicitly); **fee gates**: measured resource fee per op
  (SDK budget + testnet simulation) asserted against §17's estimate table within a
  tolerance band, with the rent component isolated (it dominates and moves with the
  network's state-size-dependent rate — record the rate the gate was calibrated at);
  TTL policy incl. **no instance write on market ops** (assert instance entry absent
  from place/settle write sets), **no rent charged by any hot path** (no TTL
  extensions outside `keepalive`/rest-opt-in), + `keepalive` crank. Archival: SDK tests can expire entries and assert TTL values and that `Level`
  counters survive restore — but P23 auto-restore is a simulation/tx-build feature, not
  host behavior, so the auto-restore *path* is exercised only in the testnet soak with
  a book-driving bot (which must include a quote-improving spammer and a same-level
  rest storm to hit the race paths under real inclusion latency). The soak MUST also
  **verify per-entry restore opt-in** (03 §Storage): submit a place whose footprint
  declares an archived `Level` unmarked for restore and does not touch it — expect
  success and no restore charge; then one that touches it unmarked — expect the
  archived-entry failure; then marked — expect success and the rent. Architecture §14's
  "pad archived keys for free" rests on this; if the host behaves otherwise, §14/§15/§17
  need a decision note before M5. **M4 is done when:** the footprint/write-byte gates
  pass in-repo; the fee gates pass within tolerance (or are marked blocked per M0);
  the three restore-opt-in transactions behave as stated; and the bot has run ≥ 2,000
  ledgers (~3 hours) with the spammer and rest storm active and no trap other than a
  walk past `pad_end`, with every `RetryRest` re-simulated and landed.
- **M5 — client SDK sketch.** Key computation + padding helper (`quote_place` →
  `start_tick` + band + slot windows + nonce management), since padding is a
  client-side responsibility; wraps the M2 in-repo helper and adds the
  archived-key marking rule (§14) and nonce policy (open question 7). **Deliverable:**
  a `crates/pagebook-client` crate (Rust, `std`) exposing `keys_for(place | replace |
  settle)`, `pad(quote_result, pad_end) -> (declared keys, SlotWindow, restore
  marks)`, and a nonce allocator, with unit tests that round-trip against the M2
  helper on the same fixtures; no TypeScript in v1.

## Testing strategy

- **Property/fuzz (proptest):** random op sequences (place/replace/settle interleavings) vs
  a naive in-memory reference book. **The reference models observable outcomes only** —
  fills, payouts, refunds, price-time priority scoped by `start_tick`, `replace ≡
  settle+place` — not bitmaps, generations, tombstones, or pages; those are checked
  against the real book by the invariant assertions below. Property runs use
  **non-binding caps** (`MAX_LEVELS_CROSSED`, `MAX_SLOTS_SCANNED` set above any
  sequence's needs) and inline-only queues by default, so the reference never has to
  predict truncation; cap/window/page truncation is covered by the targeted adversarial
  shapes, not by proptest. Assert: identical takes, conservation, settlement
  path-independence (invariant 4), bitmap/BestTick coherence (weakened invariant 3),
  `open_lots` (invariant 2 with stale-slot exclusion), slot validity (invariant 9),
  **book never crossed (invariant 8)**. The contract crate is `no_std`; proptest runs
  in the test target only (`std` under `cfg(test)`), driving the contract through the
  SDK test env.
- **Differential settlement:** for every random history, settle every order at the end and
  assert Σ payouts + fees == Σ deposits exactly (fee dust included — the ceil is the
  only rounding; any other discrepancy is a bug).
- **Adversarial shapes:** max-depth single level (pages), 32-level worst-dispersal
  sweeps, tombstone-poisoned head (K dust rests, cancel 2..K−1, assert scan cap +
  persisted progress), **cancel-to-empty storms → LevelFull → reset → reuse**,
  stale-bit storms, cap/window-terminated places with crossing remainders, generation
  reset at sweep **and over dirty pages**, seq monotonicity, nonce collision/reuse,
  bound-saturating amounts on every public path.
- **Resource tests (the novel part):** the SDK test env exposes budget/footprint data —
  assert per-op entry counts and write bytes against architecture §17's table (derived
  from the worst-case matrix, not sampled). Regression gates, like Deepstate's
  `.gas-snapshot.runtime` but for footprints. Include the negative assertion: market
  ops never write the instance entry. **Padding correctness is invariant 6 as a set
  test:** for every race scenario, `recorded_keys(place) ⊆ declared_keys(sim)` — the
  test host records, the helper computes what a client would declare, and the
  assertion is inclusion, so no footprint *enforcement* mode is needed; a "trap" is
  asserted as a recorded key outside the declared set, expected only when the walk
  passes `pad_end`.
- **Archival tests:** cold level expired in test env → touched → counters intact;
  dormant `Order` expired → settle still pays. (Auto-restore path itself: testnet
  soak only — see M4.)

## Open questions for the implementer to resolve (with decision notes)

1. Inline level capacity `INLINE_SLOTS`, page capacity `PAGE_SLOTS`, `MAX_PAGES`,
   `MAX_LEVELS_CROSSED`, `MAX_SLOTS_SCANNED` — final values tuned from measured entry
   sizes/fees in M4. **Starting values (ADR-014):** `INLINE_SLOTS = 32`,
   `PAGE_SLOTS = 32`, `MAX_PAGES = 1`, `MAX_LEVELS_CROSSED = 32` (§17's worst-case
   rows assume it), `MAX_SLOTS_SCANNED = 64` (one full inline run plus one page —
   enough to clear any single-generation tombstone run at `MAX_PAGES = 1` in one
   take), `MAX_ROUTE_LEGS = 4`, `MAX_REPLACE_BATCH = 64` (§0.3).
2. Whether rest should offer the optional `extend_ttl`-to-180-d flag for `Order`
   in v1 (TTL targets themselves are resolved: protocol minimum ~120 d covers every
   entry class; see architecture §18 / ADR-004).
3. ~~`quote_place` return shape and the concrete `SlotWindow` encoding~~ — resolved
   (ADR-014): typed keys plus archived flags, not footprint XDR; `SlotWindow` is
   per-level inclusive page ranges plus one append range (interface sketch above).
4. Self-trade prevention flag in v1 (cheap: compare owner on head consume — but that
   reads `Order` in the hot path; likely defer).
5. Fee *split* (protocol/integrator) — custody and recipient are defined (architecture
   §1, §4, §12); Deepstate's dual-fee model remains a reasonable template for the split (both
   capped, both on taker output).
6. ~~Whether settle-at-head should also advance past tombstones in its declared page~~
   — resolved: it advances through its declared entries only and may leave the head
   on a tombstone at a page boundary (architecture §7 "stranded head"; ADR-012).
7. Nonce policy in the client SDK (random u64 vs per-owner counter) — the contract only
   requires "not currently live for this owner".
