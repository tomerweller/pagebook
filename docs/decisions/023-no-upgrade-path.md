# 023 — No upgrade entry point at this stage

Date: 2026-08-18. Removes `upgrade(wasm_hash)`.

## Decision

The contract has no upgrade entry point. A new version is a new deployment; a live
book migrates by makers settling on the old address and resting on the new one. The
schema-version byte on packed entries stays as a decode guard (a mismatch is
`CorruptEntry`, never a silent misread); it no longer promises lazy migration.

## Why

`upgrade` was a one-liner (`update_current_contract_wasm`) that carried the largest
trust cost in the design — an upgraded wasm can move the vault — while the thing
that would make upgrades safe for storage (lazy migration of every packed layout,
tested against a real second wasm) did not exist and is not on the milestone path.
Keeping the entry point without the migration story meant "upgrades that keep every
layout byte-for-byte compatible work, anything else freezes the book". At this
stage of development the honest position is: no upgrades, no vault-moving admin
power, a deliberately small admin surface (markets, caps, pause, rotation).

## What changed

- `upgrade` removed from `lib.rs` / `admin.rs` and the 05 interface sketch; its two
  auth tests removed.
- Architecture §12: the trust model paragraph and the "Upgrade" bullet rewritten;
  §20 lists in-place upgrade + lazy migration as deferred; Part I intro describes
  the version byte as a guard.
