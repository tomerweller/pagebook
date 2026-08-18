# Worst-case state-transition matrix

M4 resource gates are built from this document. Every row is read off the
contract as it stands (`matching.rs`, `rest.rs`, `settle.rs`, `replace.rs`,
`bitmap.rs`, `store.rs`, `market.rs`, `admin.rs`, `views.rs`), not from a
sampled book. Architecture §17 is compared at the end and is not edited here.

Host `write_bytes` includes LedgerKey / LedgerEntry framing on top of the
payload sizes below. The formulas use payload bytes; the in-repo gates use
`env.cost_estimate().resources()`, which is the number that hits the per-tx
132 KB write-byte cap.

## Entry sizes

Budgets are `crates/pagebook-types/src/constants.rs`. Measured XDR sizes are
ADR-017 / ADR-022 at max occupancy.

| Entry | Durability | Budget | Measured XDR |
|---|---|---|---|
| Level | persistent | 384 | 296 |
| LevelPage | persistent | 320 | 268 |
| TickWord, TickSummary | persistent | 268 | 268 |
| BestTick | persistent | 60 | 56 |
| Order | persistent | 160 | 132 |
| FeeAccrual | persistent | 50 | 48 |
| Market | persistent | 500 | 488 |
| Config | instance | 200 | 188 |

SAC balance entries (vault and caller, per token that actually moves) and SAC
instance entries sit outside PageBook's `DataKey` enum. `create_market` also
reads each token's SAC instance for `authorized(vault)`. `keepalive` and every
admin op extend the PageBook instance and code TTLs; a native test contract
does not model wasm, so those two show up as zero writes in-repo.

`L` is `MAX_LEVELS_CROSSED` (32). `S` is `MAX_SLOTS_SCANNED` (64). `D` is the
number of distinct opposite-side `TickWord`s whose bits change. A page window
is the inclusive `PageRange` the client declared for consume or append.

## Shared place mechanics

Every `place` (and every `route` leg) does the same three things.

1. Preamble: read instance `Config` (pause), read `Market`, read
   `BestTick(opposite)`.
2. Walk (`matching.rs`). Starting at `worse_of(recorded best, start_tick)`,
   the walk loads each opposite `Level` it visits, up to `L`. A sweep writes
   that `Level` (generation bump, counters zeroed) and `clear_tick`s its bit.
   A partial consumes inside the declared page window and the shared slot
   budget `S` and writes the `Level` only: taking never writes a `LevelPage`
   (slots behind the head are history; only `rest` and a settle tombstone
   write pages). `clear_tick` / `set_tick` are idempotent: a
   `TickWord` is written only when a bit changes, and `TickSummary` only when
   a word flips between empty and non-empty. After the last sweep the walk
   may load `TickSummary` and stand on the next summary-set word; it never
   reads a `TickWord` past `word(limit_tick)`. `BestTick(opposite)` is written
   only when the walk began at the recorded best and the recorded value
   changed.
3. Optional rest (`rest.rs`) of the remainder at `limit_tick` on the taker's
   side: load `Order` (must be absent unless `replace` is reusing it), load
   and write `Level`, `set_tick` if the level was empty, maybe write
   `BestTick(own)`. Then write `Order`.
4. Netting (`settle.rs`): one SAC `transfer` per direction per token. A bid
   pays in quote at the limit (caller and vault quote balances) and pays out
   base net of fee (caller and vault base balances). `FeeAccrual` for the
   output token is written when the fee is nonzero.

`quote_place` is the same walk in `DryRun`: nothing is written. The returned
key set includes every opposite `Level` visited, every `TickWord` from
`word(start_tick)` to `word(limit_tick)`, both summaries, both bests, the
own-side rest `Level` and its word, and both `FeeAccrual`s.

## Per entry point

### place, rest only, existing level

Opposite side empty or not crossing. Walk may still read `TickWord(opp)` and
`TickSummary(opp)` on the empty-side probe; it does not write them. Rest
appends into a live `Level`, so the own-side bit is already set and
`BestTick(own)` does not move.

