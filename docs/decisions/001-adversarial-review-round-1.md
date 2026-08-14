# 001 — Adversarial review round 1: design adjustments before M0

An adversarial review of `04-architecture.md` / `05-implementation-plan.md` (2026-08-13)
found 3 critical, 8 serious, 6 minor issues. Both docs were revised. The changes, and
why:

## Critical — design-level fixes

1. **Padding race (the headline flaw).** The old rule padded "the next set ticks beyond
   the walk" — but any order rested at a *better* tick, or *between* set ticks, after
   simulation made the fill read an undeclared key and fail. A refundable 1-lot
   rest/cancel bot could fail essentially every in-flight taker; honest quote
   improvement did the same organically. Fix: `fill` takes `start_tick` (simulated
   best; better ticks are never visited, so late better-priced rests can't fail the
   tx), and padding is a **contiguous tick band** `[start_tick, pad_end]` of Level
   keys, set or not. Residual failure (walk past `pad_end`; sparse books can't always
   afford a deep band within 400 footprint entries) is now documented instead of denied.
2. **Unbounded tombstone scan.** Head-advance skipped tombstones with no bound — an
   attacker resting K dust orders and cancelling the middle poisoned the best price
   with O(K) scan cost for every taker; busy levels also accumulated dead slots
   forever (a healthy top-of-book may never fully sweep). Fix: `MAX_SLOTS_SCANNED` per
   fill with **persisted progress** (cleanup amortizes), `min_order_lots` per market,
   positional append-only slot layout (slot = pure function of seq — also resolves the
   "zero its slot" vs "remove head" contradiction), and pages behind `head_seq` are
   deletable (claims never read slots).
3. **Concurrency claim was false.** "Per-(market, side) clusters; markets fully
   disjoint" ignored that every settling op RWs the vault's SAC balance entries — one
   per (token, contract) — so all markets sharing a quote token serialize into one
   CAP-63 cluster. §4 now states this honestly; v1 accepts it (network write-bytes is
   the binding limit anyway); per-market vault sub-accounts are an explicit v2 item.

## Serious

4. **Entry sizes were ~2.5× optimistic** under `contracttype` map encoding (Level at
   N=32 ≈ 1.2 KB, not 500 B). Hot entries (`Level`, `Page`) are now mandated
   packed-`Bytes` with a schema-version byte; slots store qty only (seq is positional);
   `OrderRef` deduped to (owner, qty) — everything else is already in its key. Budget
   table re-derived.
5. **Cap-terminated fills could rest a crossing remainder** (crossed book, undefined
   everywhere). New invariant 8: never crossed; cap-terminated remainders are refunded.
6. **`Market` moved from instance to per-key persistent storage** — an instance-resident
   market table grows the one entry every invocation reads (and permissionless
   `create_market` made that an attack). Market creation is admin-gated in v1.
7. **Admin/upgrade/pause/fee-custody didn't exist** for a funds-custodying contract.
   New §6: init(admin, fee_recipient), upgrade, pause (blocks fill/rest only — cancel/
   claim always work), `claim_fees` pays the configured recipient (permissionless
   crank). Lazy schema migration via the version byte.
8. **Cancel-to-empty vs bitmap invariant contradiction.** Old invariant 3 (bit ⟺
   open) forced cancel to walk bitmaps and move `Best` (unbudgeted + re-imports the
   padding race). Chose lazy clearing: bit-set is only *implied by* open; stale bits
   cleared by the next fill that visits them; cancel stays O(1).

## Minor

9. `tick_min ≥ 1`; `create_market` enforces `max_order_lots × tick_max × tick_size ≤
   i128::MAX / 4` (checked-math aborts are panics by another name).
10. The only rounding in the system is the taker fee: `ceil(output × bps / 10⁴)`, dust
    to `Fees`. CLAUDE.md's "round quote in the maker's favor" was vestigial (matching
    is exact by quantization) and was reworded.
11. Max-sweep footprint row corrected to the true ceiling (~75: 32 levels can occupy
    32 distinct L0 words) so M4 resource gates test the worst case, not the typical.
12. P23 auto-restore is a simulation/tx-build feature — SDK tests assert TTLs and
    counter survival; the restore *path* is testnet-soak only. Plan says so now.
13. `route` bounded by `MAX_ROUTE_LEGS`; eager head-advance convention pinned
    (`head_consumed` strictly < head qty); sim-to-apply race tests pulled forward to M2.

## Verified and left alone

The claim state machine (counters as complete fill proof), sweep-without-reading-pages,
never-delete-Level, generation/page-key reuse, bitmap math (2048² ticks, O(1) hops via
L1), event budget, and M1-before-M2 risk ordering all survived attack unchanged.
