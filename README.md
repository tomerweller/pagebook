# PageBook

A central limit order book (CLOB) designed natively for Stellar's Soroban runtime.

**Status: design phase.** No contract code yet — this repo currently holds the research
and architecture that an implementing agent/engineer should work from.

## Why this exists

On-chain CLOBs keep being redesigned around each runtime's storage and concurrency
model: Serum/Phoenix/Manifest around Solana's account list, DeepBook around Sui's shared
objects, Econia around Aptos tables. Soroban has its own model — declared footprints,
per-byte write fees, TTL/state-archival, footprint-clustered parallel execution — and a
design that works *with* those properties looks different from a port of any existing
book. PageBook is that design: price-level entries at predictable keys,
cumulative-fill accounting, crankless atomic settlement, deferred O(1) maker claims, and
state archival used as the garbage collector.

The proximate trigger was evaluating `deepstate-contracts` (an elegant EVM radix-tree
matching engine) and finding that its content-addressed storage keys — its best feature
on EVM — are fundamentally incompatible with Soroban's simulation-time footprints. See
`docs/02-deepstate-evaluation.md`.

## Repo map

| Path | What it is |
|---|---|
| `CLAUDE.md` | Working instructions for the implementing agent |
| `docs/01-prior-art.md` | Survey: Solana CLOBs (Serum, Phoenix, OpenBook v2, Manifest), Sui DeepBook v3, Aptos Econia, appchains, SPEEDEX — and the convergent lessons |
| `docs/02-deepstate-evaluation.md` | Deep review of deepstate-contracts: what's brilliant on EVM, measured gas profile, and exactly why it doesn't translate to Soroban |
| `docs/03-soroban-constraints.md` | The resource limits, storage/archival semantics, and P23 execution model the design targets (with sources, as of Aug 2026) |
| `docs/04-architecture.md` | **The PageBook design.** Storage schema, matching algorithm, claims, footprint padding, TTL policy, fees, events |
| `docs/05-implementation-plan.md` | Proposed crate/module layout, storage keys, public interface, invariants, test strategy, milestones |

## Design in one paragraph

One contract hosts many markets. Each price level is one small persistent entry keyed
`(market, side, tick)` holding a packed FIFO plus three counters (`generation`,
`head_seq`, `head_consumed_lots`); a per-side bitmap and a `Best` pointer index the levels.
Takers sweep k levels with k small writes and settle atomically via SAC transfers —
makers are never touched during matching. Makers claim later in O(1) by comparing their
packed order id against the level counters (generation advanced ⇒ fully filled). All
keys are computable client-side, so transaction footprints can be *padded* with adjacent
levels at simulation time — concurrent book movement degrades gracefully instead of
hard-failing. Cold state (empty levels, dormant claims) is never deleted; it archives
via TTL and auto-restores on touch, with restore costs landing on the beneficiary.

## Headline numbers (against Aug 2026 mainnet limits)

A padded 8-level taker fill: ~28 footprint entries (limit 400), ~14 write entries
(limit 200), ~2.5 KB write bytes (tx limit 132,096), negligible instructions (limit
400M). The binding network-wide constraint is ledger write bytes (286,720 per ~5s
ledger) — the reason every entry in this design is a few hundred bytes.

## Handoff notes

Read order for the implementing agent: `CLAUDE.md` → `docs/04-architecture.md` →
`docs/05-implementation-plan.md`, with 01–03 as reference material. The architecture
doc is normative where it states MUST/never; the implementation plan is a starting
proposal — deviate with a written rationale in `docs/decisions/`.