Reads: `Config`, `Market`, `BestTick(opp)`, `TickWord(opp)`, `TickSummary(opp)`,
`Order` (absent), `Level(own)`, `BestTick(own)`, caller and vault SAC balances
for the escrow token.

Writes: `Level(own)`, `Order` (create), caller SAC balance, vault SAC balance.

Write bytes (payload): 296 + 132 + 2 × SAC balance.

In-repo (harness, one existing ask, second rest at the same tick): 13 memory
reads, 5 writes, 1,200 write bytes.

### place, rest only, new level

Same walk. Rest finds `open_lots == 0`, so `set_tick` writes `TickWord(own)`
and, if that word was empty, `TickSummary(own)`. `BestTick(own)` is written
when the side was empty or the new tick is better.

Reads: as above, plus `TickWord(own)` and `TickSummary(own)`.

Writes: `Level(own)`, `TickWord(own)`, `TickSummary(own)`, `BestTick(own)`,
`Order` (create), caller SAC balance, vault SAC balance.

Write bytes (payload): 296 + 268 + 268 + 56 + 132 + 2 × SAC balance.

In-repo (first rest on an empty book): 15 memory reads, 8 writes, 2,104 write
bytes.

### place, take only, N levels swept

Each swept level is one `Level` write and one `clear_tick`. `D` distinct
words whose last set bit is cleared also rewrite `TickSummary` (one entry,
rewritten up to `D` times). `BestTick(opp)` moves. `FeeAccrual` is written.
No `LevelPage`: a sweep never reads slots.

Reads: `Config`, `Market`, `BestTick(opp)`, `N` × `Level`, `D` × `TickWord`
(plus the current word on each `next_set_tick`), `TickSummary`,
`FeeAccrual`, SAC balances for both tokens.

Writes: `N` × `Level` + `D` × `TickWord` + `[TickSummary if a word emptied]` +
`[BestTick if it moved]` + `[FeeAccrual if fee > 0]` + up to 4 SAC balances
(pay-in and pay-out, two tokens).

Write bytes (payload): `N` × 296 + `D` × 268 + 268 + 56 + 48 + SAC.

Same-word shape (`D = 1`, the existing 8-level gate, ticks 10 to 17): 22
memory reads, 17 writes, 5,288 write bytes.

Worst dispersal (`N = D = L = 32`, ticks `2048·w + 5` for `w` in 0 to 31,
`tick_max = 65,536`, walk budget 32): 77 memory reads, 72 writes, 26,640
write bytes. `quote_place` returns 32 opposite `TickWord` keys, one per word
from `word(start)` to `word(limit)`.

### place, take N levels then rest the remainder

