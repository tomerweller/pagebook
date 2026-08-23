# Client architecture plan: one store, one render path

Source: an architectural review of `clients/web/` (full text in the session's
`arch-review.md`; findings summarized here). The client works and is live, but
four bugs — two shipped, two latent — are instances of one disease, and this
plan removes the disease rather than the instances.

## Diagnosis (from the review, verified with file:line evidence)

The app has five render regimes (markup-cache sections, a surgical balance
path, the ticket's draw/paintChrome fork, orders' structKey paint, and direct
writes), each skipping work by comparing a hand-written summary of its inputs.
Every summary is a dependency list maintained by hand; every missed dependency
is a shipped bug:

- symbols stuck at "?" (shipped, fixed by hand-adding `drawnSyms`),
- BUY/SELL toggle not repainting (shipped, fixed by hand-adding class writes),
- `orders.ts` `structKey` missing token symbols/decimals (latent, found in review),
- `MarkupCache` patch path records html it never wrote, then skips forever —
  stale trades/activity after scrolling (live today, found in review).

Root cause, named: (1) invalidation by manual input enumeration, (2) render
entry point chosen by event source (focus location) instead of state, (3) state
mutation and DOM mutation interleaved in handlers with no single "state changed
⇒ view recomputed" point.

What is sound and preserved untouched: the engine (pure, Rust↔TS
golden-fixture-locked — non-negotiable), BigInt/exact-rational math, the
`book.ts` data layer with its injectable RPC, keystore/provision/network
modules, all pure html generators, the terminal design, static Pages hosting.

## Decision

**Option A of the review: incremental hardening with zero new dependencies,
with an explicit tripwire.** One subscribe-able store; one render loop; the
markup cache (fixed) as the only skip layer — the emitted html string becomes
the complete dependency record, so no hand-written invalidation list survives;
one shared focus-preserving swap utility replaces the per-component focus
policies.

Dependencies were declared fully open (up to a full framework), and the review
still recommends A on the evidence: all four failures are input-enumeration
bugs, which A kills structurally with near-zero markup churn and no new
supply-chain surface in a money-adjacent client; the hazards a reactive
library uniquely addresses (binding-level updates, auto-escape) have not
fired. **Tripwire:** if the focus-preservation utility fights back for more
than a step or two of A4–A5, swap the view layer to lit-html (~7.5 KB, no
compiler; templates port nearly 1:1 from the current string style) on top of
the already-landed store — the store and html generators are identical in both
futures, so nothing done before the tripwire is wasted.

## Milestones

**A0 — stitches (land immediately, before or with A1).**
1. Fix `MarkupCache` patch-path poisoning: never record html that was not
   written to the DOM; blocked sections retry next render; `?debug=render`
   asserts `cache[name] === node.innerHTML` after every pass.
2. Add token symbols/decimals to orders' `structKey` (one line; pre-empts the
   third "?" bug).
3. Guard orders' replace form against focus-destroying rebuilds.
4. Gate the ticket preview: re-simulate on relevant change (top of book,
   account, inputs), not on every ledger tick — removes one background
   `simulateTransaction` per ledger per open wallet.
5. jsdom render tests reproducing both shipped regressions (late metadata ⇒
   symbols appear; focused click ⇒ toggle classes flip). These seed the render
   suite and would have caught both bugs.

**A1 — store.** `src/store.ts` (~60 lines): domain state objects,
`update(fn)` schedules exactly one `renderAll()` per microtask. No handler
touches the DOM. Market view routes through it first.

**A2 — market view on the loop.** All five main-pane sections rendered from
the store through the fixed cache; module-level `let`s in `main.ts` die.

**A3 — wallet pane on the loop.** pane.ts closure state into the store; its
html functions unchanged; write/patch split deleted.

**A4 — orders on the loop.** `structKey`/`liveKey` die (html comparison
replaces them); shared `swapPreservingFocus` utility introduced here.

**A5 — ticket on the loop.** The draw/paintChrome fork dies; `drawnSyms`
dies. Riskiest file, last, with the render suite already in place.

Each milestone ships independently (the app is releasable at every step), with
the full gate: vitest (incl. the growing jsdom render suite), tsc, build, e2e,
and the M11 guarantee re-verified (zero wallet DOM mutations across quiet
ledger ticks, caret/details/scroll survival).

## Explicitly not solved by this plan (tracked, scheduled separately)

- Async/data races: generation counters and market-switch guards become
  visible in the store but stay manual.
- RPC economy beyond A0.4: per-ledger account/trustline reads, the double
  render/notify per refresh cycle.
- The polling scheduler (backoff/visibility/forced interplay) is bespoke and
  untested.
- e2e breadth: replace, batch, archived-restore, and error paths have no
  end-to-end coverage.

## Verification of the whole

After A5: a mutation-audit pass in the browser (MutationObserver across ticks
and interactions), the two shipped regressions' tests plus one per latent
finding green, `?debug=render` invariant clean, and a soak of the UI against
the live market with the wallet open (no stuck sections, no focus loss, no
stale panels after scroll).
