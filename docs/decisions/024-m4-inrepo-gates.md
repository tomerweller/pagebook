# 024: M4 in-repo gates: measured numbers, and what they corrected

Date: 2026-08-18. Completes the in-repo half of M4 (items 1 to 4 of the M4
bullet). Testnet redeploy, restore-opt-in transactions, and the soak stay
open, so M4 is still partial (ADR-019).

## Decision

Gates are the measured host figures plus a small slack, and §17 is rewritten
to those figures (this note is the follow-up the matrix in
`docs/08-worst-case-matrix.md` asked for). No contract behaviour changed
except one constant: `MAX_REPLACE_BATCH` is 40, not 64.

Fee gates compare the execution slice (instructions + write-entry fees +
write-byte fees + events) to each corrected §17 row at 1.25×, and persistent
rent, rescaled from the SDK snapshot's 12,000/KB to the 1,000/KB floor, to a
per-entry rent row at 1.25×. Every fee gate first sets the test ledger to
mainnet TTLs (minimum persistent 2,073,600, maximum 3,110,400): at the test
host's default 4,096-ledger minimum the rent term is ~500× too small and the
gate cannot fail. `total − persistent_entry_rent` is not the comparison: the
snapshot charges disk-read fees on live writes (P23 live reads are free) and
the test host bills temporary rent for the auth nonce on authenticated
calls. A native test contract does not model wasm instantiation, so
instruction fees are a lower bound; tx-size fees are not modelled.

## What the measurements corrected

- **Rent is charged on the full ledger entry** (payload + key + ~56 B of
  framing), not the payload. An `Order` is 276 B on the ledger, so its
  120-day rent is ~0.046 XLM, not the ~0.027 the earlier §17 derived from
  160 B; a `Level` is 404 B (~0.067), a `TickWord` 376 B (~0.063), a
  `Market` 580 B (~0.097). §17 now carries a per-entry rent table and every
  fee row is recomputed from it; §5, §8, §9, §10, §14, the explainer, doc 07
  and the README carry the new figures.
- **The max sweep is 72 writes / 26,640 B**, not ~70 / ~22 KB: the host
  meters framing, and every authenticated call also writes one temporary
  authorization-nonce entry (72 B). 9.3% of a ledger's write bytes, ~10 max
  sweeps per ledger.
- **`replace_batch` has two shapes.** A same-tick 40-quote refresh is 83
  writes / 27.7 KB / ~0.031 XLM with zero rent (the ADR-005 headline, now
  asserted). Moving 40 quotes to fresh ticks is 124 writes / 44.3 KB / ~0.043
  XLM of execution plus 40 `Level` rents (~2.7 XLM). §17 shows both.
- **`MAX_REPLACE_BATCH` = 40.** A replace item's two events measure ~340 B,
  so 64 items exceed the 16,384-byte event budget (and, dispersed, the
  400-entry footprint and 200-write caps). 40 dispersed items measure 170
  entries, 164 writes, 59 KB, 13.9 KB of events, inside every per-transaction
  limit; a test pins that.

## What changed

- `docs/08-worst-case-matrix.md`: per-op read/write/byte formulas, the
  framing accounting, and the §17 comparison.
- `tests/worst_case.rs`: the constructed 32-level / 32-word sweep, the
  dispersed 40-item batch against every per-tx limit, write-byte gates on
  every `bound_*` test.
- `tests/fee_gates.rs`: mainnet TTLs, execution and per-entry rent gates
  per §17 row, the rent-free same-tick refresh, all components printed.
- `tests/ttl.rs`: place (rest and take), settle, replace, replace_batch,
  route and `collect_fees` do not extend TTLs of pre-existing persistent
  PageBook entries; only `keepalive` and admin ops move the instance TTL.
- `MAX_REPLACE_BATCH` lowered from 64 to 40 (`constants.rs`, §0.3, 05).
- Architecture §17 rewritten to the measured numbers.
