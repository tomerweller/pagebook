# 020 — PR #1 review, round 1: findings and fixes

Date: 2026-08-17. A code review of the M0 to M3 branch (eight finder angles, one
verify pass, several findings reproduced in the SDK test env) found ten issues.
All are fixed on the branch; this note records what was wrong, what changed, and
two small deviations from the plan that the fixes required.

## Findings and fixes

1. **`route` and `replace_batch` could not succeed with real input.** Both called
   `require_auth` for the same address more than once in one frame (once at the
   entry point, again per leg or item), which the host rejects. Fix: the entry
   points authenticate once and check pause once; `matching::place_body` and
   `replace::replace_body` carry no auth and no transfers.
2. **The walk wrote `BestTick(opposite)` worse than the true best.** A walk that
   started at a `start_tick` worse than the recorded best (legal per §8) wrote
   BestTick from wherever it ended, including `empty`, while the recorded best was
   still live and unvisited (invariants 3 and 8; a crossed book was reproducible).
   Fix: BestTick moves only when the walk *began at the recorded best*
   (`recorded.empty || recorded.tick == cur`).
3. **The walk did not advance `BestTick(opposite)` past a sweep** when the next set
   tick did not cross the limit, so the "still crosses" check read the swept tick
   and refunded a remainder that should have rested; after any cancel at the best,
   nobody could rest inside the gap. Fix: the walk moves BestTick to where it
   stands (a set-bit tick, the partial level, or the last swept tick when the
   quantity was exhausted there) and emits `top_changed`; the rest decision uses
   the walk's own `crossing_remains` plus, when the walk did not begin at the
   recorded best, the recorded best.
4. **`next_set_tick` was unbounded** and could load a `TickWord` far past `pad_end`
   (the trap class §8 forbids). Fix: bounded by `limit_tick`'s word; a `None`
   inside the bound means "nothing up to the limit's word", not "side empty".
   The side is marked empty only when the bound reaches the band's last word.
5. **Route caps were per leg and nothing netted.** Fix: `Budget{levels, slots}` is
   shared across legs (clamped to each leg market's caps); `Netting` accumulates
   per token and the entry point flushes once (one SAC transfer per token) for
   `place`, `route`, `replace`, `replace_batch`.
6. **`quote_place` and the client `pad` were incomplete.** Fix: `quote_place`
   returns the levels the walk visited (`CrossedLevel{tick, head_seq, open_lots}`)
   and the exhaustive PageBook key set on both sides; the client `pad` adds
   `Order`, both `FeeAccrual`s, both vault balances, opposite-side consume pages,
   and returns the `SlotWindow`; `keys_for_settle` uses `page(seq)`; a level absent
   from the consume window is inline-only (05 "Encoding decisions"), enforced by one
   `head_in_window` predicate.
7. **The stale-bit clear created entries.** Every place whose `start_tick` fell in an
   unpopulated opposite-side word (every pure rest against an empty side) wrote
   `TickWord`, `TickSummary`, and `BestTick` on the opposite side. Fix: bitmap set /
   clear are idempotent (no write when unchanged); BestTick is written only when it
   changes.
8. **A take remainder below `min_order_lots` reverted the whole place.** Fix: such
   a remainder is refunded, never rested and never a failure.
9. **Missing test suites.** Added: regression tests for 1 to 8, the sim-to-apply
   race suite with `touched ⊆ declared` inclusion, per-entry-point footprint upper
   bounds, pages / `LevelFull` / stale-slot tests, re-liquification, route across
   markets with netting, and a proptest against a reference book with differential
   settlement (see the test files).
10. **Decode failures were `Overflow`; a bad bitmap read as empty.** Fix:
    `CorruptEntry` for any present-but-undecodable entry, `NotInitialized` for a
    missing Config; `bitmap::load` no longer defaults silently.

## Deviations recorded here

- **Archived flags come from RPC, not `quote_place`.** ADR-014 had `quote_place`
  return an archived flag per key. A contract cannot observe archival (an archived
  entry cannot be read), so the flag was always false. `quote_place` now returns
  the *touched* key set; the client's `restore_marks` intersects it with what RPC
  reports archived. Architecture §11/§14 and 05 are updated.
- **Recorded reads via a store trace, not `Mode::Trace` on the walk.** ADR-016
  planned a walk-level trace. The fix instruments `store.rs` and `bitmap.rs` under
  `cfg(test)` so every key the contract loads or saves is recorded; the inclusion
  test `keys_touched(place) ⊆ declared` therefore covers the whole invocation, not
  only the walk. This is rung 2 of ADR-016's ladder for reads, met.
- **`BestTick` after a sweep: next set tick, frontier, or empty.** §8 had said the
  walk stops without scanning after the last sweep and leaves BestTick on the swept
  tick. With the scan bounded to `limit_tick`'s word (declared by every pad) it
  cannot trap, so it runs after every sweep, the last one included; on "nothing up
  to the end of limit's word" BestTick stands on that word's frontier (last tick in
  the walk direction: no bit, never worse than the true best) rather than on the
  swept tick, which had been false-rejecting the other side's post-only orders and
  replaces until liquidity reappeared nearby; the side is marked empty only when
  the scan reached the band's last word; an empty recorded side is never overwritten
  with a frontier. §5 and §8 are updated.
- **`TickWord` / `TickSummary` size.** §5's table now shows the measured 268 B XDR
  (257 B payload) per ADR-017 instead of the earlier 256 B target.

## Milestone status after this round

M0, M1 done. M2 and M3 done by the plan's own list once the suites in item 9 are
green. M4 remains partial (ADR-019). M5's client crate now produces the exhaustive
key set and the window.
