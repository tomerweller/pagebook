# 044: Drop the slot-scan cap

Date: 2026-09-10. Removes `Market.max_slots_scanned` and the independent loop
budget that field fed. A `Market` layout change, so a redeploy (ADR-023).
Cutover follows the ADR-036 / ADR-037 procedure; the record is appended when
that happens. The deploy itself is outside this PR.

## Decision

Remove the independent slot-scan cap. `level_cap` is the bound. Keep the
whole-level sweep shortcut and `MAX_LEVELS_CROSSED` (still shared across
route legs).

`consume_partial` scans to demand or to the tail. `advance_head` skips the
whole zero run. Drop `max_slots_scanned` from `Market`, `set_market_caps`,
and the client `MarketInfo`.

Invariant 7: slots scanned per transaction ≤ `MAX_ROUTE_LEGS × LEVEL_CAP_MAX`
= 512.

Keeping the field and forcing it to `level_cap` was rejected: a dead field
and a dead parameter that every reader must learn is meaningless, and a
redeploy is the project's normal path for layout changes (ADR-036, ADR-037).

## Why

`Market.max_slots_scanned` predates ADR-037. A level's whole queue is one
`Level` entry of at most `level_cap` (≤ `LEVEL_CAP_MAX` = 128) slots, and a
walk consumes partially at most once, so slot iterations are already bounded
by `level_cap` per place and per settle, and by `MAX_ROUTE_LEGS × level_cap`
per route. At the default caps (64/64) the scan cap cannot bind in any
single `place` or `settle`. It only changed outcomes for routes whose later
partial legs were starved by the shared budget, and for markets raised above
64 slots.

Measured on the WASM test host (soroban-sdk 27.0.6, fresh env per shape,
equal storage and SAC transfer counts within each pair):

| Shape | WASM instructions | Native |
|---|---|---|
| 128-deep level, partial take, 2 slots read | 2,192,579 | 1,510,884 |
| 128-deep level, partial take, 64 slots read | 2,382,963 | 1,527,111 |
| 128-deep level, partial take, 128 slots read (cap = level_cap) | 2,588,093 | 1,547,046 |
| same request under cap 64 (stops at 64 slots, refunds) | 2,730,561 | 1,870,844 |
| tombstoned level, partial take, 1 slot read | 2,382,983 | 1,722,783 |
| tombstoned level, partial take over 126 tombstones, 128 slots read | 2,719,644 | 1,759,232 |
| same under cap 64 (head stranded, refunds) | 2,928,060 | 2,117,982 |
| settle tail order, no head advance | 1,501,709 | 915,238 |
| settle head, advance over 64 zeros (cap 64) | 1,664,874 | 934,312 |
| settle head, advance over 126 zeros | 1,831,503 | 952,393 |
| route 4 legs, 8 slots read | 8,907,151 | 7,643,949 |
| route 4 legs, 4 × 128-slot partial (512 slots) | 10,489,207 | 7,788,597 |

Write entries / write bytes are the same in each pair (partial take 7 /
2,920; settle 5 / 2,288; route 13 / 8,776). Marginal cost ≈ 3.1k WASM
instructions per slot (≈ 300 native). Worst uncapped shape is +1.6M
instructions per transaction: 0.4% of the 400M cap, ≈ 1,100 stroops at 7
per 10k.

Every capped shape cost more instructions than the uncapped one, because a
cap-induced stop adds a refund transfer. The cap bought nothing and cost a
state machine: `Budget.slots`, `clamp_to`, the cap clause of
`crossing_remains`, the bounded `advance_head`, the §7 stranded-head-by-cap
clause, a `Market` field, a `set_market_caps` parameter, and a client
protocol field.

## Fill and refund behavior

A call that refunded after hitting the scan cap now consumes more liquidity.

- A 100-lot take on a 128-deep level of 1-lot asks takes 100 in one call
  (it took 64 and refunded 36).
- A route with a partial level on every leg no longer starves later legs:
  two 64-deep 2-lot levels, 127 lots each, both take 127 (the second leg
  refunded after the shared 64-slot budget ran out).
- Settling the head of a tombstone run longer than 64 advances past the
  whole run in one call (it left the head stranded).
- A rest-allowed remainder still refunds when `MAX_LEVELS_CROSSED` ends
  the walk.

## What changed

- `MAX_SLOTS_SCANNED` and `Market.max_slots_scanned` removed.
- `Budget` keeps only `levels`. `consume_partial` and `advance_head` bound
  on `tail = slots.len()`, which `append` keeps at or under `level_cap`.
- `set_market_caps` loses the `max_slots_scanned` parameter. Client
  `MarketInfo` drops the field.
- Architecture §1, §2, §7, §8, §12, §19; 05, 06, 07, 08; two explainer
  sentences.
- Tests: `raised_level_cap_allows_a_deeper_queue` flipped;
  `settle_head_advances_past_the_whole_tombstone_run`,
  `taker_skips_a_long_tombstone_run_in_one_call`,
  `route_partial_levels_on_each_leg_take`,
  `bound_route_four_full_partials`.

## Cutover record

- 2026-09-10. Same admin and identities as ADR-036 and ADR-037:
  `pagebook-builder-2` (`GB2JQQZB…5SLK`) deploys and administers; `pb-mm-fly`
  and `pb-trader-fly` run the bots; `pb-fly-funder-1` / `-2` are the smoke
  identities.
