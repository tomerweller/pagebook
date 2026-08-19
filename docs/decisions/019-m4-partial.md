# 019 — M4 resource hardening is partial

Date: 2026-08-17. M4's in-repo gates that this branch can run are green.
The soak and live-host restore checks are not.

## Decision

M4 is *partial*, not done.

In-repo and green: entry-size tests, per-op instance-write negatives for
place/settle, `footprint_of` write-key diffs, and constructor deploy on
testnet (ADR-016).

Not run: the 32-level / 32-word write-byte matrix against §17, measured
resource-fee gates vs the §17 table, the three P23 restore-opt-in
transactions, and the ≥ 2,000-ledger soak with a quote-improving spammer
and rest storm.

## Why

Those remaining gates need a long-running testnet bot and a constructed
worst-case book. The branch stops short of that rather than report M4 done
on a fallback the plan says is not done.

## What changed

Nothing in the architecture. M5's client crate is still shipped so padding
and nonce helpers exist for whoever runs the soak.

## Update (2026-08-18)

ADR-024 closed the in-repo gates (worst-case matrix, write-byte and fee gates,
no-rent tests). ADR-025 closed the testnet items: redeploy and real trades,
and the 2,000-ledger soak with the spammer and rest storm active (4,573
transactions, no footprint failure, no unexplained trap). What remains partial
is the three restore-opt-in transactions, which wait on testnet's seven-day
minimum TTL; ADR-025 carries the fixtures and the runbook.
