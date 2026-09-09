# 037: Drop `LevelPage`; a level's queue is one vector

Date: 2026-09-08, on top of ADR-036. A new storage layout and interface, and
therefore a testnet redeploy (ADR-023).

## Decision

- `LevelPage` goes. `Level.slots` holds every slot of the current generation:
  `slots.len() == tail_seq`. Slot `s` is at index `s`. A sweep or empty-level
  reset empties the vector.
- `LEVEL_CAP` stops being geometry. `Market.inline_slots`, `page_slots` and
  `max_pages` are replaced by one field, `level_cap` (default 64, raise-only
  through `set_market_caps`, ceiling `LEVEL_CAP_MAX = 128`). The §0.3 proof
  (`level_cap × max_order_lots` in u64, the i128 escrow bound, and
  `MAX_REPLACE_BATCH ≤ level_cap`) runs at creation and on every raise, as
  `max_pages` did.
- Slot windows go with the pages: `SlotWindow`, `ConsumeWindow`, `PageRange`,
  the `window` argument of `place`, `replace`, `route` legs and `replace_batch`
  items, the errors `RetryRest` and `BadWindow`, and the client's consume and
  append page machinery (`pagesForEmpty`, `settlePageKeys`, `appendRange`,
  `pushPages`, the conformance fixture's page cases).
- Two `Level` counters go with the pages. `tail_seq` is `slots.len()`, since
  appends push and both resets empty the vector. `head_consumed_lots` folds
  into the head slot: a partial take decrements the slot in place, a slot at
  zero is skipped whether a cancel or consumption put it there, and settle of
  the head order reads its slot from the `Level` it already loaded (filled is
  `Order.qty_lots` minus the slot, refund is the slot). `Level` is
  `generation, head_seq, open_lots, slots`. `QuoteResult.tail_seq` and
  `CrossedLevel.head_seq`, which only fed the windows, go too.
- `INLINE_SLOTS`, `PAGE_SLOTS`, `MAX_PAGES`, `page()`, `is_inline()`,
  `slot_in_page()`, `level_cap()`, `BUDGET_LEVEL_PAGE` and the
  `DataKey::LevelPage` variant are removed. `BUDGET_LEVEL` becomes 1,000 B
  (892 at the default cap of 64 slots, from 956 measured with the two counters
  still present). The `Market` geometry check and with it the last
  `CorruptEntry` path go too.

## Why

Pages were a byte cap: with a fixed-layout `Level` (ADR-017) every level cost
its full size on every write, so the queue was split into 32-slot entries and
the protocol grew windows to say which of them a transaction may touch. ADR-036
made `Level` occupancy-sized, which removed the reason. Measured with the SDK
XDR encoder and the in-repo footprint helper, the same queue in one vector is
smaller on the ledger than the split one at every depth past 32, and the
split's remaining job, bounding how many keys a deep queue drags into a
footprint, is done better by having one key.

Sizes (payload; on-ledger adds 108 B to a `Level`, 120 B to a `LevelPage`,
whose key is one field longer):

| Shape | Payload | On ledger |
|---|---|---|
| `Level`, 32 slots (the current maximum) | 572 | 680 |
| `Level`, 33 slots | 584 | 692 |
| `Level`, 48 slots | 764 | 872 |
| `Level`, 64 slots (single vector at cap, counters still present) | 956 | 1,064 |
| `Level` 32 + `LevelPage` 32 (paged at cap) | 572 + 424 | 680 + 544 = 1,224 |
| `Level`, 128 slots (`LEVEL_CAP_MAX`, counters still present) | 1,724 | 1,832 |

Measured write bytes at cap depth (63 orders resting, then the operation), both
geometries built and run in-repo before the two counters were dropped:

| Shape at a 64-deep level | Paged (now) | Single vector |
|---|---|---|
| the 64th rest | 6 writes, 2,020 B | 5 writes, 1,860 B |
| settle of a mid-queue order | 6 writes, 1,744 B | 5 writes, 1,584 B |
| replace_batch 8 onto 63-deep levels | 35 writes, 14,984 B | 27 writes, 13,704 B |
| replace_batch 40 onto 63-deep levels (from the 8-item slope) | 163 writes, 72,840 B | 123 writes, 66,440 B |

Below 32 orders nothing changes: a rest, a settle, a sweep and every §17 row
that does not touch a page writes the same bytes as today (the 32nd rest 1,476,
the maximal sweep 23,052, the 40-quote refresh 23,880, the fresh-tick batch
36,572, the batch onto 31-deep levels 51,080). The write-byte ceiling row
becomes the batch onto 63-deep levels: 66,440 B, 50% of the 132,096 B per-tx
cap and 23% of a ledger (4 per ledger). The paged design's ceiling at the same
depth is 72,840 B and 163 writes; §17 has been quoting the 32-deep figure
because no gate exercised page depth. At `LEVEL_CAP_MAX` 128 the same batch is
97,160 B, 74% of the per-tx cap; 256 would not fit, which fixes the ceiling.

The two counters. In the map encoding a field costs its symbol name plus its
value: `tail_seq` (u32, 8-character name) is 24 B, `head_consumed_lots` (u64,
18-character name) 40 B; this model reproduces the measured 188 B empty
`Level` to the byte. Dropping both takes 64 B off every `Level` write. The
in-repo gates, re-measured after the change (`tests/footprint.rs`,
`tests/worst_case.rs`), against the ADR-036 numbers:

| Op | Writes | ADR-036 | Now |
|---|---|---|---|
| `Level`, empty / 1 / 32 / 64 / 128 slots, payload | | 188 / 200 / 572 / 956 / 1,724 | 124 / 136 / 508 / 892 / 1,660 |
| `Level`, 64 slots, on ledger | | 1,064 | 1,000 |
| place, rest at an existing level | 5 | 1,116 | 1,052 |
| place, rest on an empty side (five entries created) | 8 | 2,000 | 1,936 |
| place, the 64th rest at a price | 5 | 2,020 (6 writes, with a page) | 1,796 |
| settle | 5 | 828 | 764 |
| replace, one quote to a new tick | 7 | 1,784 | 1,656 |
| replace_batch 40, same ticks (the refresh) | 83 | 23,880 | 21,320 |
| replace_batch 40, fresh ticks | 124 | 36,572 | 31,452 |
| replace_batch 40, each onto a 63-deep level | 123 | 72,840 (163 writes, with pages) | 61,320 (1,520 B per item, from an 8-item run) |
| place, take 8 levels | 17 | 4,416 | 3,904 |
| place, take 8 levels + rest | 22 | 5,896 | 5,320 |
| place, maximal take (32 levels in 32 words) | 72 | 23,052 | 21,004 |
| route, 2 legs, 8 levels | 17 | 4,416 | 3,904 |
| create_market | 3 | 1,000 | 920 |
| set_market_caps | 2 | 652 | 596 |

Every row that writes one `Level` lost exactly 64 B, the batch rows 64 B per
`Level` written, and `Market` lost 56 B with its three geometry fields
replaced by `level_cap`. The write-byte ceiling is the batch onto levels at
cap, 61,320 B: 46% of the 132,096 B per-tx cap and 21% of a ledger (four
per ledger). The 40-item deep shape is measured on 8 items and extrapolated,
since 40 items at this depth seed about 2,500 orders and the SDK test host's
storage-scaled meter trips (the ADR-036 note); the per-item slope matched the
closed form to the byte.

The fold changes what a slot means, from the order's original quantity to its
open quantity, which touches `consume_partial`, `preview_settle`, the `order`
view and the property suite's reference model. Invariant 2 loses its
subtraction: `open_lots == Σ slots[head_seq..]`. `open_lots` itself could be
derived the same way but stays: the sweep path and the stale-bit check on
every crossed level read it without summing, and summing 64 slots at each of
32 levels is real instruction cost against a 32 B field.

Where the cap could go. Three bounds, far apart:

| Bound | Source | Slots per level |
|---|---|---|
| one ledger entry | `contract_data_entry_size_bytes` = 65,536 on mainnet (`stellar network settings`, 2026-09-08; now in 03) | about 5,400 |
| per-tx write bytes, a lone `Level` write | 132,096 B | about 10,900, never the binder |
| the heaviest legal shape | `MAX_REPLACE_BATCH` items each rewriting a level at cap: 40 × (232 + 12 × cap) + 21,320 ≤ 132,096 | 211 |

A `Level` is 124 B plus 12 B per slot in payload, plus 108 B of key and
framing on the ledger; nothing else on the entry gets in the way (reads are
free, instructions scale at a few thousand per slot against a 400M cap, the
u64 `open_lots` bound is a market-parameter check). `LEVEL_CAP_MAX = 128`
leaves the batch shape at 70% of the per-tx cap (92,040 B) and a full-level
decode on the scale of `MAX_SLOTS_SCANNED`. Past 211 the batch shape breaks
and depth would have to be bought by lowering `MAX_REPLACE_BATCH`.

Footprint keys. Every page key a pad declares is read-write and counts against
the 200 read-write entries per transaction whether or not it exists. Per the
§14 rule that goes: two per crossed set level, two for the taker's own rest,
one per settle, three per fresh-tick replace item. A maximal 32-level take over
a 120-tick band drops from about 196 read-write keys to about 132; the heal
ADR-026 lost to the 200 cap (120 band levels plus page keys for 31 phantom
levels) needs no `pagesForEmpty` workaround; a 40-item dispersed batch
declared by the §14 rule would be over the cap today (120 page keys) and is 151
keys, all existing, without them.

Rent. A level with 64 orders is one 1,000 B entry (~0.167 XLM per 120 days)
instead of 1,224 B across two (~0.204); a level created by a first rest is
244 B (~0.041 XLM, was 308 B and ~0.051). The 33rd order at a price grows the
level by 12 B (~0.002 XLM) instead of creating a 172 B page (~0.029 XLM).

Reads. A taker at a deep level reads the whole vector. Live-state read bytes
are free post-P23 (03 §Fees); the host cost is instructions, on the order of
200k for a full-level decode and re-encode (extrapolated from the 180k ADR-036
measured at 32 slots), about 0.000014 XLM at 7 stroops per 10k, and
instructions do not bind this workload (ADR-027). A partial
take, the one level a walk does not sweep, rewrites up to 1,064 B instead of
680: at most 384 B more per take.

Invariant 9 collapses. With one vector that a sweep and the empty-level reset
both empty, `slots.len() == tail_seq` at all times and no slot can exist under a
live key past the tail. The stale-slot rule, the page-start truncation in
`write_slot`, the gap fill in `slot_set` and the "at most one `LevelPage` per
settle" rule have nothing left to govern. §7's stranded-head paragraph keeps
only its scan-cap clause (a tombstone run longer than `max_slots_scanned` still
strands the head for the next take to clear).

The intermediate option, keeping the types and setting `MAX_PAGES = 0`, was
rejected: `set_market_caps` is raise-only on `max_pages`, so the live market
cannot reach 0, and `create_market` copies the constant, so a new market needs
a contract change and a redeploy anyway; clients would still have to learn to
stop declaring page keys; the cap would halve to 32; and every line above would
stay as dead code.

Costs accepted. Pad v1's flat per-key cover (`WRITE_BYTES_PER` 720) does not
cover a `Level` past 35 orders; it rises to 1,100 for markets at the default
cap, or pad v1 is retired for pads in favor of the existence-aware v2 the
trader and maker already run. Because `level_cap` is raise-only up to 128, the
flat rate is not a constant of the protocol anymore: the client derives it
from the market's `level_cap` (1,100 at the default 64, plus 12 B per slot
above it), so a raised market keeps its flat cover sound instead of failing on
the one-entry write-byte shortfall. Relatedly, `BUDGET_LEVEL` (1,000 B) is the
entry budget at the DEFAULT cap only; max occupancy is `LEVEL_CAP_MAX`, gated
separately by `BUDGET_LEVEL_MAX` (1,750 B, measured 1,660) so the entry-size
ground rule still binds at the true maximum. A redeploy: the ADR-036 cutover
procedure applies unchanged. `MAX_SLOTS_SCANNED` (64) stays a separate market
cap; a market raised to 128 slots scans a deep level over two takes, as today.

