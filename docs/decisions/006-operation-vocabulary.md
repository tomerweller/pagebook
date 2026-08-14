# 006 — Unified operation vocabulary

Date: 2026-08-14. The docs had grown an unhelpful mix: `fill` named an entry point
after only one of its two behaviors (it also rests), `cancel` named the maker exit
after only one of its two outcomes (it also claims), and tables mixed function names
with behavior words ("rest", "taker") without saying which was which.

## The vocabulary (normative; architecture §0)

- **Entry points** — what a caller invokes: `place`, `replace` / `replace_batch`,
  `settle`, `route`, `create_market`, the cranks (`collect_fees`, `keepalive`), admin
  functions.
- **Behaviors** — what an invocation did: **take** (consume resting liquidity),
  **rest** (leave an order on the book), **sweep** (consume a whole level). One
  `place` may both take and rest.
- **Roles** — maker (order rests), taker (takes).
- **Order states** — open → partially filled → filled. "Fill" is only ever an order
  state (or the industry-standard flag `fill_or_kill`), never an operation.
- Settling an open order *cancels* it (tombstones its slot); settling a filled order
  *claims* its proceeds. "Cancel" and "claim" name outcomes of `settle`, not
  operations.

## Renames

| Old | New |
|---|---|
| `fill()` | `place()` |
| `cancel()` | `settle()` |
| `claim_fees()` | `collect_fees()` |
| `quote_fill()` | `quote_place()` |
| `FillFlags` / `FillLeg` | `PlaceFlags` / `PlaceLeg` |
| `MAX_LEVELS_PER_FILL` | `MAX_LEVELS_CROSSED` |
| event `claimed(...)` | event `settled(...)` |
| "claim logic / claim table" | "settlement logic / settlement table" |

Fee and budget tables are now labeled "entry point — outcome" (e.g. "place — rest
only (existing level)", "place — take 8 levels + rest remainder", "settle"), so a row
never leaves the reader guessing which function produced it.

Kept unchanged: `fill_or_kill` (industry-standard flag name, consistent with "filled"
as a state), `rested` / `filled` / `swept` events (they report behaviors and states),
and historical ADRs 001–005, which keep the vocabulary of their time.

Applied to: 04-architecture (plus a normative Vocabulary subsection in §0),
05-implementation-plan, CLAUDE.md ground rules, and the published explainer
(artifact + GitHub Pages).
