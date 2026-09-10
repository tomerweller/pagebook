# 042: Effects out of render

Date: 2026-09-09. View functions read state and write the DOM they own. They
do not call `update` and they do not start network work. Effects register
with `subscribe` and may do both. Each pass runs effects first, then views,
so a view in that pass already sees state an effect just wrote. An effect's
`update` also queues one more pass, which keyed entries skip.

## Update during a view

`update()` throws `Error("[store] update during view <name>")` while a view
is running. The per-view try/catch in `renderAll` reports it
(`console.error`, or rethrow under `?debug=render`). Effects are not under
that flag.

## Exception policy

`update()` wraps the callback in try/finally on both the versioned and
unversioned paths. Touched domain versions bump and a pass is scheduled even
when the callback throws. The exception then reaches the caller.

## read()

`read()` returns the live state and is documented as read-only. A source-scan
test over non-test `src/**/*.ts` bans mutation chains rooted at `.read()`:
assignment, increment, or `push|pop|shift|unshift|splice|sort|reverse|add|delete|clear|set`.
The scan cannot see mutation through an alias (`const w = read().wallet;
w.x = 1`). Only `update` bumps versions, so an aliased write still would not
notify.

## Ticket patching

The ticket mounts its `<section>` once while the wallet is enabled with an
active identity and patches slots in place. Price and quantity inputs keep
node identity. `writeValue` writes only when the state string differs from
the last string written for that field, skips the DOM write when the input
already holds it, and defers while the field is composing.
`compositionstart` / `compositionend` listeners sit next to the existing
`input` listener.

## ADR-030

The store finally-guard and the IME composition guard are closed.

Issue #21 acceptance criteria 4 and 5 (render-cost measurement of
domain-version skips, and a bounded incremental-renderer comparison) are
not addressed here and remain a design evaluation.
