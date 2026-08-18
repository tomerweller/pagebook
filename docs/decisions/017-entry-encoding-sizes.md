# 017 — Entry encoding: measured sizes and compact storage

Date: 2026-08-17. Size tests at max occupancy against architecture Part I
budgets. Packed Bytes layouts from ADR-015 are unchanged. Config and Market
could not stay as named `#[contracttype]` maps.

## Decision

| Entry | Storage form | Measured XDR | Budget |
|---|---|---|---|
| Level | packed Bytes (ADR-015) | under 384 | 384 |
| LevelPage | packed Bytes | under 320 | 320 |
| BestTick | packed Bytes | under 40 | 40 |
| TickWord / TickSummary | packed Bytes (version + 256-byte bitmap) | 268 | 268 |
| Order | named `#[contracttype]` | under 160 | 160 |
| FeeAccrual | named `#[contracttype]` | under 50 | 50 |
| Config | tuple `ConfigStore(Address, Address, bool, u32)` | 108 | 150 |
| Market | tuple `MarketStore(Address, Address, packed body Bytes)` | 168 | 250 |

Named `Config` and `Market` stay as ordinary structs for call sites. Storage
converts through `to_store` / `from_store`.

## Why

A named `#[contracttype]` Config was 188 B (over ~150). The same fields as a
tuple are 108 B. A named Market was 488 B (over ~250) because fourteen symbol
keys dominate. Numeric Market fields pack into 65 little-endian bytes
(version plus the architecture contents column); the two SAC addresses stay
as Address objects. The three-tuple is 168 B.

TickWord / TickSummary payload is 257 bytes (version + 256). ScVal Bytes XDR
adds the union tag, length, and padding and lands at 268, twelve over the
table's 256. The mandated layout is kept; the size test budget is the
measured 268.

## What changed

- `BUDGET_TICK_BITMAP = 268` in `pagebook-types`.
- Config and Market are no longer stored as symbol-keyed maps.