## What changed

- `crates/pagebook-types`: `LevelPage` and the page helpers removed; `Level`
  loses `tail_seq` and `head_consumed_lots` and gains `tail()` (the vector's
  length); `Level::set_slot` appends or overwrites, `clear_slots` stays;
  `Market` gets
  `level_cap`; `LEVEL_CAP` 64, `LEVEL_CAP_MAX` 128; budgets as above.
- `contracts/pagebook`: `level.rs` loses `write_slot`'s page branch,
  `head_in_window`, the window argument of `append` and `advance_head`;
  `iface.rs` loses the window types and `validate_window`; `matching.rs`,
  `rest.rs`, `replace.rs`, `settle.rs`, `lib.rs` and `route` drop the window
  plumbing; `consume_partial` and `advance_head` decrement and test the head
  slot instead of `head_consumed_lots`; `preview_settle` reads the head slot;
  `LevelInfo` reports `depth` (the vector length) and drops
  `head_consumed_lots`; `QuoteResult` drops `tail_seq`, `CrossedLevel` drops
  `head_seq`; `store.rs` loses `load_page` / `save_page` and the geometry check;
  `market.rs` proves `level_cap`; `errors.rs` retires `RetryRest`, `BadWindow`,
  `CorruptEntry`. The wasm is 29,760 B, down from ADR-036's 33,165. Tests: `pages.rs` becomes a depth suite (33rd to 64th rest,
  `LevelFull` at `level_cap`, tombstones and settles past 32, reset-on-rest at
  depth); `padding.rs` drops the window races and keeps the band races;
  `sizes.rs` pins 0, 1, 32, 64 and 128 slots (124, 136, 508, 892, 1,660) and
  the `LEVEL_CAP_MAX` batch bound; `worst_case.rs` gates the 64th rest
  (1,796) and the batch onto 63-deep levels (12,680 for 8 items, extrapolated
  to 61,320 for 40, since 40 trips the test host's storage-scaled meter, as
  ADR-036 notes); `footprint.rs` and `fee_gates.rs` recalibrated.
