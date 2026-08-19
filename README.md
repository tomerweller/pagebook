> **Warning:** PageBook is an experiment, not production software. Do not deploy it with real funds or treat its current contract, economics, or interfaces as production-ready.

# PageBook

PageBook is a central limit order book for Stellar's Soroban smart-contract
runtime. It explores how an on-chain order book can work within Soroban's
declared footprints, write-byte limits, storage rent, and parallel execution
model.

The repository contains a Rust contract, shared data types, a small Rust client
helper crate, and tests. Use it to study the design or run local experiments. It
is not a finished exchange, SDK, indexer, or wallet integration.

The quickest way in is the rendered explainer at
[blob.tomerweller.com/pagebook](https://blob.tomerweller.com/pagebook/): the design
in pictures and worked numbers, with each section linking to the matching part of
the architecture document.

## The problem

An order book needs to find the next price level while orders arrive and fill at
the same time. Soroban requires a transaction to declare its ledger footprint
before the transaction runs. The host rejects an access to a key that was not
declared, even when that key would have been a valid next step in the book.

Soroban also charges for the bytes in entries a transaction writes. A single
large book entry would make every trade rewrite too much state and would limit
the number of trades that fit in a ledger.

PageBook addresses these constraints with predictable keys and small entries.
Clients can calculate the keys a transaction might need, add a safety band and
page windows, then submit the padded footprint.

## How the book works

One contract can host many markets. Each market has a base token, a quote token,
lot and tick sizes, a tick band, and limits for order sizes and matching work.
Prices and quantities are integers:

- A lot is a fixed number of base-token atoms.
- A tick is a fixed quote-token price per base lot.
- A fill is calculated as `lots × tick × tick_size` with checked integer math.
- The taker fee is rounded up. Matching itself does not round.

Each side of a market has price levels. A level stores a FIFO queue of maker
orders at one tick. The queue uses a packed `Level` entry for its counters and
inline slots, with `LevelPage` entries for overflow. `BestTick`, `TickSummary`,
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
take liquidity, rest a remainder, or do both. A matching cap, page-window edge,
or empty level ends the walk in a defined way. A remainder that would cross the
book is refunded rather than rested.

### Views

| Method | Purpose |
|---|---|
| `best` | Read the stored best tick for one side |
| `level` | Read level counters and open quantity |
| `order` | Read an order and preview its settlement result |
| `quote_place` | Simulate a place call and return crossed levels, keys, and window information |

`quote_place` is the starting point for the client flow: simulate, pad the
footprint, and submit. The `pagebook-client` crate contains pure helpers for
settle keys, replace keys, place padding, archived-entry restore marks, and
nonces.

### Administration and fees

| Method | Purpose |
|---|---|
| `create_market` | Create a market with fixed quantization and bounded work |
| `set_market_caps` | Retune the mutable work, fee, order-size, and page limits |
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
  band and page windows around simulated queue positions.
- Default matching caps are 32 crossed levels and 64 scanned slots. A route can
  contain at most four legs, with the matching budget shared across the legs.
- The default queue has 32 inline slots and one 32-slot overflow page. A market
  can raise its page count within the contract's hard ceiling.
- Persistent entries have a minimum TTL of about 120 days. Empty `Level` entries
  are not deleted because their generation counters are part of settlement.
- The contract moves tokens through SAC transfers to and from its own vault
  balances. Asset authorization and issuer clawback settings remain external
  trust assumptions.
- Current design estimates use 400 footprint entries, 200 writes, and 132 KB of
  transaction write bytes. A maximal 32-level take is estimated at about 85
  footprint entries plus padding, 72 writes, and about 27 KB of writes.

## Repository layout

| Path | Contents |
|---|---|
| `contracts/pagebook/` | Soroban contract modules and tests |
| `crates/pagebook-types/` | Shared contract types, packed encodings, constants, and key helpers |
| `crates/pagebook-client/` | Client-side key and footprint helpers |
| `tools/soak/` | Testnet soak driver: padded footprints through the stellar CLI, outcome classification (ADR-025) |
| `docs/04-architecture.md` | Full technical specification |
| `docs/index.html` | Visual companion to the technical specification, rendered at [blob.tomerweller.com/pagebook](https://blob.tomerweller.com/pagebook/) |
| `docs/dashboard/` | Read-only live market status page (RPC only, no build step), rendered at [blob.tomerweller.com/pagebook/dashboard](https://blob.tomerweller.com/pagebook/dashboard/) |
| `docs/03-soroban-constraints.md` | Soroban storage, footprint, and resource background |
| `docs/07-classic-dex-comparison.md` | Comparison with the classic Stellar DEX |

## Build and test

The workspace uses the current stable Soroban SDK declared in `Cargo.toml`.

```sh
cargo test
make build
make lint
```

`make build` produces the optimized contract WASM with `stellar contract build`.
`make lint` runs formatting checks and Clippy with warnings treated as errors.

## Read more

- [Architecture](docs/04-architecture.md): storage, matching, settlement,
  events, footprints, fees, and archival behavior
- [Architecture explainer](https://blob.tomerweller.com/pagebook/): diagrams and worked examples (source: `docs/index.html`)
- [Market dashboard](https://blob.tomerweller.com/pagebook/dashboard/): live state of the testnet market (source: `docs/dashboard/`)
- [Soroban constraints](docs/03-soroban-constraints.md): the runtime limits
  behind the design
- [Classic Stellar DEX comparison](docs/07-classic-dex-comparison.md): what
  PageBook gives up and what it gains
