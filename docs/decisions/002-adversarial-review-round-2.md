# 002 — Adversarial review round 2: blockers before implementation

An adversarial second-pass review of `04-architecture.md` and
`05-implementation-plan.md` was performed on 2026-08-13 after the fixes recorded in
ADR-001. The repository remains design-only; no contract implementation exists yet.

## Verdict

The design is promising, but it is not ready for M0/M2 implementation. The remaining
risks are concentrated in Soroban footprint determinism, queue lifecycle reuse,
arithmetic bounds, and resource-budget accounting.

## Critical findings

### 1. Dynamic page and append keys can still invalidate footprints

The contiguous `[start_tick, pad_end]` Level padding fixes races caused by new orders at
better or intermediate price ticks, but it does not cover all keys that execution may
derive later.

A fill can simulate while a level's head is in inline storage, then execute after a
concurrent fill advances the head into a `Page`. The transaction then needs a Page key
that was not declared. Likewise, a concurrent rest can advance `tail_seq`, causing the
remainder-rest path to derive a different Page and `OrderRef` key from the one simulated.

An RW conflict on the Level does not widen the footprint. If the transaction executes
after the conflicting transaction, the code still cannot touch a newly derived key
unless it was declared during simulation.

Evidence: architecture §2, §3, and §4; implementation plan M2.

Required resolution: redesign append allocation and/or footprint declaration before
implementing matching. Candidate approaches include separating matching from resting,
using client-supplied deterministic order identifiers, reserving append slots, or
declaring a provably sufficient set of page/order-reference keys. The current claim
that a fill fails only when it walks past `pad_end` is too strong.

### 2. Cancelled empty levels can become permanently `LevelFull`

If all orders at a level are cancelled, `total_open` becomes zero, but the design does
not require `generation` or `tail_seq` to reset. The next fill only clears the stale
bitmap bit. After enough historical appends, `tail_seq` reaches the generation's
capacity and all future rests at that otherwise-empty price return `LevelFull`.

Required resolution: define an empty-level reset path. It must safely advance the
generation, reset the queue counters, and preserve claimability of any older filled
orders. Add a property test that fills a level to capacity through cancellations, clears
the stale bit, and successfully reuses the level.

### 3. Arithmetic bounds do not cover all public paths

The documented creation bound covers one maker order's quote value, but not:

- base escrow: `max_order_lots × lot_size`;
- taker `qty_lots` or aggregate quote across multiple crossed levels;
- aggregate quantities in `route`;
- `total_open` across a full level;
- accumulated `Fees`; or
- multiplication by an unbounded `fee_bps` value.

Checked arithmetic prevents silent wrapping but can still turn a reachable state into a
permanent denial of service. The stated maker-order bound is not an overflow proof for
the public interface.

Required resolution: define and enforce bounds for base and quote amounts, taker size,
route totals, level totals, fee rates, and fee accumulation. Add these bounds to market
creation and operation-level validation, with property tests at each maximum.

## Serious findings

### 4. Worst-case resource budgets are materially understated

The documented maximum sweep assumes 32 levels in 32 distinct L0 words but reports
approximately 40 writes and 8 KB. A conservative write count already includes:

`32 Level + 32 L0 + L1 + Best + Fees + 2 vault balances = 69 writes`

before considering admin/market entries, page cleanup, TTL updates, or other state
changes. Using the documented packed payload sizes, these entries alone exceed 17 KB
of payload before ledger-entry framing.

Required resolution: derive budgets from an explicit worst-case state-transition matrix,
including bitmap dispersal, pages, tombstone cleanup, TTL behavior, fees, and SAC
entries. Make the corrected figures gates before matching is considered complete.

### 5. Per-operation `Admin` TTL bump creates a global serialization point

The TTL policy says the instance `Admin` entry is bumped by every operation. If that
bump writes the instance entry, every market and every token pair shares a global RW
conflict. This contradicts the concurrency discussion, which identifies vault entries
as the true serialization points.

Required resolution: do not bump the instance on every market operation. Use a bounded
instance TTL strategy, a dedicated maintenance path, or another mechanism that does
not put a global instance write in every transaction. Measure the actual footprint and
cluster behavior.

### 6. Authentication and initialization semantics are underspecified

The public interface does not state authentication requirements for `init`, admin
changes, upgrades, fills, or cancellation. In particular, a first-caller-wins `init`
can allow an unauthorized caller to establish administrative control.

Required resolution: specify `require_auth` behavior for every state-changing entry
point, define deployer/initializer binding, and add malicious-caller tests. Upgrade
authority and the custody trust model should be explicit.

### 7. Page generation reuse relies on an unstated invariant

`Page` keys do not include generation, while generation reset reuses page keys. This can
be safe only if matching strictly ignores every slot whose sequence is at or beyond the
current `tail_seq`, and if append writes slots sequentially without gaps. That rule is
not stated as an invariant or tested as a page-initialization protocol.

Required resolution: explicitly specify the `seq < tail_seq` decoding rule and test
generation reset with stale nonzero page contents, or add generation tagging/clearing
to pages.

### 8. Route and event resource limits are unresolved

`route` is bounded by `MAX_ROUTE_LEGS`, but the plan does not yet bound the union of
per-leg footprints, unique vault tokens, fee entries, page keys, write bytes, or event
bytes. A route with many legs can exceed the 400-entry or 16,384-byte event limit even
when every individual leg fits.

Required resolution: define aggregate route limits and reject configurations that cannot
fit the transaction resource envelope. Resolve this before M3, not as an open question
during implementation.

### 9. `post_only` behavior is unsafe around stale `Best` state

The design permits stale bitmap/Best state for O(1) cancellation. A post-only order
that checks only the current `Best` entry can observe an empty stale level and then rest
even though a live crossing level exists farther along the bitmap.

Required resolution: define post-only semantics against the true live best, including
bounded stale-bit cleanup and its footprint requirements, or explicitly document a
different post-only guarantee.

## Recommended implementation gate

Before M0/M2, create follow-up decisions for:

1. deterministic append/page allocation under concurrent simulation;
2. empty-level reset and generation/page reuse;
3. complete arithmetic and route bounds;
4. corrected worst-case footprint/write-byte/event budgets; and
5. authentication and initialization semantics.

Until those decisions are resolved, scaffold work is reasonable, but matching and
production-facing resource claims should not be treated as implementation-ready.
