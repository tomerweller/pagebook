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

- Persistent entries have `liveUntilLedger`; minimum TTL on create/restore is
  **2,073,600 ledgers (~120 days at 5s)** and the maximum is 3,110,400 (~180 days) —
  live mainnet values, Aug 2026 (the pre-P23 ~4,095-ledger minimum is long gone).
  Rent for the full minimum is charged at creation/restore; `extend_ttl` tops up to
  the max. Consequence: entries live in ~120-day prepaid chunks, and hot paths never
  need to extend anything.
- **Protocol 23 auto-restore:** simulation detects archived persistent/instance entries
  a transaction touches and the `InvokeHostFunction` op restores them in-line. Restore
  is **opt-in per footprint entry**: the transaction lists which archived read-write
  entries to restore and pays their rent; an archived key that is declared but not
  listed costs only its footprint slot and fails the transaction only if execution
  touches it (this is what lets PageBook pad archived keys for free, architecture
  §14). Manually built transactions that skip simulation fail on archived entries.
  Restores consume disk-read budget (small: 400 KB/ledger) — designs should make
  archived-entry touches rare and beneficiary-paid. Verify the per-entry opt-in
  against the live host in M4 (fee gate).
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

## Fees (live mainnet values, Aug 2026 — re-verify via `stellar network settings`)

Total tx fee = instructions + write entries + write bytes + rent + events + tx size.
Post-P23, **live-state reads are free** (in-memory; `fee_disk_read_*` applies only to
archived/classic entries) — declared-but-untouched footprint keys cost only their tx
bytes (~300 stroops per padded key).

| Component | Rate (stroops) |
|---|---|
| Instructions | 7 per 10,000 |
| Write ledger entry | 2,500 per entry |
| Write bytes / rent rate | 1,000 per KB — the **floor**; state-size dependent, interpolates to 10,000/KB as live state approaches the 3 GB target (currently far below it) |
| Disk read (archived/classic only) | 1,563 per entry + 447 per KB |
| Contract events | 5,000 per KB (refundable) |
| Tx size | 406 per KB bandwidth + 4,059 per KB historical ≈ 4.4 per byte |

**Rent** = `size × rate_1kb × ledgers / (1024 × 1,215)` for persistent entries
(denominator 2,430 for temporary; code entries get a 1/3 discount). At the current
floor that is **~1,667 stroops (~0.000167 XLM) per byte per 120-day minimum TTL** —
creating persistent entries is the dominant cost of any storage-heavy protocol, and
execution (instructions, write entries) is nearly free by comparison. Design
consequence: per-byte entry budgets are money, and entry *creation* (not rewriting)
is what needs economic guards.

## Sources

- SLP-0001 — https://github.com/stellar/stellar-protocol/blob/master/limits/slp-0001.md
- SLP-0004 — https://github.com/stellar/stellar-protocol/blob/master/limits/slp-0004.md
- SLP-0005 — https://github.com/stellar/stellar-protocol/blob/master/limits/slp-0005.md
- (context: SLP-0002, SLP-0003 — earlier ledger-wide raises)
- State archival — https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival
- Resource limits & fees — https://developers.stellar.org/docs/networks/resource-limits-fees (live values: Stellar Lab / `stellar network settings`)
- Protocol 23 — https://stellar.org/blog/developers/announcing-protocol-23
