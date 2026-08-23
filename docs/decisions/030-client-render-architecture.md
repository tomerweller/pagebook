# 030: client render architecture — one store, one render path

Date: 2026-08-23. The web client's view layer was rebuilt in five audited
milestones (`docs/client/ARCH-PLAN.md`, commits 81d6239 → bd2ef81) after an
architectural review traced four bugs — two shipped, two latent — to one
cause: five render regimes, each skipping work by comparing a hand-written
summary of its inputs.

## The decision

Incremental hardening with zero new dependencies, over a reactive library
(considered up to full frameworks; declined on evidence — every failure was
an input-enumeration bug, and none of the hazards a library uniquely
addresses had fired). The shape:

- One store: `update(fn)` mutates state and coalesces to exactly one render
  pass per microtask. Handlers and async completions never touch the DOM.
- Domain versions bump automatically via a mutation-tracking proxy; keyed
  views subscribe to versions. No hand-enumerated dependency lists exist,
  and a source-scan test bans the old ones by name.
- The markup cache is the only skip layer: emitted html is compared as a
  string, so the html itself is the complete dependency record. A blocked
  write is never recorded; `?debug=render` asserts cache == DOM each pass.
- `swapPreservingFocus` (90 lines: caret, selection, scroll, live input
  value) is the single writer for sections with focus or scroll inside,
  replacing per-component focus policies.
- A jsdom render suite pins every historical bug; audits mutation-tested
  the pins (each guard's removal fails exactly its test).

A tripwire was defined — swap the view layer to lit-html if the focus
utility degenerated — and not tripped.

## Verification

Each milestone was implemented, independently audited (with scratch-copy
mutation testing and live-site checks), fixed, and shipped green through
the full gate. Final validation against the live deployment: repo-wide
sweep clean; 89 tests green with regression assertions byte-stable; a
sim-active ticket on a moving book performs zero DOM mutations when the
preview result is unchanged; 0 invariant violations and 0 console errors
across a 17-minute session including a 12-minute interactive soak with
every mutation section-attributable.

## Left open (tracked in the plan's handoff list)

Store finally-guard on throw-mid-update, IME composition guard in the focus
swap, the events seen-set mutation outside update(), and — engine-layer,
not render — the deep-crossing pad key-count cliff (a padded band past
~200 read-write keys exceeds the per-transaction cap and fails cleanly).
The plan's "explicitly not solved" list (async races, RPC economy, the
polling scheduler, e2e breadth) also stands.
