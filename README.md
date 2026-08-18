# PageBook

A central limit order book (CLOB) designed for Stellar's Soroban runtime.

**Status: implementation in progress.** M0 through M3 are implemented and
reviewed. M4 resource hardening is partial (ADR-019), and the M5 client SDK
sketch is present. This is not a production deployment.

## Why this exists

On-chain CLOBs are shaped by their runtime's storage and concurrency model:
Serum, Phoenix, and Manifest use Solana account lists; DeepBook uses Sui shared
objects; Econia uses Aptos tables. Soroban has declared footprints, per-byte
write fees, TTL and state archival, and footprint-clustered parallel execution.
PageBook is built around those constraints rather than around a storage model
from another chain.

The design grew out of an evaluation of `deepstate-contracts`, an EVM radix-tree
matching engine. Its content-addressed keys work well for EVM gas accounting but
do not fit Soroban's simulation-time footprints. See
[`docs/02-deepstate-evaluation.md`](docs/02-deepstate-evaluation.md).

## Repository map

| Path | What it is |
|---|---|
| `CLAUDE.md` | Working instructions for the implementing agent |
| `contracts/pagebook/` | Soroban contract modules and tests for matching, settlement, pages, routes, footprints, sizes, TTL, and conservation |
| `crates/pagebook-types/` | Shared storage types, packed encodings, constants, and key-coordinate helpers |
| `crates/pagebook-client/` | Rust helpers for settle and replace keys, `quote_place` padding, restore marks, and nonce allocation |
| `Makefile` | Build, test, format, lint, and contract-build wrappers |
| `docs/01-prior-art.md` | CLOB design survey across Solana, Sui, Aptos, appchains, and SPEEDEX |
| `docs/02-deepstate-evaluation.md` | Review of the EVM matching engine and why its storage keys do not fit Soroban footprints |
| `docs/03-soroban-constraints.md` | Soroban resource limits, storage and archival semantics, and P23 execution behavior |
| `docs/04-architecture.md` | Normative PageBook design: storage schema, matching, settlement, footprints, fees, events, and TTL policy |
| `docs/index.html` | Visual explainer for the architecture document |
| `docs/05-implementation-plan.md` | Milestones, module layout, interfaces, and the remaining test and deployment work |
| `docs/06-slp-sensitivity.md` | Design variables that track network limits and how to retune them |
| `docs/07-classic-dex-comparison.md` | PageBook's limitations compared with the classic Stellar DEX |
| `docs/decisions/` | Decision records for measured changes and implementation deviations |

## Design in one paragraph

One contract hosts many markets. Each price level is a persistent entry keyed by
`(market, side, tick)` and stores a packed FIFO queue plus generation and head
counters. `BestTick`, `TickSummary`, and `TickWord` provide the derived tick
index. A taker calls `place` to sweep bounded liquidity and settle atomically via
SAC transfers. A maker's `Order` entry records its queue coordinates and later
settles in O(1) by comparing them with the level counters. `replace` reuses that
entry, `replace_batch` and `route` net transfers in memory, and `quote_place`
supports the client's simulate, pad, and submit flow. Empty levels and dormant
claims are left for TTL archival rather than deleted from the order store.

## Current resource targets

The architecture's current estimates are based on Aug 2026 mainnet limits:

- An 8-level take: about 55 footprint entries, 21 writes, and 6 KB of writes.
- A maximal 32-level take: about 85 footprint entries plus client padding, 70
  writes, and 22 KB of writes.
- The transaction limits used by the design are 400 footprint entries, 200
  writes, and 132 KB of write bytes. The ledger-wide write-byte limit is
  286,720 bytes per roughly five-second ledger.

The in-repository size, footprint, and behavior tests cover the structural
budgets. The full write-byte and resource-fee matrix, live-host restore checks,
and the long-running soak remain part of M4.

## Start here

Read `CLAUDE.md`, then `docs/04-architecture.md` and
`docs/05-implementation-plan.md`. Use docs 01 through 03 and 06 for the
rationale and network constraints. The architecture document is normative where
it uses MUST or never. The implementation plan is a proposal; record any
deviation in `docs/decisions/`.
