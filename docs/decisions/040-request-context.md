# 040: Request context for wallet pane and ticket

Date: 2026-09-09. Async reads in the wallet pane and ticket commit only
when the request they started is still the live one.

## Helper

`clients/web/src/request.ts` exports `createRequestGate`. `begin(scope, input)`
increments a version and returns a frozen token with contract, market,
account, that version, and the captured input. `invalidate()` increments
the version without issuing a token. `accepts(token, live)` is true only
when `token.version` equals the gate's current version and the token's
scope equals `live` field by field.

The helper is not a task scheduler. In-flight work may finish; a stale
result is dropped.

## Commit rule

Balance refresh, order refresh, and ticket preview each capture a token
before the first await, or call `invalidate` when the input is already
unusable. After the await they write store state only if `accepts` is
true. A change from valid to invalid input bumps the version. So does a
market A to B to A round trip, including on the same ledger, because the
pane keys ledger refresh on market plus `latestLedger`.

Identity-changing handlers clear `wallet.account`, `wallet.trustlines`,
`wallet.openOrders`, `book.ownTicks`, `provisionStatus`, `busy`, and
`provisioning`. The ticket quote key carries account sequence and
spendable balance, not the public key, so only a cleared account object
changes that key and re-runs the preview on the invalid path.
`waitAccountExists` captures the public key it is polling and writes
`wallet.account` only while that key is still `wallet.active.publicKey`.
A switch mid-poll leaves the loop and drops the result. Friendbot,
trustline, and auto-provision capture the public key at start and write
`status`, `provisionStatus`, `busy`, and `provisioning` only while that
key is still active.

## Intent rule

A place click freezes one `TradeIntent`. Nonce allocation, quoting, and
`submitPlace` read that object. The ticket phase, the log line, and
`onRested(nonce, intent)` attach to the intent even if the visible market
or ticket fields have moved. The tape attribution set is identity-scoped
and takes the hash only while the intent's taker is still active.

## ADR-030

ADR-030 listed async races as not solved. That item is closed for the
wallet pane and the place ticket. The orders panel's settle and replace
flows are still unguarded.
