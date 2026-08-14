# 003 — Resolutions for ADR-002 (adversarial review round 2)

Each ADR-002 finding was evaluated and resolved; `04-architecture.md` and
`05-implementation-plan.md` are updated to match. Verdicts below: **accepted** means
the finding was correct as stated; **accepted, reframed** means the risk was real but
the failure mode differed from the write-up.

## Critical

**1. Dynamic page/append keys — accepted; this was the biggest remaining hole.**
Two distinct races, two mechanisms:

- *Consume race* (concurrent fill moves a level's head into pages): sweeps never read
  slots at all, so only the final partial level touches them. The client now declares
  per-level **consume windows** (pages around the simulated head) and passes them as an
  argument; execution treats the window edge exactly like a loop cap — stop, persist
  progress, refund remainder. Graceful, never a trap.
- *Append race* (concurrent rests move `tail_seq`; concurrent sweep bumps
  `generation`): this was worse than the ADR stated — it wasn't an edge case, since the
  round-1 `OrderRef` key contained `(generation, seq)`, **every** concurrent rest at
  the same level invalidated the simulated key. Resolution: `OrderRef` is re-keyed to
  `("O", mkt, owner, nonce)` with a client-chosen nonce — declarable before submission
  regardless of what the book does. Coordinates move into the entry's contents and the
  `rested` event. The slot write itself is covered by a cheap append window
  `{page(tail_sim), +1, page 0}` (handles a full page of concurrent rests and a
  sweep/reset); landing outside it is the typed error `RetryRest`, not a trap.
- The §4 claim is restated exhaustively: **traps only past `pad_end`; every other race
  degrades gracefully.** M2 gains race tests for head-into-pages, tail-across-boundary,
  and sweep-bumped generation.

**2. Cancelled-empty levels permanently `LevelFull` — accepted.** New rule in §2: a
rest finding `total_open == 0 && tail_seq > 0` resets the queue (`G += 1`, counters to
0). Safe because at `total_open == 0` every unclaimed order is fully filled (`g < G`
pays it identically after the bump) and every tombstone's `OrderRef` was already
deleted at cancel. M1 gains the fill-to-`LevelFull`-via-cancels → reset → reuse test.

**3. Arithmetic bounds incomplete — accepted.** §0 now proves bounds for the whole
public surface at creation: `LEVEL_CAP × max_order_lots × tick_max × tick_size ≤
i128::MAX / (4 × MAX_ROUTE_LEGS)` (one order ⊂ one level ⊂ one sweep ⊂ one route, with
fee headroom), the mirror bound for the base side, `fee_bps ≤ FEE_BPS_MAX`, and taker
qty subject to `max_order_lots`. `Fees` accumulation is bounded by SAC total supply
(< i128 by construction). M1 gains property tests at each maximum.

## Serious

**4. Budgets understated — accepted.** The ADR's conservative count (69 writes) was
right and ours (~40/~8 KB) was wrong. §4's table is re-derived and now shows its own
arithmetic: max sweep ≈ 70 writes / ≈ 22 KB (7.6% of a ledger's write bytes); 8-level
taker ≈ 21 writes / ≈ 6 KB. M4 starts from an explicit worst-case state-transition
matrix instead of sampling.

**5. Per-op instance TTL bump — accepted.** It would have been a global write shared by
every market — exactly the serialization point §4 warns about, reintroduced by a TTL
footnote. §5 now forbids instance writes in market ops; instance TTL is maintained by
admin ops plus a permissionless `keepalive()` crank. M4 asserts the instance entry is
absent from market-op write sets.

**6. Auth/init underspecified — accepted.** Initialization moves to
`__constructor(admin, fee_recipient)` (no first-caller-wins `init`). §6 lists
`require_auth` per entry point (taker/owner/admin; cranks unauthenticated by design)
and states the custody trust model plainly: an upgradable admin can move the vault —
multisig/timelock for value-bearing deployments, burn-address admin for trustless ones.

**7. Page generation reuse — accepted.** The unstated assumption is now invariant 9
plus a §1 "stale-slot rule": a slot is meaningful iff `seq < tail_seq` of the current
generation; appends are gapless; readers ignore everything at/beyond `tail_seq`. M3
tests generation reset over dirty pages.

**8. Route aggregate limits — accepted.** Route caps are now per-transaction, not
per-leg: one shared `MAX_LEVELS_PER_FILL` / `MAX_SLOTS_SCANNED` budget across legs, so
a route's write/event/footprint ceiling equals a single max fill plus per-leg
constants. Event bytes bounded by the same caps (~6.4 KB worst case, asserted). The §0
creation bound reserves `MAX_ROUTE_LEGS` headroom for netted transfers. This resolves
the former open question 4.

**9. post_only vs stale `Best` — accepted, reframed.** The dangerous behavior is the
*smart* implementation, not the naive one: since `Best` is never worse than the true
best (invariant 3), comparing against the recorded `Best` as-is can only **false-
reject** near stale state — it can never rest a truly crossing order. Walking past
stale levels to find the "true" best would widen the footprint or cross the book. So
the conservative one-read check is now the *defined* semantics of post-only, with the
false-reject case documented and tested (M2).

## Consequences worth naming

- `fill` returns `(rested, filled, quote)` instead of an order id — the handle is the
  caller's own `(owner, nonce)`; coordinates arrive in the `rested` event.
- `OrderRef` grows to ≤ 160 B (coordinates moved into contents); still written once,
  deleted on claim/cancel.
- Two new typed errors: `RetryRest`, `OrderExists`. Two new entry points:
  `keepalive()`, `order()` view. `init` is gone (constructor).
- The implementation gate ADR-002 asked for is satisfied by these resolutions; M0 may
  proceed, and M2 may not land without the sim-to-apply race suite.
