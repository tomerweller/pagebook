# 010 — Order store vs. tick index: "authoritative vs. derived", not "reconstructible"

Date: 2026-08-17. Wording only; no design change.

## Decision

The Part I intro of `04-architecture.md`, §5's lifecycle paragraph, and the explainer's
storage-groups figure no longer say the tick index is "reconstructible from the order
store" or that the order store is "reconstructible from nothing", and the figure no
longer draws a "rebuilds" arrow between the two groups. The two groups are described
as **authoritative, funds-bearing, never stale** versus **derived, money-free, may run
stale**, and the intro states the actual repair mechanism: the staleness contract is
one-directional (a live level always has its bit set; a set bit over an emptied level
is tolerated) and the tolerated defect is cleared by the next `place` that lands on it.

## Why

"Reconstructible" reads as a mechanism, and there is none: no rebuild entry point, no
crank, no offline procedure — nothing ever reads `Level`s to recompute a `TickWord` or
`BestTick`. The property is true in the abstract but is never exercised, so stating it
invited the question of when it happens. The part of the idea that does the work is
that the index holds no funds and only decides how quickly matching finds the next
live tick, so an error there costs one wasted step on the walk, never a wrong
settlement. That is expressible without promising a rebuild, and it is the real reason
the index is allowed to be sloppy while the store is not.

Archival is covered by the same reasoning rather than by "reconstructibility": a word
comes back on restore exactly as last written, and every write that gives a tick
liquidity touches its word, so the hard direction of the contract holds across the
gap.

ADRs 008 and 009 still use the word "reconstructibility" for the storage taxonomy;
they are historical and are left as written. The taxonomy itself (which entries sit
in which group) is unchanged.
