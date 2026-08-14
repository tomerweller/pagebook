# Deepstate-contracts: evaluation and why it doesn't port to Soroban

*Source: https://github.com/deepstate-protocol/deepstate-contracts (reviewed Aug 2026,
~3,300-line `DeepstateV1.sol`, Solidity 0.8.28/Foundry). An EVM prototype of "Radix
Matching": a two-sided native-ETH/ERC20 matching engine over a single
`mapping(bytes32 => Branch)` radix (Patricia) tree. Unaudited; heavy formal-verification
suite (Halmos, SMT, invariants, 100% coverage gates). Gas numbers below are from the
repo's committed `.gas-snapshot.runtime`.*

## The design, compressed

Every node — resting order or aggregate branch — is one packed `bytes32`:
`tick:i32 | quantity:u160 | correction:u32 | nonce:u32`. Sort keys are 64-bit
`price||nonce` (asks price-inverted), so tree depth is hard-bounded at 64. Branches are
**self-addressing**: a branch's key is derived from its children (max child path key,
sum of quantities, correction code), and its two child pointers are stored at
`tree[branchKey]`. Prices are logarithmic ticks `2^(96t/2^31)` covering `[2^-96, 2^96)`;
"correction codes" on uniform-price branches make aggregate quote values exactly equal
to the sum of per-leaf rounded notionals.

## What is genuinely excellent (on EVM)

- **Leaves cost zero dedicated storage** — an order exists only as a value inside its
  parent's pointer. ~3 slots per resting order all-in (`orderOf` owner slot + 2 slots
  for the one new branch).
- **Depth-bounded worst case.** Everything is O(64) regardless of book size. The repo's
  adversarial depth-64 "comb" benchmarks: sweep ≈ 327k gas, cancel-through ≈ 425k gas.
  Real DoS resistance: no book shape makes anyone's op cost more than ~450k.
- **Aggregate subtree consumption.** A fully-crossing subtree that fits the incoming
  quantity is consumed by cutting one pointer; uniform-tick subtrees price in O(1) via
  correction codes. Sweeping 1,000 same-price orders ≈ sweeping one.
- **Right-spine dirty optimization.** Top-of-book fills/cancels update one child pointer
  on a stable anchor and defer the exact ancestor rebuild to the next same-side insert —
  the common case does O(1) SSTOREs instead of O(depth).
- **Decoupled maker claims.** Matching never touches maker balances or ownership;
  makers claim via `cancel`, and "absent from the tree" *proves* fully-filled. Claims
  are O(1)-ish (~37k gas).
- Measured profile: simple full match ~77k gas incl. transfers; partial ~97k; rest on
  empty book ~150k; rest into a 5,000-order book ~164–173k; cancels ~40–50k.

Weaknesses on its home turf: storage garbage is never reclaimed (only `orderOf` is ever
deleted; every branch re-key abandons 2 slots forever), and off-spine mutations re-key
every ancestor (~2 fresh SSTOREs/level — a deep off-spine cancel can run to ~millions of
gas; the committed benchmarks don't cover this case — their "rest into large book"
inserts at top-of-book, the cheap path).

## Why the port to Soroban fails

Raw limits are *not* the problem (post-SLP-0004/0005: 400 footprint entries, 200 write
entries, 400M instructions per tx — a depth-64 comb walk fits). Three structural
mismatches are:

1. **Content-derived keys vs simulation-time footprints (fatal).** Every fill/rest/
   cancel renames branch keys along its path, so the write set depends on the exact tree
   state at execution. Footprints are declared at simulation. Any concurrent operation
   on the same book re-keys the right spine → every racing transaction hard-fails with a
   footprint mismatch (on EVM they'd just reorder). Busier market ⇒ higher failure rate,
   and there is no way to over-declare unpredictable keys. The design's signature
   feature is precisely the thing Soroban cannot host.
2. **Archival semantics invert the garbage trade.** On Soroban, abandoned branches would
   stop being rent-extended and archive out of live state (good — better than EVM's
   permanent garbage), but content-derived keys can *recur* (identical child quantities
   re-forming an identical branch word), and recreating a key whose old incarnation sits
   in the hot archive forces a restore-then-overwrite — an invisible tax plus disk reads
   against a deliberately small (400 KB/ledger) disk-read budget. Someone must also pay
   TTL on live cold depth that no operation touches.
3. **Fee-model mismatch.** The EVM design optimizes SSTORE count above all (right-spine
   anchors, abandon-don't-delete, bit-packed words, assembly slot tricks). Soroban prices
   footprint entries + bytes written + rent + instructions; per-entry framing
   (~100–200 B) swamps 64-byte payloads, bit-packing buys little, and 160-bit quantities
   would need U256 host types. Most of the cleverness has nothing left to optimize.

Also: Deepstate's transient-storage machinery (reentrancy guard, match buffer, route
netting) becomes plain invocation memory on Soroban (the host forbids reentrancy), and
its gas-capped best-effort hooks **cannot** be replicated — Soroban has no per-call
instruction cap, so an untrusted synchronous hook could consume the whole transaction
budget. Hooks must become events.

## What PageBook keeps from it

Crankless atomic taker settlement; deferred O(1) maker claims keyed by a packed order
id, with "absence provable from counters"; abandon-don't-iterate consumption of filled
queues (re-derived at stable keys via level `generation` counters); multi-leg route
netting with one transfer per token; fee caps and integrator fees. What it drops:
content-addressed keys, the radix tree, log ticks + correction codes (per-market
tick_size/lot_size quantization with exact i128 products instead), right-spine anchors.
