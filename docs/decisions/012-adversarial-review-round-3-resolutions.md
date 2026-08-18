# 012 — Adversarial review round 3: resolutions

Date: 2026-08-17. Resolves every finding in ADR-011 (Kimi K3 review of the docs at
e1c57b5) and answers its open questions. All changes are to the docs; no design
mechanism was added or removed — every fix is a sentence the design already implied
and the normative text failed to say, plus one arithmetic correction (M1) and one
pseudocode reorder (L1). Section numbers refer to `04-architecture.md`.

## High

**H1 — §14 omitted the taker's own-side rest keys.** §14's pad list is now split by
side and declared exhaustive: opposite side — band `Level`s, covering `TickWord`s, that
side's `TickSummary` and `BestTick`, per-set-level page windows; own side —
`Level(own_side, limit_tick)` (set or not), `TickWord(own_side, word(limit_tick))`,
own-side `TickSummary` and `BestTick`, `Order(taker, nonce)`, append pages; plus both
vault balances and `FeeAccrual`. The explainer's padding figure and its aria-label say
the same. M2 gets an assertion: a resting place's simulated footprint contains the
own-side `Level` key.

**H2 — §9's "set bits if new" under-specified re-liquification.** §9 now says: if
`open_lots` was zero before the rest — level new, swept, or cancel-emptied — set the
tick's `TickWord` bit and its word's `TickSummary` bit idempotently; an existing
`Level` entry is not a reason to skip. §5's lifecycle states the same rule and defines
the `BestTick` empty flag: set only when a walk's `next_set_tick` finds no set bit;
cleared by any rest on that side, which takes `BestTick` regardless of how the stale
recorded tick compares. Invariant 3 (§19) names the maintaining operation. M2 tests:
sweep → re-rest same tick; lazy-clear → re-rest; empty side → rest at a tick worse
than the stale recorded best.

## Medium

**M1 — "4× headroom for fee math" did not cover `output × fee_bps`.** Accepted the
review's second option: §0.2 now mandates the split form
`fee = (output ÷ 10_000) × fee_bps + ceil((output mod 10_000) × fee_bps / 10_000)`,
identical to `ceil(output × fee_bps / 10_000)` and never forming an intermediate
larger than `output`. §0.3's bound is unchanged in value; its 4× is now described as
slack for sums, and the text says fee math needs no headroom. §8's pseudocode
references the split form. No joint constraint on `MAX_ROUTE_LEGS` is needed. The
ADR-002 finding-3 resolution is thereby actually closed.

**M2 — restore rent on padded archived keys.** The premise that padded archived keys
are charged every cycle does not hold, for two reasons the docs now state. (a) P23
restore is opt-in per footprint entry: a declared-but-unlisted archived key costs a
footprint slot and traps only if execution touches it (03 §Storage, now explicit, with
a note to verify against the live host in M4). The SDK marks for restore exactly what
simulation touched (`quote_place` reports archived entries, §11) and pads everything
else unmarked (§14 "Archived keys in the pad"). (b) The only way the walk touches an
archived `Level` is a stale bit over it; the walk that lands there restores it (~0.064
XLM, shown by simulation) and clears the bit, after which nothing touches that level
until someone rests there. Each seeded stale bit therefore costs at most one restore
ever, less than its author's rest-plus-cancel (~0.09), and burns one
`MAX_LEVELS_CROSSED` slot for one taker (already-known stuffing economics). §5, §15,
§17 restate "declared-but-untouched is free" with that qualification. Nothing can turn
an unmarked archived key into a touched one in flight, since a rest at that tick
restores it first — so no new trap class.

**M3 — §7 rows never decremented `open_lots`.** Rows 3 and 4 now carry
`open_lots −= q − C` and `open_lots −= q` in bold, with a paragraph on why it is
load-bearing (sweep pays from `open_lots` without reading slots). §2 states the rule
generally (every operation that removes lots decrements). Invariant 2 is restated as
`open_lots == Σ live slot qtys − head_consumed_lots` in §2 and §19; the explainer's
settle figure and invariant list match. M1's differential-settlement test names this
case.