The take set plus a new-level rest on the taker's side: one more `Level`,
`Order`, and (if the rest tick's word was empty) own-side `TickWord` /
`TickSummary` / `BestTick`. The rest escrow stays in the vault, so the
pay-in token still writes both balances; the unspent refund may be zero.

In-repo (8 same-word asks of 1 lot, bid of 10 lots at a worse tick): 27
memory reads, 22 writes, 6,872 write bytes.

### settle

Reads `Market`, `Order`, `Level`. Writes `Level` when the settled seq is the
head (advance, maybe one `LevelPage` inside the declared page) or a later
seq (tombstone that slot, which writes a `LevelPage` if the seq is not
inline). Deletes `Order`. Pays proceeds and refund, one SAC transfer per
token that is nonzero.

Two disjoint worst cases: the head row (`Level`, `Order` delete, up to 4 SAC
balances when both proceeds and refund move; no page write, the head advance only
reads) and the tombstone row (`Level`, one `LevelPage` if the seq is paged,
`Order` delete, 2 SAC balances). Plus the auth nonce entry (below).

In-repo (unfilled ask): 9 memory reads, 5 writes, 924 write bytes.

### replace

`settle` without deleting `Order`, then `rest` with `reuse_order`. Conservative
post-only check reads `BestTick(opposite)` and does not walk. Escrow pay-in
is the full new size; old proceeds and refund flow out.

Writes: old `Level` (and its `LevelPage` if the old seq is paged and the row is
a tombstone; settle never clears a bit, so no old `TickWord`) + new `Level` (and
maybe `TickWord` / `TickSummary` / `BestTick` if the new tick was empty) +
`Order` rewrite + SAC balances. Same-tick
replace collapses the two `Level` writes into one entry.

In-repo (ask at 10, replace to 12): 13 memory reads, 7 writes, 1,980 write
bytes.

### replace_batch

One auth, one pause check, one `Market` load, then `replace_body` per item
with netted transfers. Duplicate nonces fail `OrderExists`. Ceiling is
`MAX_REPLACE_BATCH` (64).

Per item at a distinct new tick: old `Level` + new `Level` + `Order`, plus
any index entries that actually change. Shared across the batch: `TickSummary`
and `BestTick` (one each per side that moves), and at most two SAC tokens.

Formula, distinct old and new ticks, no page writes:
`3 × items + D_new + [summaries] + [bests] + SAC + 1 (auth nonce)`, where
`D_new` is the number of distinct new words touched (a settle clears no bits,
so there is no old-word term).

In-repo, 5 items (ticks 11 to 15 rest, replace to 21 to 25): 25 memory reads,
19 writes, 6,316 write bytes.

In-repo, 40 items (the §17 "full refresh" shape, each quote moved to a new
tick): 130 memory reads, 124 writes, 44,256 write bytes.

### route

One auth, one pause check, one shared `(L, S)` budget equal to the minimum of
every leg market's caps, fixed before the first leg. Each leg is `place_body`.
Transfers flush once. A later leg that would take an earlier leg's rest fails
`SelfTrade`. The take side of the ceiling is one maximal place (the budget is
shared); each leg still runs its own preamble and may rest, so up to
`MAX_ROUTE_LEGS` rest sets (`Order`, own `Level`, `TickWord`, `TickSummary`,
`BestTick`: about 5 writes and 1.6 KB each) come on top, plus a `Market` read
per extra leg and extra `FeeAccrual` / SAC tokens if the legs do not share
assets.

In-repo, two no-rest legs sweeping 4 + 4 same-word levels: 22 memory reads,
17 writes, 5,288 write bytes (same as the 8-level take).

### create_market

`require_admin` (reads `Config`, extends instance and code TTLs), reads both
SAC instances for `authorized(vault)`, writes `Config` (counter) and the new
`Market`.

Writes: `Config`, `Market`, and (on wasm) instance + code TTL. Native test
host: 9 memory reads, 3 writes, 976 write bytes.

### set_market_caps

`require_admin`, read and write `Market`.

Native test host: 5 memory reads, 2 writes, 652 write bytes.

### collect_fees

Reads `Config`, `Market`, `FeeAccrual`. Writes `FeeAccrual` to zero. One SAC
transfer, vault to fee recipient.

In-repo (nonzero accrual): 6 memory reads, 3 writes, 632 write bytes.

### keepalive

Extends instance and code TTLs to `max_ttl`. No persistent PageBook key is
written.

Native test host: 2 memory reads, 0 writes, 0 write bytes.

### quote_place

Reads `Market`, `BestTick(opp)`, the walk's `Level`s and `TickWord`s, the
opposite `TickSummary` when the scan crosses a word, the own-side `Level` at
`limit_tick`. Writes nothing.

### views (`best`, `level`, `order`)

`best` reads `BestTick`. `level` reads `Level`. `order` reads `Order` and
`Level`. Writes nothing.

## Comparison with architecture §17

§17 footprint table (targets, packed encoding, including SAC):

| Op | §17 footprint | §17 writes | §17 write bytes | Measured reads / writes / bytes | Verdict |
|---|---|---|---|---|---|
| place, rest only (existing level) | ~12 | ~5 | ~0.9 KB | 13 / 5 / 1,200 | writes hold; footprint slightly low; bytes low |
| place, rest only (new level) | ~14 | ~7 | ~1.2 KB | 15 / 8 / 2,104 | writes low (8, not 7); bytes low |
| settle | ~9 | ~3 to 4 | ~0.6 KB | 9 / 5 / 924 | writes low (5, not 3 to 4); bytes low |
| replace (one quote) | ~14 | ~8 | ~1.5 KB | 13 / 7 / 1,980 | writes hold (loose); bytes low |
| replace_batch (40-quote refresh) | ~130 | ~90 | ~24 KB | 130 / 124 / 44,256 | footprint holds; writes and bytes low |
| place, take only, 8 levels | ~55 | ~21 | ~6 KB | 22 / 17 / 5,288 (same word) | loose on footprint (assumes a padded band, not recorded reads); writes hold; bytes hold for this shape |
| place, maximal take (32 levels, 32 words) | ~85 + pad | ~70 | ~22 KB | 77 / 72 / 26,640 | writes low (72, not 70); bytes low (26.6 KB, not 22) |

§17's max-sweep arithmetic used the Level *budget* (384 B) times 32, plus 32
TickWords, plus separate lumps for the summary and for best, fees, vaults and a
possible own-side rest. That is 22 KB of *payload*. The host meters each write
as the full ledger entry (payload + key + about 56 B of framing): Level 404 B,
TickWord 376, TickSummary 372, BestTick 156, FeeAccrual 184, SAC balance 224,
and the authorization nonce (a temporary entry every call whose authorizer is
not the transaction source writes) 72. A take-only sweep writes no own-rest
entries. So: 32 × 404 + 32 × 376 + 372 + 156 + 184 + 4 × 224 + 72 = 26,640
bytes over 72 write entries (32 Levels, 32 TickWords, summary, best, fee
accrual, four SAC balances, nonce).

The 40-quote §17 row assumed about two writes per item (a same-tick refresh:
one `Level` + one `Order`). Moving each quote to a new tick writes the old
`Level`, the new `Level`, and the `Order` (three per item) and lands at 124
writes / 44 KB.

Rows §17 does not list, measured in-repo: take 8 + rest 27 / 22 / 6,872;
`create_market` 9 / 3 / 976; `set_market_caps` 5 / 2 / 652; `collect_fees`
6 / 3 / 632; `keepalive` 2 / 0 / 0; `quote_place` and the views write
nothing.

## Corrections for a follow-up edit of §17

Applied to `docs/04-architecture.md` §17 in ADR-024's follow-up commit; kept
here as the derivation. Every authenticated call also writes one temporary
authorization-nonce entry (+1 write, ~72 B, plus temporary rent), which §17 now
notes once instead of per row.

1. Rest, existing level: write bytes ~1.2 KB, not 0.9 KB. Footprint ~13, not 12.
2. Rest, new level: ~8 writes / ~2.1 KB, not 7 / 1.2 KB. The write set is
   `Level`, `TickWord`, `TickSummary`, `BestTick`, `Order`, two SAC balances, and
   the auth nonce entry.
3. Settle: ~5 writes / ~0.9 KB, not 3 to 4 / 0.6 KB: `Level`, `Order` delete,
   two SAC balances, and the auth nonce entry.
4. Replace: write bytes ~2.0 KB, not 1.5 KB. Writes ~7, which is inside the
   ~8 target.
5. `replace_batch` of 40 quotes that each change tick: ~124 writes / ~44 KB,
   not 90 / 24 KB. A same-tick qty-only refresh is closer to the old row.
6. Max sweep, 32 levels in 32 words: ~72 writes / ~26 KB, not 70 / 22 KB.
   Recast the arithmetic as `32 × Level + 32 × TickWord + TickSummary +
   BestTick + FeeAccrual + SAC` using measured sizes plus framing, not the
   Level budget and a 1.2 KB lump. Drop "own-rest entries" from a take-only
   row.
7. The 8-level take row is a same-word shape in the gates (~17 writes /
   ~5.3 KB). A 8-word dispersal would add 7 TickWord writes. Say so, or add
   that row.
8. Add the missing public entry points: `route` (ceiling = one maximal place
   + per-leg constants), `create_market`, `set_market_caps`, `collect_fees`,
   `keepalive`, `quote_place`, `best` / `level` / `order`.

## Fee-gate calibration

`env.cost_estimate().fee()` uses a hard-coded Stellar mainnet snapshot from
2026-07-10 (`soroban-sdk` 27.0.6, `CostEstimate::fee`):

| Rate | Snapshot value |
|---|---|
| `fee_per_instruction_increment` | 7 stroops per 10,000 instructions |
| `fee_per_write_entry` | 2,500 |
| `fee_per_write_1kb` | 875 |
| `fee_per_contract_event_1kb` | 5,000 |
| `fee_per_transaction_size_1kb` | 406 |
| `fee_per_historical_1kb` | 4,059 |
| persistent rent denominator | 1,215 |
| `fee_per_rent_1kb` | 12,000 (deliberately inflated) |

§17 prices rent at the protocol floor of 1,000 stroops per KB, which is about
1,667 stroops per byte per 120-day minimum TTL. The in-repo gates rescale the
SDK rent component by `1,000 / 12,000` before comparing it to a named §17
rent figure.

A native test contract does not model wasm instantiation or wasm reads. The
instruction component is therefore a lower bound. Tx-size fees are also
missing from `InvocationResources` (the SDK says so).

`total − persistent_entry_rent` is not the §17 non-rent figure. The snapshot
still charges disk-read fees on live writes (P23 live-state reads are free)
and the test host bills a flat 2,194,209 stroops of `temporary_entry_rent` on
every authenticated call. The gates compare the execution slice §17 actually
prices: instructions + write-entry fees + write-byte fees + events. The test
host's persistent TTL is not the 120-day minimum, so rescaled
`persistent_entry_rent` is far below a mainnet create; the rent assertion
still runs.

Measured components, stroops (SDK snapshot 2026-07-10). `exec` is the
execution slice. `rent*` is persistent rent rescaled by 1,000/12,000.

| Op | instr | write entries | write bytes | events | exec | rent* | §17 row | exec vs §17 |
|---|---|---|---|---|---|---|---|---|
| place, rest existing | 281 | 12,500 | 1,026 | 1,993 | 15,800 | 1,120 | 290,000 | holds (row is rent) |
| place, rest new | 329 | 20,000 | 1,798 | 2,559 | 24,686 | 6,272 | 940,000 | holds (row is rent) |
| settle | 215 | 12,500 | 790 | 1,954 | 15,459 | 0 | 20,000 | holds |
| replace | 445 | 17,500 | 1,692 | 3,946 | 23,583 | 1,541 | 30,000 | holds |
| replace_batch 40 | 18,428 | 310,000 | 37,817 | 67,930 | 434,175 | 61,658 | 300,000 | over (inside 1.5×) |
| place, take 8 | 1,320 | 42,500 | 4,519 | 13,711 | 62,050 | 94,362 | 90,000 | holds |
| place, take 8 + rest | 1,513 | 55,000 | 5,873 | 15,118 | 77,504 | 100,634 | 370,000 | holds (row is rent) |
| place, max take 32 | 10,465 | 180,000 | 22,764 | 42,774 | 256,003 | 94,362 | 270,000 | holds |
| create_market | 161 | 7,500 | 834 | 0 | 8,495 | 2,120 | 850,000 | holds (row is rent) |
| collect_fees | 192 | 7,500 | 541 | 1,153 | 9,386 | 93,545 | 10,000 | holds |

Authenticated calls also meter `temporary_entry_rent = 2,194,209` and a
disk-read fee of `1,563 × (disk_read_entries + write_entries)`. Those are
printed by the test and are not in the `exec` column.

Fee-table correction for the follow-up: `replace_batch` of 40 tick-changing
quotes is about 0.043 XLM of execution, not 0.03, because the write set is
124 entries rather than 90. The 1.5× gate still passes (450,000 stroops).
