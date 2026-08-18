# 022 — Entry encoding revisited: pack only what is rewritten in bulk

Date: 2026-08-18. Amends ADR-017. Measured with the SDK's XDR encoder at max
occupancy.

## Decision

`Config`, `Market` and `BestTick` are plain named `#[contracttype]` structs. Their
budgets become the measured named sizes (200 / 500 / 60 B). `Level` and `LevelPage`
stay packed `Bytes` (architecture §2 mandates it); `TickWord` / `TickSummary` stay
packed because their payload is 256 raw bytes and the packed form is the smallest
(268 B) with a version byte for free. `Order` and `FeeAccrual` were already named.

| Entry | Was | Now | Bytes |
|---|---|---|---|
| Level | packed | packed | 296 (named: 440–572) |
| LevelPage | packed | packed | 268 (named: 396–424) |
| TickWord / TickSummary | packed | packed | 268 (named: 288) |
| BestTick | packed | **named** | 16 → 56 |
| Market | tuple(Address, Address, packed body) | **named** | 168 → 488 |
| Config | tuple struct | **named** | 108 → 188 |

## Why

Bytes matter through rent at creation (~1,667 stroops per byte per 120 days) and
through the per-ledger write-byte cap that bounds throughput (§17). Both bind on
entries that are rewritten in bulk on the hot path — `Level` and `LevelPage`, up to
32 of each per take — and nowhere else. `Market` is written at creation and at a
retune; `Config` lives in instance storage whose rent the `keepalive` crank pays
next to ~40 KB of wasm; `BestTick` is small enough that its map encoding costs tens
of stroops per write. ADR-017 packed those three to meet budgets inherited from a
table of hot entries; the budgets were the wrong lever, and the hand-written
encode / decode paths and the tuple-position field access made the code harder to
read for no measurable gain.

Costs accepted: `create_market` rent roughly doubles to ~0.085 XLM once per market
(admin-paid); the `BestTick` write on a take is ~40 B larger. Nothing changes in
footprint entry counts; the M4 write-byte matrix moves only for `BestTick`.

## What changed

- `crates/pagebook-types`: `Config`, `Market`, `BestTick` are `#[contracttype]`
  named structs; `ConfigStore`, `MarketStore`, `encode_body`, and the `BestTick`
  packed layout are gone, with `BEST_TICK_BYTES`, `BEST_TICK_EMPTY_BIT`,
  `MARKET_BODY_BYTES`.
- `store.rs` loads and saves them directly.
- Size tests measure the named structs; budgets updated; §1 / §5 / §17 and the
  explainer table show the new sizes; 05 "Encoding decisions" updated.
