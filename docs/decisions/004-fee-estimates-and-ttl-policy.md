# 004 — Resource-fee estimates and the TTL policy correction

Date: 2026-08-13. Fee rates were pulled live from mainnet
(`stellar network settings` against a public RPC) rather than from docs pages, and the
rent formula from `rs-soroban-env/soroban-env-host/src/fees.rs`.

## Two doc corrections (reality over docs, per CLAUDE.md)

1. **`docs/03` claimed minimum persistent TTL ≈ 4,095 ledgers. Mainnet says
   2,073,600 (~120 days at 5s), max 3,110,400 (~180 days).** This is a CAP-66-era
   change and it *simplifies* the design: entries live in prepaid ~120-day chunks, so
   the §5 policy table of per-op TTL bumps was deleted. **No hot path extends a TTL**;
   the only recurring rent obligations are the `keepalive()` crank (instance + wasm
   code) and an optional maker opt-in extending `OrderRef` to 180 d.
2. **`docs/03` had fee shape but no values.** Now recorded (snapshot Aug 2026):
   instructions 7 stroops/10k; write entry 2,500; write/rent rate 1,000/KB (protocol
   floor — interpolates to 10,000/KB as live state approaches the 3 GB target); events
   5,000/KB refundable; tx bytes ≈ 4.4 stroops each (406 bandwidth + 4,059 historical
   per KB); live-state reads free post-P23 (disk fees apply only to archived/classic).
   Rent = `size × rate × ledgers / (1024 × 1,215)` persistent ⇒ **~1,667 stroops
   (~0.000167 XLM) per byte per 120-day chunk** at the floor.

## Estimates (methodology in one line each)

Per-op fee = writes×2,500 + write-KB×1,000 + rent(new entries, 120 d) + insns×7/10k +
tx-KB×4,465 + event-KB×5,000. Write/byte counts from §4's budget table; instruction
counts are engineering guesses (±3×) and don't matter — they're single-digit
percentages of every row. Results (also in §4):

| Op | Estimate |
|---|---|
| rest (existing level) | ~0.029 XLM |
| rest (first touch/restore of a tick) | ~0.094 XLM |
| cancel / claim | ~0.002 XLM |
| taker, 8 levels swept | ~0.009 XLM (+0.027 if remainder rests) |
| max sweep, 32 levels | ~0.027 XLM |
| create_market | ~0.043 XLM |
| claim_fees | ~0.001 XLM |
| keepalive (venue-wide) | ~2.3 XLM per ~120 d (mostly 40 KB wasm at ⅓ code discount) |

## What the numbers taught us (fed back into the design)

- **Rent on entry creation dominates; execution is noise.** An `OrderRef` (160 B ×
  120 d ≈ 0.027 XLM) costs as much as an entire 32-level sweep. The protocol's cost
  center is order *placement*, not matching — which is the right shape for a CLOB, and
  a free-standing anti-spam floor that stacks with `min_order_lots` (a K-order dust
  storm costs ~0.027 K XLM, non-refundable).
- **Padding is economically free** (~300 stroops per declared-but-untouched key; live
  reads cost nothing). The padding budget is the 400-entry cap, never the fee — so
  clients should err toward wide bands.
- **Level rent (~0.064 XLM) is per tick per ~120 days of activity** — `Level`s are
  never deleted, so only first-ever touches and post-archival restores pay it.
- **Volatility:** every rent-dominated row scales with the state-size-dependent rate
  (floor 1,000/KB today, 10× at the 3 GB target). M4's fee gates must record the rate
  they were calibrated at and assert the non-rent components separately.

## Plan changes

M4 gains fee gates (measured vs §4 table, rent isolated) and a "no rent in hot paths"
negative assertion. Open question 2 narrowed to the optional `OrderRef` 180-d
extension flag.