- `crates/pagebook-client` and `clients/web`: `pad`, `keysForSettle`,
  `keysForReplace`, `restoreMarks`, `windowJson`, `restKeys`,
  `settlePageKeys`, the `pagesForEmpty` option and its plumbing in `submit.ts`,
  `mm.ts`, `trader.ts`, `soak.ts`, `stress.ts`; `clientKeys.ts` drops the
  `LevelPage` key; `errors.ts` drops code 12 and 19; the conformance fixture
  loses `page_boundaries`, `empty_pages_true`, `empty_pages_false` and
  `mixed_empty_skip`; `txdata.ts` cover as above.
- Docs: architecture §2 (one entry, `level_cap`, the counters paragraph), §7
  (settlement rows read the head slot; stranded head), §9
  (`RetryRest`), §12 (`set_market_caps` signature), §14 (no windows), §15, §17
  (the rows above), §18, §19 (invariant 2 without the subtraction, invariant
  7's constant list, invariant 9 reduced to the vector being the queue); 05
  module tree and encoding decisions; 06
  (`level_cap` replaces `MAX_PAGES` in the frozen-unless-re-proved row;
  `INLINE_SLOTS` / `PAGE_SLOTS` leave the frozen row); 08 formulas; README and
  both explainer pages.

## Cutover record

- 2026-09-09. Same admin and identities as ADR-036: `pagebook-builder-2`
  (`GB2JQQZB…5SLK`) deploys and administers; `pb-mm-fly` and `pb-trader-fly`
  run the bots; `pb-fly-funder-1` / `-2` are the smoke identities.
- Wasm hash `572d959e2d135694e2f7c38cfafcfaf317e70ac207f01fd20f646e8cee9651a7`
  (29,859 B), built from `main` at `9421a47` (CI green, 135 contract tests
  and 220 web tests passing locally). Deploy tx `89269b…8d6b`.
- Contract `CAMHFJ32KHIJJIKCE35SRL37JES4QAWLFVLEAYCWVJGP2NZHU47F56F4`.
- Market 0 (tx `f3123f…dfaf8`): the ADR-026 geometry (native XLM SAC
  `CDLZ…CYSC`, USDC SAC `CBIE…DAMA`, lot 100,000,000 stroops, tick 1,000, band
  [1, 4,194,304), fee 5 bps, 1 to 1,000,000 lots); `level_cap` at its default
  of 64. The `level` view reads back `depth` 0 on an empty tick.
- Smoke, wind-down of `CB6I…DAZB` and the fly cutover: below.

### Smoke run

30 minutes on the new contract (2026-09-09, about 13:20 to 13:50 local), a
5-level maker (`--levels 5 --base-lots 2 --step-lots 1`, pad v2) on
`pb-fly-funder-1` and the trader (pad v2, 15 to 40 s between takes) on
`pb-fly-funder-2`, both running the `main` code. The watchdog at the end:
`MM OK`, maker last hour 185 ok / 32 simulation-rejected (post-only `Crossed`,
free) / 0 apply-rejected / 0 bad, 16 heals, 71 fills for 193 lots; trader 61
takes for 271 lots, 5 rests, 4 settles, 0 rejected, 0 bad. No `footprint`,
`trapped:unknown` or `resource_limit` outcome on either side; the `main` web
client rendered the book from the single-vector `Level` entries with no
console errors. The smoke maker was then unquoted with `--cancel-all`.
