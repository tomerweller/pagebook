# 016 — M0 footprint spike and test-env capabilities

Date: 2026-08-17. Records what the soroban-sdk 27.0.6 test host actually
exposes, which fallback rung M0 took, and the testnet deploy outcome.

## Decision

`footprint_of` lives in `contracts/pagebook/src/tests/footprint.rs`. It returns
the keys written (from a before/after snapshot of instance and persistent
storage), write-byte and entry counts from `Env::cost_estimate().resources()`,
and leaves the read-key set empty until matching grows a `Mode::Trace`.

## Why

Rung 1 of the plan's ladder (recorded footprint as a key set) is not available.
`InvocationResources` has counts only (`write_entries`, `write_bytes`,
`memory_read_entries`, `disk_read_entries`). The host's internal footprint map
is not part of the SDK public API.

Rung 2 works for writes: `storage().persistent().all()` and
`storage().instance().all()` can be snapped around a call and diffed. Changed
values are XDR-sized as a lower bound; `resources().write_bytes` is the figure
tests should prefer because it includes ledger-entry framing.

Rung 2 for reads needs `Mode::Trace` on the shared walk. That walk does not
exist until M2, so M0 does not claim a recorded-read key set. The M2 padding
suite can still assert `recorded_writes ⊆ declared` from this helper, and
`recorded_reads ⊆ declared` once Trace lands. That is enough to keep the
padding suite from being marked partial, provided M2 adds Trace.

## Test-env archival

`get_ttl` works on instance storage. Advancing `ledger.sequence` past that TTL
does not drop the Config entry in the test host. TTL-value assertions stay
in-repo. The two archival restore-path tests stay in the M4 soak.

## Testnet

Deployed. Procedure was `stellar keys generate pagebook-builder --network
testnet --fund --config-dir .stellar`, then `stellar contract deploy` of
`target/wasm32v1-none/release/pagebook.wasm` with constructor
`--admin` / `--fee_recipient` both set to the builder. Contract id
`CDDIS2RFDNW24JV6XV3NDWPZFFV5PCWQUYAVMEARLBMSXHAKTYH6X4D3` on testnet.
Identity stays in the git-ignored `.stellar/`. No testnet-only gate is blocked.

## What changed

- Added `footprint_of`.
- M2 must add `Mode::Trace` for read keys. Until then, inclusion tests cover
  writes and resource counts only.
