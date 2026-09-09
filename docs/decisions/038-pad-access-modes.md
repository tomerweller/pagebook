# 038: Pad access modes

Date: 2026-09-09. The client's pad declared every planned key read-write,
including keys a trading call never writes.

## What was over-declared

`pad()` and `keysForReplace()` list `Config` and `Market`. `toLedgerKey()`
maps `Config` to the PageBook instance. `tokenExtraKeys()` adds both SAC
instances. `applyPad()` then moved each of those keys out of the simulation
read-only list into read-write. The contract does not write any of them on
`place`, `settle`, `replace`, or `replace_batch`.

## Consequence

Architecture §16: an instance write is a global serialization point across
every market and token; instance reads are shared read-only and do not
conflict. Two markets with disjoint tokens shared the PageBook instance as a
read-write entry, which is the conflict the instance rule is there to avoid.
The extra write entries also paid the write-entry fee and write-byte cover.

## Rule

Each planned key carries an access mode. `Config`, `Market`, and both token
instances are read-only. Every other PageBook key and both balance entries
are read-write, so a simulated read of a level can still be promoted after a
race (ADR-025). `applyPad` never demotes a simulation-required write.
Restore marks are recomputed against the final read-write list.

## Fee effect

Read-only planned keys no longer count as added write entries, so they drop
the write-entry fee and the write-byte cover. They still add disk-read cover
and the read-entry fee. Instruction headroom on a place loses about four
times `INSTR_PER` (instance, `Market`, two SAC instances). The 3M flat
`INSTR_FIXED` from ADR-026 is unchanged.
