# 025: M4 on testnet: redeploy, real trades, padded footprints, soak, restore runbook

Date: 2026-08-18. The network half of M4 (05 items 5 to 7). Item 5 is done, item
7's tool exists and its 2,000-ledger run is recorded below as it completes, item
6 waits on testnet's minimum TTL and has a runbook.

## Deployment (item 5)

- Contract `CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO` on testnet:
  the current `main` wasm (32,985 B optimized), constructor admin and fee
  recipient `GCBMNFRU74KLBUCVHJVQXRRMGEWUWC2WZ5KXLYABNFLXGCFTJPKBT4IB`
  (`pagebook-builder`, git-ignored `.stellar/`).
- Assets `PBA` and `PBB` issued by that account; SACs
  `CDAHSKHBGFENTV3XGWRWVIWE3ISAEYIZQNGD4GCWRDDIOIW4DVZ26FQG` (PBA) and
  `CBEC6J5RWWWC7CYCHJTXIBDFTFRK6GTMLK4E47BECO5BDXVM7YHATUIK` (PBB); identities
  `pb-maker`, `pb-taker`, `pb-spam`, `pb-storm` hold 1,000 of each.
- Market 0: base PBA, quote PBB, lot 1, tick 1, band [1, 65536), fee 10 bps,
  min 1 / max 1,000,000 lots. `create_market` ran the SAC `authorized(vault)`
  check on-chain.
- First real cycle: maker rests 5 @ 100 (`rested`, 5 PBA into the vault);
  taker buys 3 @ 100 (`filled`, 300 PBB in, 3 minus 1 fee lot out); maker
  settles (300 PBB proceeds, 2 PBA refund). Balances reconcile; the vault holds
  the 1-lot fee.

## What the network taught the padding protocol (§14, §15, §17 updated)

Every place, replace and batch in the soak goes build (`contract invoke
--build-only`), `tx simulate`, footprint union with the client pad, `xdr
encode`, `tx sign`, `tx send`. Four things the SDK test host could not show:

1. **Existing read-write keys are charged as writes.** A key declared read-write
   that exists on the ledger must be covered by the transaction's `write_bytes`
   even if the invocation never touches it (apply fails `ResourceLimitExceeded`
   otherwise); nonexistent keys and read-only keys are free. So *set* levels in
   the padded band cost their write bytes and ledger write capacity even when the
   walk stops before them.
2. **Read-write keys pay the write-entry fee.** 2,500 stroops per read-write
   footprint entry, written or not, plus write bytes at 875/KB and instructions
   for footprint processing; a fee below that minimum is `TxSorobanInvalid`. A
   padded key is therefore ~2,800 stroops, not the ~300 the docs said, and it
   consumes one of 200 per-transaction and 1,000 per-ledger write entries.
3. **Both tokens, always.** Simulation lists only the token entries it moved.
   A rest that simulated as pure (one token) and filled in flight paid out the
   other token and trapped on the other SAC's *instance* entry. The pad now
   carries, for both tokens, the SAC instance, the vault balance, and the
   caller's trustline. (Classic trustlines are disk entries: their read bytes
   need covering too.)
4. **Promote, do not just add.** Simulation classified an empty band level as
   read-only; a rest landed there in flight and the walk's sweep tried to write
   it. The pad must move band keys from read-only to read-write, not only add
   the missing ones. And the declared instructions need headroom: simulation
   budgets exactly what it touched, and each extra footprint key costs the host
   a little to process.

## The soak (item 7)

`tools/soak/soak.py` (stellar CLI + RPC, no SDK): four threads, one identity
each. Taker: crosses at the best ± 3 ticks, padded band to its limit. Maker:
post-only quotes around mid 100, `replace_batch` every six. Spam: post-only
rest one tick inside the spread, then `replace` 20 ticks away (stale bits and
phantom bests). Storm: bursts of 3 to 8 same-level post-only rests at the best
ask. Every outcome is classified from the send result and, for `Trapped`
transactions, from the diagnostic events (`getTransaction`): `ok`, `typed:X`
(a PageBook error, at simulation or apply), `footprint` (a key outside the
declared set), or other.

Shakedown runs on 2026-08-18: 20 ledgers, 45 ok / 3 traps (all four findings
above); 30 ledgers after fixes 1 to 4, 69 ok / 1 footprint on an unpadded
`replace` (fixed: replaces carry the token keys and append pages) / 1 typed
`Crossed` at apply (a post-only that got crossed in flight, correct) / 7 typed
`Crossed` at simulation (storm posts on a moving book).

2,000-ledger run: `tools/soak/soak-2000.log` (JSON lines; the last line is the
summary). Result to be recorded here when it completes; the acceptance
criterion (05) is no footprint failure other than a walk past `pad_end`, and
every `RetryRest` re-simulated and landed.

## Restore opt-in (item 6): runbook

Testnet's `min_persistent_ttl` is 120,960 ledgers (about seven days), so an
entry created today archives around ledger 4,333,990. Fixtures created at
ledger 4,213,030 on market 0, ask side:

- **A.** `Level(0, asks, 60000)`: rested 1 lot (nonce 900001) and cancelled.
  The level is empty with its bit still set (stale-better); the level, its
  `TickWord(29)` and the summary bit age together.
- **B.** `Level(0, asks, 61000)` with a live 1-lot order (`pb-maker`, nonce
  900002), never touched again: `Order` and `Level` age.

After archival, run with `tools/soak/soak.py`'s pipeline (or by hand):

1. A bid whose band declares `Level(asks, 60000)` read-write but whose walk
   never reaches it (limit below 60000; nothing crossing): remove `Level(60000)`
   from `archived_soroban_entries` in the simulated tx (leave it declared);
   expect success and no restore charge in the fee.
2. A bid with `start_tick = 60000`, `limit = 60000` (the walk lands on the
   stale bit): unmarked, expect the archived-entry failure; then marked
   (as simulation proposes), expect success and the ~0.067 XLM restore rent
   in `persistent_entry_rent`.
3. `settle(pb-maker, 0, 900002)` after B archives: the CLI's simulation marks
   the `Order` and `Level` for restore; expect success and the ~0.11 XLM restore
   rent, and 1 PBA back.

If the host behaves otherwise, §14 / §15 / §17 need a decision note (05 M4).

## Status

M4: items 1 to 5 done, item 7 tooling done with the long run recorded on
completion, item 6 scheduled (runbook above). ADR-019's "partial" stands until
6 and the 2,000-ledger result are in.
