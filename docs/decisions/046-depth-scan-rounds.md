# 046: read the depth window in rounds, not one fixed batch

Date: 2026-09-10. Found while walking the UI scenario catalogue
(`docs/client/UI-SCENARIOS.md`) against the live testnet deployment.

## What broke

The client had one live ask on the book, a resting order at tick 18000 that
was the only ask in the market, and the depth ladder said `— no asks in
window`. No warning and no error, just an empty side, while the KPI row showed
`best ask 0.17854` with a `stale best` badge.

The bitmap is the cause. Bits are set when a level takes its first order and
only a sweep clears them, so a re-quoting market maker leaves a trail of set
bits on levels that have since emptied. Measured on testnet at the time:
569 set bits at or above the best-ask tick in one word, one of them live, at
candidate 137.

The walk collected `max(6 * depth, depth + 64)` = 76 candidates from the
bitmap, read all 76 Level entries in one batch, found every one of them empty,
and rendered the side empty. `moreAsks` stayed false because it only asked
whether any bitmap *word* had gone unread. Every word had been read, so
nothing said the window had stopped short.

The same truncation was quietly shortening healthy books: a side would render
two levels while ten were live, because phantoms upstream ate the candidate
budget.

## Decision

Candidates are read in rounds. `scanLevels` (exported from
`clients/web/src/book.ts`) takes both sides' candidate lists and reads up to
`LEVEL_SCAN_CHUNK` = 96 candidates per side per round, for at most
`LEVEL_SCAN_ROUNDS` = 5 rounds, and stops for a side as soon as it holds
`depth` live levels. Candidate order is preserved, so a side still shows the
first `depth` live levels walking away from the best tick.

- A healthy book costs exactly one round: 192 keys, one `getLedgerEntries`
  call, the same shape as before. The scan only pays for extra rounds when
  it is walking a phantom trail, and a trail is exactly the case where the
  old code returned a wrong answer.
- The candidate cap rises from 76 to 480 per side, which covers the trail
  lengths seen on testnet. It is a cap, not a guarantee: a trail longer than
  480 still hides what is behind it.
- `SideRows.scanned` reports how many candidates were actually read, and
  `moreBids` / `moreAsks` now fire when a side stopped short of its own
  candidate list as well as when a bitmap word went unread. A truncated
  window says `more levels beyond the read window` instead of pretending to
  be the whole book.
- `staleBest` keeps its old meaning: the level under the contract's pointer is
  empty. The KPI row keeps reporting the pointer, because that is where a
  taker's sweep starts, and the badge is what tells a reader the ladder below
  begins somewhere else.

## Cost

Read-only RPC, off the transaction path, so no footprint or fee consequence.
Worst case is five sequential `getLedgerEntries` calls of up to 192 keys per
walk, and it only happens on a side that has no live levels within 480
candidates of the pointer. The ledger-sequence skew check spans the extra
calls, so a walk that straddles a ledger close is still detected and retried
once, as before.

## Not done

Clearing stale bits is the contract's job and the sweep crank already does it;
nothing here changes that, and the client must keep tolerating a trail. A
walk that starts from the first live level instead of the pointer would drop
the phantom cost entirely, but it needs a contract-side pointer repair to be
worth it.
