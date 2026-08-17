# 008 — Storage naming: rename entries, regroup by reconstructibility

Date: 2026-08-17. Prompted by a naming review of architecture §1 before any code
exists — renames are free now and expensive after M0.

## Decision

Storage entry and coordinate names change as follows (applied across `docs/` and the
explainer; ADRs 001–007 keep the old names as historical records — this note is the
mapping between them and the current docs):

| Old | New | Why |
|---|---|---|
| `OrderRef` | `Order` | "Ref" implied a pointer to an order stored elsewhere; there is no elsewhere — the queue slot holds a bare qty and this entry holds side, tick, generation, seq, qty. It *is* the order. |
| `Admin` | `Config` | The entry holds admin address, fee recipient, paused flag, and the market counter — only one of four fields is about the admin. Still a unit variant on instance storage. |
| `TickBitmap` | `TickWord` | The summary/leaf tiers are the same shape (2,048 bits, 256 B), but one was named for its role and the other for its representation, hiding the pairing. Now: `TickSummary` bit `word` is set iff `TickWord(word)` has a set bit. |
| `Fees` | `FeeAccrual` | Read like config (one letter from `fee_bps`) while actually being money. Also fixes an arity inconsistency (`Fees(token)` vs `Fees(mkt, token)`). |
| `mkt`, `mkt_id` | `market`, `market_id` | §1's full-word rule, applied to key coordinates too. |
| `w`, `p` (key coords) | `word`, `page` | Same. |
| `N`, `P` | `INLINE_SLOTS`, `PAGE_SLOTS` | Every other bound is a full-word constant; the two most-referenced ones were single letters. `LEVEL_CAP = INLINE_SLOTS + PAGE_SLOTS × MAX_PAGES` needs no lookup. |
| `total_open` | `open_lots` | Unit suffix, matching `qty_lots` / `max_order_lots`. |
| `head_consumed` | `head_consumed_lots` | Same. |

`Level`, `LevelPage`, `Market`, `BestTick`, `TickSummary` are unchanged. The local
math symbols `(G, H, C)` in the settlement table are unchanged.

Grouping in §1 changes from "Config & fees / Tick index / Order store" to:

- **Configuration** — `Config`, `Market`: money-free, admin-governed.
- **Order store** — `Level`, `LevelPage`, `Order`, `FeeAccrual`: authoritative,
  funds-bearing, reconstructible from nothing.
- **Tick index** — `BestTick`, `TickSummary`, `TickWord`: derived, rebuildable from
  the order store, may run stale.

The taxonomy is the design's own reconstructibility rule. `FeeAccrual` moves out of
the config group because it is funds-bearing (it appears in conservation invariant 1);
grouping it with admin config misstated its risk class.

## Considered and rejected

- `Claim` for `OrderRef` — reads well with settle's cancel/claim outcomes, but
  overloads "claim" as both an outcome and an entry name.
- `Venue` for `Admin` — matches the doc's word for the whole contract; `Config` chosen
  instead (reviewer preference; equally accurate, more conventional).
- `TickRoot`/`TickLeaf` — scales to a third tier that v1's 4.19M-tick range will
  never need; `TickWord` is more concrete.
- Renaming `LevelPage` (e.g. `LevelOverflow`) over the page-0-origin trap — kept
  instead, with the origin now stated explicitly at the table row: page `page` holds
  seqs from `INLINE_SLOTS + page·PAGE_SLOTS`; the first seqs past the inline slots
  land in page 0.
- `TickCursor` for `BestTick` — invariant 3 makes it a walk-start hint, not a fact,
  but "best tick" is the term traders use and the invariant is clear enough.
