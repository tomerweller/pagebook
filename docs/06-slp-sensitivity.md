# SLP sensitivity: how PageBook tracks validator-voted limits

*Snapshot: August 2026, protocol 23+ era. Soroban's resource limits are network config
settings that validators retune every few months through the SLP process
(github.com/stellar/stellar-protocol/limits). This doc classifies PageBook's variables
by what may change when they do, describes the adaptation mechanism, and ranks the
changes PageBook should advocate for.*

## Market variables and their mutability classes

| Class | Variables | Rule |
|---|---|---|
| Frozen forever | `base`, `quote`, `lot_size`, `tick_size`, `[tick_min, tick_max)`, `INLINE_SLOTS`, `PAGE_SLOTS`, bitmap geometry, packed layouts (versioned) | Slot location is `f(seq, INLINE_SLOTS, PAGE_SLOTS)` and price is `f(tick, tick_size)` — changing them corrupts live state. A different geometry is a different market. |
| Frozen unless re-proved | `max_order_lots`, `MAX_PAGES` (via `LEVEL_CAP`) | The §0 overflow proof depends on them. `set_market_caps` re-runs the proof; `MAX_PAGES` is raise-only (existing seqs may live beyond a lowered value). |
| Retunable | `MAX_LEVELS_CROSSED`, `MAX_SLOTS_SCANNED`, `taker_fee_bps` (≤ `FEE_BPS_MAX`), `min_order_lots`, `MAX_REPLACE_BATCH`, `MAX_ROUTE_LEGS` | Pure runtime bounds sized to fit per-tx limits. No storage migration; `set_market_caps` (architecture §6) for the per-market ones. |
| Automatically adaptive | `pad_end` band width, slot-window sizes, batch composition | Chosen per transaction by clients against live config over RPC. No contract change needed when limits move. |

## Why retuning needs a transaction: contracts cannot read config

Verified against the host interface (`soroban-env-common/env.json`): network config
settings live in `ConfigSettingEntry` ledger entries, a key type contracts cannot
declare or read. The `context` module exposes protocol version, ledger sequence,
timestamp, network id, own address, and exactly one config-derived value
(`get_max_live_until_ledger`, needed by `extend_ttl`). There is no host function for
resource limits, fee rates, or remaining budget — so "do work until near the budget"
is not implementable, which is why the loop caps exist as stored numbers at all.
Protocol version is readable but is the wrong signal: SLPs move limits without a
protocol bump.

Consequence: adaptation is two-layer. Clients self-tune per transaction; stored caps
follow through `set_market_caps`, an authorized transaction informed off-chain. The
contract re-proves its own §0 bound on-chain but cannot check caps against live
limits; that judgment is the admin's.

## What actually binds PageBook (current mainnet values)

| Limit | Value | Does it bind? |
|---|---|---|
| Ledger write bytes | 286,720 | **Yes — the throughput ceiling.** ~13 max sweeps or ~12 full maker refreshes per ledger, venue-wide. |
| Tx footprint entries | 400 | **Yes — the only remaining trap.** Bounds band depth on sparse books, plus `replace_batch`/route composition. |
| Dependent-tx clusters | 2 | Not yet — the venue is one cluster until per-market vault sub-accounts (v2). |
| State target size | 3 GB | Indirectly — the 1,000/KB rent floor holds only while live state stays under ~1.9 GB; past it, maker slot rent scales toward 10×. |
| Tx writes / ledger write entries | 200 / 1,000 | No (write bytes bind first). |
| Instructions / events / tx size | 400M / 16 KB / 132 KB | No (worst cases ~25M / ~6.4 KB / ~28 KB). |

## The advocacy agenda, ranked

The SLP process evaluates proposals against ledger close time (95%+ under ~500 ms on
model validators), state growth vs archival capacity, hardware demands, and a stated
policy that ledger-wide limits should be at least 5× per-transaction limits. Per-tx
raises are "basically irreversible"; ledger-wide raises are emergency-reversible and
therefore easier to grant.

1. **Raise ledger write bytes (286,720 → ~660 KB+).** The direct throughput
   multiplier for every state-mutating protocol. The sharp argument: the network's own
   5× ratio policy is violated here — ledger write bytes are only 2.2× the per-tx cap
   (132,096). This ask is compliance with their stated ratio, and it is the reversible
   kind.
2. **Raise the per-tx footprint entry cap (400 → 1,000+), or price declared-untouched
   live entries as a cheaper class.** The PageBook-specific ask. Post-P23,
   declared-but-untouched live entries cost validators nearly nothing (live state is
   in memory; untouched entries are not read; zero close-time and state-growth
   impact) — the fee model already reflects this (~300 stroops each) but the limit has
   not caught up. Granting it removes PageBook's one residual failure mode (sparse-book
   band traps) and widens batch/route composition. Since per-tx raises are
   irreversible, this is the one to argue with benchmarks, per the process.
3. **Raise dependent-tx clusters (2 → 4+), sequenced after v2 vault sub-accounts.**
   More threads do nothing for the venue while it is one cluster. Ship the
   sub-accounts, then bring a live venue as the demand evidence the process asks for.
4. **Keep the state target ahead of live state.** A rent-curve defense rather than a
   limits raise: maker slot economics (~0.027 XLM per 120 d) silently scale toward 10×
   if live state approaches the 3 GB target without a target raise.
5. **CAP-class wishlist (protocol changes, not SLPs):** a read-only host function
   exposing selected config values, and/or budget introspection. Precedent exists —
   `get_max_live_until_ledger` exposes one config value because `extend_ttl` needs
   it — and "on-chain protocols whose safety caps must track validator-voted limits"
   is the same shape of need. Low urgency (admin retuning covers PageBook), worth
   raising when the ecosystem discusses host additions.

## Operational hygiene

- M4's resource and fee gates record the config snapshot they were calibrated against
  (the fee gates already isolate and record the rent rate); a quarterly SLP then shows
  up as a CI diff, not a production surprise.
- Re-verify live values with `stellar network settings` before hardening milestones;
  03 §Resource limits carries the citation trail.