**M4 — `create_market` check list incomplete.** §12 now lists every check with its
error: `base ≠ quote` (`SameToken`, new), `1 ≤ tick_min < tick_max ≤ 2^22`
(`TickOutOfBand`), quantization and lot bounds, the §0.3 bounds, `FEE_BPS_MAX`. §0.3
and §5 carry the coverage bound. Sortedness is dropped rather than enforced: §0.1 now
says base/quote is a *semantic* order (asks escrow base), not lexicographic, and that
several markets may share a pair with different quantization. Together with I3 that
removes `MarketExists` from 05's error taxonomy; a pair index is listed in §20 as a v2
companion to permissionless creation.

## Low

**L1 — post-sweep scan can trap a completed take.** §8's pseudocode breaks before
`next_set_tick` when `qty_lots == 0` and leaves `BestTick(opposite)` at the swept
tick (stale-better, legal under invariant 3); a paragraph explains the trap it
removes and the ~0.09 XLM attack it defuses. §14 says the band never needs to extend
past the deepest level a take can consume. When the scan does run and finds nothing,
it sets the empty flag (H2).

**L2 — `RetryRest` griefing unpriced.** §9 prices it: attacker needs `PAGE_SLOTS + 1`
to `2 × PAGE_SLOTS` same-level rests (~1–1.9 XLM, unrecoverable rent) landed ahead of
the victim in the same ledger; victim loses one failed-tx fee (~0.037) and the walk's
persisted cleanup reverts with it. 25–50:1 against the attacker; all-or-nothing
stands. §8's "always persisted" is qualified to successful transactions.

**L3 — asset eligibility undocumented.** §12 gains an "Asset eligibility" bullet: the
vault is a SAC contract balance (no trustline; created by first transfer in — answers
open question 7); auth-required assets make the vault unauthorized until the issuer
opts it in (`create_market` SHOULD refuse when the SAC's `authorized(vault)` is
false — one read of a trusted SAC); issuer freezes gate `settle` at the asset layer,
funds stay in the vault; clawback is unobservable on-chain and is disclosed as
residual issuer trust; a taker's frozen output balance fails only that taker.

**L4 — `keepalive` incentive vacuum.** §12 and §18 document the lapse path (next
market op auto-restores at ~2.3 XLM, shown by simulation; venue self-heals) and the
operational expectation (custodial deployments schedule the crank). A reimbursing
crank paid from `FeeAccrual` is listed in §20 for v2.

## Informational

**I1 — fee table assumes hot state.** §17 says so and adds three increment rows —
new `LevelPage` (+~0.053), new/restored `TickWord` (+~0.043), settle/replace of an
archived `Order` (+~0.027) — so any row composes into its worst case. §10 notes that
a `replace` after archival pays the `Order` restore.

**I2 — `generation` wraparound.** §2: the increment is checked and fails `Overflow` at
`u32::MAX`; the width is justified (2^32 resets at one tick ≥ 10⁸ XLM and ~136 years
at one per second).

**I3 — `MarketExists` implied a pair index.** Removed from 05's taxonomy (see M4).

**I4 — stranded head at a page boundary.** §7 gains a "Stranded head" paragraph:
settle advances through its declared entries only, may leave `H` on a tombstone,
this is safe (everything behind is correctly open, nothing settles at `H`, the next
take with a covering window re-cleans), and settle MUST NOT widen its footprint to
advance further. 05's open question 6 is marked resolved.

## Open questions from ADR-011, answered

1. Rest-side key set — H1. 2. Restore granularity — opt-in per entry; M2; verify in
M4. 3. Constants — §0.3 now gives targets `MAX_ROUTE_LEGS = 4`, `MAX_REPLACE_BATCH =
64` (event budget) and states no fee-headroom constraint exists after M1. 4. Empty
flag — H2/§5. 5. Band depth — L1/§14: never past the deepest consumable level.
6. Payout destination — §7: always `owner` from the `Order` key. 7. Vault trustlines —
L3: none; SAC contract balance. 8. `quote_place` fidelity — §11: MUST run the same
walk code read-only and report archived entries. 9. Stranded head — I4. 10.
`keepalive` funding — L4.

## Not changed

Kimi's "checked and found sound" list (settlement interleavings, conservation flows,
empty-level reset, stale-slot rule, tombstone poisoning, `start_tick` scoping,
post-only fail-closed, fee ceil, auth surface, reentrancy, route caps, counter widths)
stands as written; nothing in this round touched those mechanisms.
