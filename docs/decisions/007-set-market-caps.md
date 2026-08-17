# 007 — `set_market_caps`: stored caps must track validator-voted limits

Date: 2026-08-14. Prompted by the question "should market variables change when
Soroban limits change?" — analysis in `06-slp-sensitivity.md`.

## Problem

Per-market loop caps (`MAX_LEVELS_CROSSED`, `MAX_SLOTS_SCANNED`, order-size bounds,
`MAX_PAGES`) exist to fit transactions inside Soroban's per-tx limits. Those limits
are network config that validators retune every few months (SLPs), but the caps were
stored in the `Market` entry with no way to change them — an SLP doubling per-tx
capacity would have left every live market tuned for the old network. And the
contract cannot adapt by itself: no host function exposes config settings or
remaining budget (verified against `env.json`; `get_max_live_until_ledger` is the
lone config-derived exception, and protocol version doesn't track config votes).

## Decision

Add `set_market_caps(mkt, max_levels_crossed, max_slots_scanned, taker_fee_bps,
min_order_lots, max_order_lots, max_pages)` — admin-authenticated, per market:

- Every call re-runs the §0 overflow proof and rejects values that break it.
- `MAX_PAGES` is raise-only: live seqs may sit beyond a lowered value.
- Quantization (`lot_size`, `tick_size`, band) and queue geometry (N, P) are not
  parameters. They are frozen for the market's lifetime — slot location and price are
  pure functions of them, so changing them corrupts live state. A different geometry
  is a new market.
- `taker_fee_bps` stays capped by `FEE_BPS_MAX`. Making the fee admin-adjustable adds
  no new trust: an admin that can upgrade the wasm already holds strictly more power.
- Stated limitation: the contract can verify its own proof but cannot verify caps
  against live network limits on-chain. Choosing caps that fit the network is the
  admin's job, informed by off-chain reads of `stellar network settings`.
- Client-side knobs (band width, windows, batch composition) need no entry point —
  clients read live config over RPC per transaction.

M1 gains tests: auth; re-proof rejection; `MAX_PAGES` lowering rejected; resting
orders and settlements unaffected across a retune.