- Wasm hash `79ed1eeff844ac8779e6f3da5df1f720e7489b2bbc2c7aebfa613c46f3184af6`
  (29,566 B, 293 B under ADR-037's build), built from `main` at `0dfb8e6`
  (PR #36; 149 contract tests and 313 web tests passing locally). Upload tx
  `212e6c…8356`, deploy tx `57d450…aa58`.
- Contract `CAYPAQDKNWMHRATKU5DQ327VDHVRSIVK7UGVWT2A5SUZCUFTLUHXH2JA`.
- Market 0 (tx `5157c1…560a`): the ADR-026 geometry (native XLM SAC
  `CDLZ…CYSC`, USDC SAC `CBIE…DAMA`, lot 100,000,000 stroops, tick 1,000, band
  [1, 4,194,304), fee 5 bps, 1 to 1,000,000 lots); `level_cap` at its default
  of 64. The `level` view reads back `depth` 0 on an empty tick. The decoded
  `Market(0)` entry has `level_cap` 64 and no `max_slots_scanned` field; it is
  480 B on the ledger, 36 B under the old contract's 516 B.
- Smoke, wind-down of `CAMH…56F4` and the fly cutover: below.

### Smoke run

30 minutes on the new contract (2026-09-10, about 15:47 to 16:19 local), a
5-level maker (`--levels 5 --base-lots 2 --step-lots 1`, pad v2) on
`pb-fly-funder-1` and the trader (pad v2) on `pb-fly-funder-2`, both topped up
by `refill.ts` (four friendbot merges into the maker, the trader already
above its floor), both running the `main` code. The watchdog at the end:
`MM OK`, maker last hour 169 ok / 58 simulation-rejected (post-only `Crossed`,
free) / 1 apply-rejected (a `replace_batch` that crossed at apply, typed
`Crossed`, no state change) / 0 bad, 15 heals, 43 fills for 127 lots; trader
39 takes for 158 lots, 8 rests, 7 settles, 0 rejected, 0 bad. No `footprint`,
`trapped:unknown` or `resource_limit` outcome on either side; the dev web
client rendered the book from the new contract with no console errors. The
smoke maker was then unquoted with `--cancel-all` (10 settles, first
`ddfaa5…24b0`, last `83e5e6…0708`), and a nonce-range scan read zero live
orders for both smoke identities.

### Wind-down and cutover

2026-09-10, about 16:22 to 16:35 local. The fly machine's stop file was set
and the maker and trader process groups were sent SIGTERM. The entrypoint's
shutdown waits on its runner loops, not on the bots, and the runners die on
the signal, so the machine exited (code 0) four seconds later, before either
bot finished its graceful exit: the maker's last `replace_batch`
(`ea1397…5d49`) landed two seconds after the signal and the trader's one
resting order stayed on the book. The machine was started once under a
`sleep` command override (no bots) to `sftp` the maker's state file (40
quotes) and stopped again.

`mm.ts --cancel-all` on `CAMH…56F4` market 0 with `pb-mm-fly`, run from the
`main` checkout (the client reads `Market` fields by name and parses the old
entry), settled 39 (first `f684e0…034a`, last `ebaff5…2c91`); the 40th read
`UnknownOrder` on a retry after an RPC fetch error. Because a kill mid-cycle
can leave orders the state file never recorded (ADR-037), both identities'
nonce ranges were then scanned with batched `getLedgerEntries`
(`.claude/skills/redeploy-testnet/scripts/scan-orders.mts`): zero live maker
orders; one trader rest (nonce `1788964312277`, bid 17852, 3 lots, 1 filled),
settled from `pb-trader-fly` (`7bd2b3…c879`). Rescans read zero live orders
for both. Escrow returned: `pb-mm-fly` 31,983 to 59,782 XLM and 67,905 to
72,837 USDC; `pb-trader-fly` 48,635 to 48,645 XLM and 11,024 to 11,033 USDC.

`collect_fees` on the old contract from `pagebook-builder-2` moved 143.57 XLM
(`764063…9bc6`) to the admin. The 23.50 USDC of accrued quote fees stay in the
old vault: the SAC transfer fails with `Error(Contract, #13)` because the fee
recipient has no USDC trustline, and adding one was outside this run's spend.
The old contract's keepalive stopped with the machine; its entries archive
after testnet's minimum TTL.

Fly cutover, 2026-09-10 20:36Z: `fly deploy` with `CONTRACT` = the new address
and `MARKET` = 0 (image `deployment-01M26GH06QCMXGJQTMVYFYWTZY`, machine
version 14) updated the stopped machine's config, cleared the `sleep`
override, and left it stopped; it was started by hand at 20:37Z. On boot the
refill crank found both reserves above their floors (59,782 XLM, 11,033
USDC), the keepalive crank saw nothing due on the new contract, one maker and
one trader process were running, and the maker (`pb-mm-fly`) started from a
fresh `/data/state/mm-<CONTRACT>-m0.json`, building its 40-quote ladder six
places per cycle while the trader (`pb-trader-fly`) took against it from the
third minute. Acceptance is the ADR-031 criterion, `MM OK` twice, 30 minutes
apart, with no `footprint` / `trapped:unknown` / `resource_limit` outcome. The
entrypoint's watchdog read `MM OK` at 20:42Z (40 live, 0 bad on either side)
and the hourly watchdog log on the volume is the record. `docs/09` still
quotes the retired `CDX3…U2RO` samples under its header note; a fresh
`ops/resources.ts` sample needs hours of production traffic in every category
and stays the follow-up.
