# 014 — Implementation plan readiness: decisions taken before M0

Date: 2026-08-17. Plan text only (`05-implementation-plan.md`); the architecture is
unchanged. These are the decisions the plan had deferred to "implementer's choice"
that M2 cannot start without, taken now with defaults so the milestones are
unblocked. Any of them may be revisited with a follow-up note once measured.

## 1. `SlotWindow` encoding — per-level page ranges plus one append range

```
PageRange     { first: u32, last: u32 }        // inclusive
ConsumeWindow { tick: u32, pages: PageRange }
SlotWindow    { consume: Vec<ConsumeWindow>,   // ≤ MAX_LEVELS_CROSSED
                append: PageRange }            // page 0 always implied
```

Why: it is the shape architecture §14 already describes ("for each set level in the
band, pages `[page(head_sim), page(head_sim) + width]`; for the taker's own rest,
`{page(tail_sim), +1, 0}`"), it is what the footprint tests assert against per level,
and a compact global form would have to be decoded back into exactly this to check
"head slot lies outside window[best]" (§8). A level absent from `consume` has an empty
window — its queue is inline — which is the common case and costs nothing to encode.
Argument size is bounded by `MAX_LEVELS_CROSSED` entries of three u32s.

## 2. `quote_place` — same walk code in dry-run mode, typed keys out

`matching.rs` exposes one walk with `Mode::{Apply, DryRun}`; `place` and `quote_place`
call the same function. Architecture §11 requires identical caps, lazy-clear decisions
and window logic, and a second implementation of the walk is the most likely place for
simulation and application to diverge by *logic* rather than by in-flight book
changes. `QuoteResult` returns typed keys (band `Level`s, covering words, own-side
keys) plus an archived flag per key, not footprint XDR: the SDK owns XDR assembly, the
tests want keys as sets, and the archived flags are what §14's marking rule consumes.

## 3. Footprint testing — inclusion, not enforcement

The claim in the plan that padding "gets coverage in M2, not first on testnet" needed
a mechanism. Decision: assert invariant 6 directly as `recorded_keys(place) ⊆
declared_keys(sim)` over the SDK test host's recorded footprint, with the M2 helper
computing `declared_keys` the way a client would. A "trap" is a recorded key outside
the declared set, expected only when the walk passes `pad_end`. This needs no
enforcing-footprint mode from the host, only access to the recording — the M0 spike
lands a `footprint_of(|| call)` helper and confirms that access; if exact key sets
turn out to be unreachable, M2/M4 fall back to entry-count and write-byte upper bounds
(CLAUDE.md already allows this) and say so in a note.

## 4. Starting values for the loop caps

`INLINE_SLOTS = 32`, `PAGE_SLOTS = 32`, `MAX_PAGES = 1`, `MAX_LEVELS_CROSSED = 32`,
`MAX_SLOTS_SCANNED = 64`, `MAX_ROUTE_LEGS = 4`, `MAX_REPLACE_BATCH = 64`.

`MAX_LEVELS_CROSSED = 32` is what §17's worst-case rows already assume.
`MAX_SLOTS_SCANNED = 64` is one inline run plus one page — a single take can clear any
tombstone run one generation can hold at `MAX_PAGES = 1`, so tombstone poisoning
(ADR-001) is cleared in one pass rather than amortized across several. `MAX_PAGES =
1` gives `LEVEL_CAP = 64` for the M3 page tests without making the §0.3 bound tight.
The route and batch constants are §0.3's targets. All of these are M4 tuning inputs,
not commitments; `set_market_caps` retunes the per-market ones without a redeploy.

## 5. Smaller plan edits

- M0 gains the footprint spike (above).
- M1's `create_market` checklist gains the `authorized(vault)` SAC check (ADR-012 L3).
- M2 states that the walk has a dry-run mode and that a minimal in-repo padding
  helper is built there and reused by M5's SDK, not reinvented.
- M3 fixes `PlaceLeg` / `LegResult`: a leg is `place`'s arguments minus `taker`; a
  result is `place`'s return tuple.
- M4's testnet soak must verify P23 per-entry restore opt-in — §14's "pad archived
  keys for free" depends on it, and 03 §Storage flags it for verification.
- Open question 3 closed; open question 1 now lists starting values and includes
  `MAX_LEVELS_CROSSED`.

## Left open, deliberately

Fee split (q5 — v1 ships a single recipient), `extend_ttl` flag on rest (q2),
self-trade prevention (q4), SDK nonce policy (q7). None blocks a milestone.
