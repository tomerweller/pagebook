# 044: Drop the slot-scan cap

Date: 2026-09-10. Removes `Market.max_slots_scanned` and the independent loop
budget that field fed. A `Market` layout change, so a redeploy (ADR-023).
Cutover follows the ADR-036 / ADR-037 procedure; the record is appended when
that happens. The deploy itself is outside this PR.

## Decision

Remove the independent slot-scan cap. `level_cap` is the bound. Keep the
whole-level sweep shortcut and `MAX_LEVELS_CROSSED` (still shared across
route legs).

`consume_partial` scans to demand or to the tail. `advance_head` skips the
whole zero run. Drop `max_slots_scanned` from `Market`, `set_market_caps`,
and the client `MarketInfo`.

Invariant 7: slots scanned per transaction ≤ `MAX_ROUTE_LEGS × LEVEL_CAP_MAX`
= 512.

Keeping the field and forcing it to `level_cap` was rejected: a dead field
and a dead parameter that every reader must learn is meaningless, and a
redeploy is the project's normal path for layout changes (ADR-036, ADR-037).

## Why

`Market.max_slots_scanned` predates ADR-037. A level's whole queue is one
`Level` entry of at most `level_cap` (≤ `LEVEL_CAP_MAX` = 128) slots, and a
walk consumes partially at most once, so slot iterations are already bounded
by `level_cap` per place and per settle, and by `MAX_ROUTE_LEGS × level_cap`
per route. At the default caps (64/64) the scan cap cannot bind in any
single `place` or `settle`. It only changed outcomes for routes whose later
partial legs were starved by the shared budget, and for markets raised above
64 slots.

Measured on the WASM test host (soroban-sdk 27.0.6, fresh env per shape,
equal storage and SAC transfer counts within each pair):

| Shape | WASM instructions | Native |
|---|---|---|
| 128-deep level, partial take, 2 slots read | 2,192,579 | 1,510,884 |
| 128-deep level, partial take, 64 slots read | 2,382,963 | 1,527,111 |
| 128-deep level, partial take, 128 slots read (cap = level_cap) | 2,588,093 | 1,547,046 |
| same request under cap 64 (stops at 64 slots, refunds) | 2,730,561 | 1,870,844 |
| tombstoned level, partial take, 1 slot read | 2,382,983 | 1,722,783 |
| tombstoned level, partial take over 126 tombstones, 128 slots read | 2,719,644 | 1,759,232 |
| same under cap 64 (head stranded, refunds) | 2,928,060 | 2,117,982 |
| settle tail order, no head advance | 1,501,709 | 915,238 |
| settle head, advance over 64 zeros (cap 64) | 1,664,874 | 934,312 |
| settle head, advance over 126 zeros | 1,831,503 | 952,393 |
| route 4 legs, 8 slots read | 8,907,151 | 7,643,949 |
| route 4 legs, 4 × 128-slot partial (512 slots) | 10,489,207 | 7,788,597 |

Write entries / write bytes are the same in each pair (partial take 7 /
2,920; settle 5 / 2,288; route 13 / 8,776). Marginal cost ≈ 3.1k WASM
instructions per slot (≈ 300 native). Worst uncapped shape is +1.6M
instructions per transaction: 0.4% of the 400M cap, ≈ 1,100 stroops at 7
per 10k.

Every capped shape cost more instructions than the uncapped one, because a
cap-induced stop adds a refund transfer. The cap bought nothing and cost a
state machine: `Budget.slots`, `clamp_to`, the cap clause of
`crossing_remains`, the bounded `advance_head`, the §7 stranded-head-by-cap
clause, a `Market` field, a `set_market_caps` parameter, and a client
protocol field.

## Fill and refund behavior

A call that refunded after hitting the scan cap now consumes more liquidity.

- A 100-lot take on a 128-deep level of 1-lot asks takes 100 in one call
  (it took 64 and refunded 36).
- A route with a partial level on every leg no longer starves later legs:
  two 64-deep 2-lot levels, 127 lots each, both take 127 (the second leg
  refunded after the shared 64-slot budget ran out).
- Settling the head of a tombstone run longer than 64 advances past the
  whole run in one call (it left the head stranded).
- A rest-allowed remainder still refunds when `MAX_LEVELS_CROSSED` ends
  the walk.

## What changed

- `MAX_SLOTS_SCANNED` and `Market.max_slots_scanned` removed.
- `Budget` keeps only `levels`. `consume_partial` and `advance_head` bound
  on `tail = slots.len()`, which `append` keeps at or under `level_cap`.
- `set_market_caps` loses the `max_slots_scanned` parameter. Client
  `MarketInfo` drops the field.
- Architecture §1, §2, §7, §8, §12, §19; 05, 06, 07, 08; two explainer
  sentences.
- Tests: `raised_level_cap_allows_a_deeper_queue` flipped;
  `settle_head_advances_past_the_whole_tombstone_run`,
  `taker_skips_a_long_tombstone_run_in_one_call`,
  `route_partial_levels_on_each_leg_take`,
  `bound_route_four_full_partials`.

## Cutover record

Not yet. Procedure as in ADR-036 and ADR-037. Appended when it happens.
