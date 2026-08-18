# 018 — PlaceLeg and route result shape

Date: 2026-08-17. Closes the M3 implementer note on `PlaceLeg` / `LegResult`.

## Decision

A `PlaceLeg` is `place`'s arguments minus `taker`: market, is_bid, limit_tick,
qty_lots, start_tick, nonce, window, flags. A route result is one
`(rested, filled_lots, quote_atoms)` tuple per leg, in order. The route fails
atomically, so partial legs never surface.

## Why

This is the default 05 already named. No new encoding was needed.

## What changed

`route` and `replace_batch` are on the contract. `replace_batch` rejects
`items.len() > MAX_REPLACE_BATCH` with `BatchTooLarge`. Paused `route` fails
`Paused`.
