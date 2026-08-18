# 021 — PR #1 review, round 2: findings and fixes

Date: 2026-08-18. Second independent review of the branch after ADR-020 (three
focused finders plus a funds tracer; nothing reproduced as a vault loss). All
findings below are fixed on the branch.

## Findings and fixes

1. **Book-dependent pay-ins would fail authorization on any race.** A SAC
   `transfer(user, vault, amount)` calls `user.require_auth()` on its exact
   arguments, and the user's signed authorization tree is built at simulation. The
   netted "what the taker ended up paying" changed with every in-flight fill, so
   the sub-invocation no longer matched the signature and the whole `place`
   failed — invisible under `mock_all_auths`. Fix: the pay-in is the full escrow at
   the limit price (bid `qty × limit × tick_size` quote, ask `qty × lot_size` base;
   `replace` the full new escrow), a pure function of the arguments; everything
   variable (unspent escrow, output net of fee, old proceeds and refunds) flows
   out of the vault; `Netting` keeps `pay_in` and `pay_out` ledgers per token and
   never nets them (at most one transfer each way per token). Architecture §8, §10
   updated; a test signs the tree at simulation with `mock_auths`, races an ask
   into the band, and applies.
2. **The pad omitted the caller's own balance entries.** Every transfer touches
   the caller's balance in that token; the client `pad`, `keys_for_settle` and
   `keys_for_replace` now declare `UserBalance(token)` for both tokens; §14 says so.
3. **`append` ignored `PageRange.first`.** A tail that regrew into pages below the
   declared range could write an undeclared page. Fix: the append side uses the
   same rule as consumption — page 0 implied, otherwise `first ≤ page ≤ last`,
   else `RetryRest`.
4. **After a sweep at the last tick of a word the frontier landed on the swept
   tick.** `frontier()` is now the first tick past `limit_tick`'s word in the walk
   direction (clamped to the band), so it is strictly beyond every swept tick and
   beyond the limit; a spurious BestTick write and `top_changed(0,0)` over an
   already-empty side is skipped. §5/§8 updated.
5. **`quote_place` under-reported fills for a paged head.** DryRun used an empty
   consume window. It now assumes the window the client will declare from the
   returned head position, `[page(head_sim), page(head_sim)+1]`, so quoted fills
   match the apply.
6. **`restore_marks` did not mark `page(head)+1`.** Consumption may run into it;
   both pages of each declared consume window (and both append pages) are now in
   the touched set.
7. **`set_market_caps` accepted zero caps and unbounded `max_pages`.** Zero
   `max_levels_crossed` / `max_slots_scanned` fail `BadQuantization`; `max_pages`
   above 1,024 fails `QtyOutOfBounds`. `create_market` / `set_market_caps` also
   bound `LEVEL_CAP × max_order_lots` to u64 (`open_lots` width).
8. **A TTL test asserted nothing.** It now asserts the documented test-host
   behaviour (ADR-016).
9. **A no-op `save_level`** on a partial branch that consumed nothing is skipped.

## Round 3 (same day, third independent pass)

10. **A frontier written in flight could make the next taker read a bit-less
    `Level` outside its band.** Fix: a walk whose first tick is a recorded best it
    did not get from the client checks the bit (word always declared) before
    reading any Level; and the frontier is now the first tick of the next
    *summary-set* word (the summary is always declared), which also makes "empty"
    exact and retires the band-edge special case. Multi-word race test added.
11. **Flush order blocked chained routes.** Pay-ins were flushed before pay-outs,
    so a route selling what its previous leg bought needed the user to pre-hold
    the intermediate token, and a replace needed liquid balance for escrow it
    already held. Fix: per token, pay out first when the vault already holds the
    amount, otherwise pay in first. Chained-route test added.
12. **Footprint gates were §17 × 1.5 (3–4× measured).** Now measured + small slack.
13. **`replace` did not validate its window; `collect_fees` accepted any market;
    admin ops did not bump the instance TTL (§12 says they do); a geometry
    mismatch in a stored `Market` was silently misread.** All fixed; several
    no-op tests strengthened; `Cargo.lock` tracked; CI builds the wasm target.

## Checked and found sound (by the reviewers)

§7 settlement rows and `open_lots` accounting; escrow versus payout per token; the
split-form fee; `replace` in every fill state and across sides; route netting across
markets sharing a token; the empty-level reset against `g < G` claims; walk
invariants 3/5/8 including `next_set_tick` word boundaries in both directions;
opposite-side reads confined to `[word(start)..word(limit)]`; auth and pause matrix;
bounds and checked arithmetic; packed roundtrips and the stale-slot rule.

## Known, accepted

A cancel-to-empty leaves the recorded best on the emptied tick until a walk visits
it (§5 staleness contract, ADR-013); the frontier heals only sweeps. `collect_fees`
is permissionless by design (§12).
