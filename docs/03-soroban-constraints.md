# Soroban constraints the design targets

*Snapshot: Stellar mainnet, August 2026 (protocol 23+ era). Limits are network
config settings and move via SLPs — re-verify before implementation hardening with
`stellar network settings` or Stellar Lab's Network Limits page. The historical
trajectory (roughly 2x/year) matters as much as the current values.*

## Resource limits

Per **transaction**:

| Resource | Value | Set by |
|---|---|---|
| Footprint entries (total RO+RW) | **400** | SLP-0005 (Final, Feb 2026; 200→400) |
| Write (RW) ledger entries | **200** | SLP-0004 (Final, Jan 2026; 50→200) |
| Instructions | **400,000,000** | SLP-0004 (100M→400M) |
| Write bytes | **132,096** | unchanged |
| Disk read entries / bytes | 200 / 200,000 | SLP-0004 (disk = archived/classic only) |
| Contract events size | **16,384 bytes** | SLP-0001 (Final, Dec 2024; 8,198→16,384) |
| Tx size | 132,096 bytes | — |

Per **ledger** (~5s):

| Resource | Value | Notes |
|---|---|---|
| Write entries | 1,000 | SLP-0004 |
| **Write bytes** | **286,720** | **the network throughput ceiling for state-mutating protocols** |
| Instructions | 580M across 2 parallel threads | SLP-0004 |
| Disk read bytes | 400,000 | deliberately small post-P23 (live state is in memory) |

Rules of thumb the design bakes in:

- Per-tx budgets are generous (400/200/400M); the scarce shared resource is
  **ledger write bytes**. Minimize bytes written per operation → many small entries beat
  one big blob, because Soroban charges for every byte of every entry you rewrite
  (unlike Solana, where rewriting part of a 1MB account costs the same as a small one).
- Each ledger entry carries ~100–200 bytes of LedgerKey/LedgerEntry framing on top of
  payload; sub-100-byte payloads are overhead-dominated. Sweet spot for hot entries:
  a few hundred bytes.
- Live-state reads are in-memory and cheap post-P23; **footprint entry count** (not read
  bytes) is the read-side constraint.

## Storage model and state archival

Three durability classes: **temporary** (cheapest; deleted forever at TTL expiry — never
put funds-bearing state here), **persistent** (archived at TTL expiry, restorable),
**instance** (persistent, shares the contract instance's TTL; for config).

- Persistent entries have `liveUntilLedger`; minimum TTL on create/restore ≈ 4,095
  ledgers; TTLs are extendable (up to ~1 year ahead) via `extend_ttl`, cost = rent.
- **Protocol 23 auto-restore:** simulation detects archived persistent/instance entries
  a transaction touches and the `InvokeHostFunction` op restores them in-line. Manually
  built transactions that skip simulation fail on archived entries. Restores consume
  disk-read budget (small: 400 KB/ledger) — designs should make archived-entry touches
  rare and beneficiary-paid.
- Creating an entry at a key whose previous incarnation is archived is a
  restore-then-write, not a fresh create — key lifecycle matters (PageBook makes
  restore-on-touch the *designed* path for cold levels, and never deletes them).

## Execution model

- **Footprints:** every entry a transaction touches must be declared (RO or RW) before
  execution; execution fails on undeclared access. Declaring entries you don't touch is
  legal — **predictable keys ⇒ paddable footprints**, the property the whole design
  leans on. Simulation (preflight) computes footprints; anything that changes the
  key-set between simulation and inclusion causes failure.
- **Parallel execution (P23 / CAP-63):** transactions are partitioned by footprint
  conflicts (RW overlap) into clusters; disjoint clusters run in parallel (2 threads
  today, per SLP-0004). Design consequence: scope hot RW entries as narrowly as possible
  (per-side, per-market) so unrelated flow parallelizes.
- **No reentrancy:** the host forbids it; no reentrancy guards needed.
- **No per-call resource cap on cross-contract calls:** an untrusted callee can burn the
  whole tx budget → no synchronous hooks to untrusted contracts, ever. Emit events.
- Host types: i128/u128 native; U256 available; `Address` ≈ 32-byte payload. Arbitrary
  `Bytes`/`BytesN` keys fine. Wasm size limits are a non-issue for this contract.

## Fees (shape, not values)

Total tx fee = instructions + per-entry read/write + per-byte write + rent (TTL
extensions, size × time) + events/return-value bytes + tx size. Rent means every live
byte has a carrying cost — state that can sleep (archive) should.

## Sources

- SLP-0001 — https://github.com/stellar/stellar-protocol/blob/master/limits/slp-0001.md
- SLP-0004 — https://github.com/stellar/stellar-protocol/blob/master/limits/slp-0004.md
- SLP-0005 — https://github.com/stellar/stellar-protocol/blob/master/limits/slp-0005.md
- (context: SLP-0002, SLP-0003 — earlier ledger-wide raises)
- State archival — https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival
- Resource limits & fees — https://developers.stellar.org/docs/networks/resource-limits-fees (live values: Stellar Lab / `stellar network settings`)
- Protocol 23 — https://stellar.org/blog/developers/announcing-protocol-23
