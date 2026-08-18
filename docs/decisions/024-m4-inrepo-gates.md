# 024: M4 in-repo gates: measured numbers, not a §17 edit

Date: 2026-08-18. Completes the in-repo half of M4 (items 1 to 4). Testnet
redeploy, restore-opt-in transactions, and the soak stay open, so M4 is
still partial (ADR-019).

## Decision

Do not change contract behaviour and do not edit architecture §17 in this
milestone. The constructed 32-level / 32-word sweep and the 40-quote
`replace_batch` both land above the §17 write and write-byte rows. Gates
use the measured host figures plus slack. Corrections for a later §17 edit
are listed in `docs/08-worst-case-matrix.md`.

Fee gates compare the execution slice (instructions + write-entry fees +
write-byte fees + events) to each §17 fee row at 1.5×. That is not
`total − persistent_entry_rent`: the 2026-07-10 snapshot still charges
disk-read fees on live writes, and the test host bills a flat 2,194,209
stroops of `temporary_entry_rent` on authenticated calls. Persistent rent
is rescaled from the snapshot's 12,000/KB to the 1,000/KB floor as
specified. The test host's persistent TTL is not the 120-day minimum, so
the rescaled rent figure is not a mainnet create charge; the assertion
still runs.

A native test contract does not model wasm instantiation. Instruction fees
are a lower bound.

## Why

CLAUDE.md says follow measured reality and record the deviation. §17 was
frozen for this milestone ("do not edit §17"). The contract did not need
to change: every public path stays inside per-tx limits (400 / 200 /
132 KB).

## What changed

- `docs/08-worst-case-matrix.md`: per-op read/write/byte formulas and the
  §17 comparison.
- `tests/worst_case.rs` and write-byte gates on every `bound_*` test.
- `tests/fee_gates.rs`: fee components printed and gated.
- `tests/ttl.rs`: place (rest and take), settle, replace, and
  `collect_fees` do not extend TTLs of pre-existing persistent PageBook
  entries; only `keepalive` and admin ops move the instance TTL.
