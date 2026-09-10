> **Warning:** PageBook is an experiment, not production software. Do not deploy it with real funds or treat its current contract, economics, or interfaces as production-ready.

# PageBook

PageBook is a central limit order book for Stellar's Soroban smart-contract
runtime. It explores how an on-chain order book can work within Soroban's
declared footprints, write-byte limits, storage rent, and parallel execution
model.

The repository contains a Rust contract, shared data types, a Rust client
helper crate, a TypeScript web trading client, testnet tooling (soak driver,
market maker, stress fleet), and tests. Use it to study the design or run local
experiments. It is not a finished exchange, SDK, indexer, or wallet
integration.

The quickest way in is the executive explainer at
[tomerweller.com/pagebook/explainer](https://tomerweller.com/pagebook/explainer/).
The web client, a live view of the testnet market with an in-page wallet, is
the site's front page at [tomerweller.com/pagebook](https://tomerweller.com/pagebook/).
The full specification is [docs/04-architecture.md](docs/04-architecture.md).

## The problem

An order book needs to find the next price level while orders arrive and fill at
the same time. Soroban requires a transaction to declare its ledger footprint
before the transaction runs. The host rejects an access to a key that was not
declared, even when that key would have been a valid next step in the book.

Soroban also charges for the bytes in entries a transaction writes. A single
large book entry would make every trade rewrite too much state and would limit
the number of trades that fit in a ledger.

PageBook addresses these constraints with predictable keys and small entries.
Clients can calculate the keys a transaction might need, add a safety band of
price levels, then submit the padded footprint.

## How the book works

One contract can host many markets. Each market has a base token, a quote token,
lot and tick sizes, a tick band, and limits for order sizes and matching work.
Prices and quantities are integers:

- A lot is a fixed number of base-token atoms.
- A tick is a fixed quote-token price per base lot.
- A take's quote amount is calculated as `lots × tick × tick_size` with checked
  integer math.
- The taker fee is rounded up. Matching itself does not round.

Each side of a market has price levels. A level stores a FIFO queue of maker
orders at one tick. The whole queue lives in one `Level` entry: two counters,
the open total, and a slot vector as long as the queue has reached, one slot
per order holding its open lots. `BestTick`, `TickSummary`,
and `TickWord` form a derived bitmap index for finding the next live level.

A maker's `Order` entry is keyed by `(market, owner, nonce)`. The queue position
is stored inside that entry, so the client can declare the order key before the
transaction executes. Matching updates the shared level counters instead of
writing every maker's order. The maker later calls `settle`, which calculates
the filled amount and refund from the stored coordinates and the level counters.

`replace` settles the old order and reuses the same `Order` entry for the new
quote. `replace_batch` applies several replacements with netted transfers.
`route` executes several market legs with one shared matching budget and netted
token transfers.

## Contract interface

The contract exposes the following methods.

### Trading

| Method | Purpose |
|---|---|
| `place` | Take resting liquidity, then rest any allowed remainder at the limit tick |
| `settle` | Claim proceeds from a filled order or refund an open order |
| `replace` | Settle and re-place one maker order while reusing its order entry |
| `replace_batch` | Replace several maker orders in one atomic call |
| `route` | Execute up to four place legs with one shared work budget |

`place` supports post-only, fill-or-kill, and no-rest flags. A place call can
take liquidity, rest a remainder, or do both. A matching cap or an empty level
ends the walk in a defined way. A remainder that would cross the
book is refunded rather than rested.

### Views

| Method | Purpose |
|---|---|
| `best` | Read the stored best tick for one side |
| `level` | Read level counters and open quantity |
| `order` | Read an order and preview its settlement result |
| `quote_place` | Simulate a place call and return the start tick, crossed levels with their depth, the simulated fill, and the keys to declare |

`quote_place` is the starting point for the client flow: simulate, pad the
footprint, and submit. The `pagebook-client` crate contains pure helpers for
settle keys, replace keys, place padding, archived-entry restore marks, and
nonces.

### Administration and fees

| Method | Purpose |
|---|---|
| `create_market` | Create a market with fixed quantization and bounded work |
| `set_market_caps` | Retune the mutable work, fee, order-size, and level-capacity limits |
| `set_admin` | Change the administrator |
| `set_fee_recipient` | Change the protocol fee recipient |
| `set_paused` | Pause entry-side operations |
| `collect_fees` | Send accrued protocol fees to the fee recipient |
| `keepalive` | Extend the contract instance and code-entry TTLs |

`settle` and `collect_fees` remain available while the entry side is paused.
The contract has no upgrade entry point.

## Soroban-specific constraints

These are the main limits and behaviors behind the design:

- A transaction has a bounded footprint. The client declares a contiguous tick
  band of `Level` keys; a level's queue depth never adds a key.
- Default matching cap is 32 crossed levels; a partial level is walked to
  its own depth (`level_cap`). A route can contain at most four legs, with
  the level budget shared across the legs.
- A level holds up to 64 orders per generation by default (`level_cap`). A
  market can raise that, up to the contract's hard ceiling of 128.
- Persistent entries have a minimum TTL of about 120 days on mainnet (about 7
  days on testnet). Empty `Level` entries
  are not deleted because their generation counters are part of settlement.
- The contract moves tokens through SAC transfers to and from its own vault
  balances. Asset authorization and issuer clawback settings remain external
  trust assumptions.
- The network caps each transaction at 400 footprint entries, 200 written
  entries, and 132 KB of write bytes. The in-repo gates pin the maximal
  32-level take at 72 written entries and ~21.0 KB of write bytes, about
  ~0.025 XLM ([worst-case matrix](docs/08-worst-case-matrix.md)).

## Testnet deployment

Contract `CAYPAQDKNWMHRATKU5DQ327VDHVRSIVK7UGVWT2A5SUZCUFTLUHXH2JA` is deployed
on the Stellar testnet (ADR-044). Its one market, market 0, trades native XLM
against Circle's testnet USDC (10-XLM lots, 0.00001 USDC ticks, 5 bps), with a
market maker quoting a 20-level ladder per side off the spot XLM-USD price
([client view](https://tomerweller.com/pagebook/), ADR-026). The earlier
deployments `CAMH…56F4` (ADR-037), `CB6I…DAZB` (ADR-036) and `CDX3…U2RO` (which
also carried a `PBA`/`PBB` scratch market) are wound down and no longer kept
alive.

That page is now a trading client (`clients/web/`): the market view plus
an in-page testnet wallet that can fund, add a trustline, place, settle, and
replace. Keys stay in the browser. A Node soak of the TypeScript padding
engine on market 0 recorded 217 submissions and no footprint failure
(ADR-029).

The market has run real rests, takes, and settles, plus a 2,000-ledger
multi-account soak through the full padding protocol (simulate, pad, submit),
driven by `tools/soak/soak.py` through the stellar CLI: 4,573 transactions
landed with no footprint failure. What the network taught the
padding protocol beyond the SDK test host, and the soak results, are recorded
in [ADR-025](docs/decisions/025-m4-testnet.md). Live-host restore behavior for
archived entries still needs its scheduled testnet check (the runbook is in the
same ADR).

## Repository layout

| Path | Contents |
|---|---|
| `contracts/pagebook/` | Soroban contract modules and tests |
| `crates/pagebook-types/` | Shared contract types (named entry structs), constants, and key helpers |
| `crates/pagebook-client/` | Client-side key and footprint helpers |
| `clients/web/ops/` | Live ops tooling on the web engine: market maker, trader, watchdog, soak, stress, resource sampler (ADR-031) |
| `tools/soak/`, `tools/stress/` | Frozen import targets for `tools/research/`; superseded by `clients/web/ops/` (ADR-031) |
| `tools/research/` | Frozen measurement instruments behind ADR-025 to ADR-028 |
| `clients/web/` | TypeScript trading client (Vite): market view plus in-page testnet wallet, published at [tomerweller.com/pagebook](https://tomerweller.com/pagebook/) |
| `docs/03-soroban-constraints.md` | Soroban storage, footprint, and resource background |
| `docs/04-architecture.md` | Full technical specification |
| `docs/07-classic-dex-comparison.md` | Comparison with the classic Stellar DEX |
| `docs/09-resource-utilization.md` | Measured declared-vs-metered resource ranges per invocation, from live testnet traffic |
| `docs/explainer/index.html` | Executive explainer, rendered at [tomerweller.com/pagebook/explainer](https://tomerweller.com/pagebook/explainer/) |

## Build and test

The workspace uses the current stable Soroban SDK declared in `Cargo.toml`.

```sh
cargo test
make build
make lint
```

`make build` produces the optimized contract WASM with `stellar contract build`.
`make lint` runs formatting checks and Clippy with warnings treated as errors.
`make web-build` and `make web-test` build and test the TypeScript client in
`clients/web/`.

## Read more

- [Architecture](docs/04-architecture.md): storage, matching, settlement,
  events, footprints, fees, and archival behavior
- [Executive explainer](https://tomerweller.com/pagebook/explainer/): the design and its measured costs in brief (source: `docs/explainer/index.html`)
- [Market client](https://tomerweller.com/pagebook/): live book and in-page testnet wallet, the site's front page (source: `clients/web/`)
- [Web client decision](docs/decisions/029-web-client.md): embedded wallet, fixture ports, Pages workflow, soak tally
- [Soroban constraints](docs/03-soroban-constraints.md): the runtime limits
  behind the design
- [Classic Stellar DEX comparison](docs/07-classic-dex-comparison.md): what
  PageBook gives up and what it gains
