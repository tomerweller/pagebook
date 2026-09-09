# 036: Level, LevelPage and the bitmaps as named ScVals; testnet redeploy

Date: 2026-09-09. Removes the last hand-packed storage layouts (ADR-015 /
ADR-017, narrowed by ADR-022) and redeploys testnet, since the encoding change
is a new layout and the contract has no upgrade path (ADR-023).

## Decision

- `Level` and `LevelPage` are `#[contracttype]` structs. Their `slots` field
  is a `Vec<u64>` sized to occupancy: `slots.len() == min(tail_seq,
  INLINE_SLOTS)` inline, the reached prefix of each page. A sweep or
  empty-level reset empties the inline vec; the first append of a generation
  into a page starts that page from an empty vec. A slot the vec does not hold
  reads as zero.
- `TickWord` / `TickSummary` are `BytesN<256>`. The leading version byte is
  gone, and with it `PACKED_VERSION`, the encode/decode pairs, the length
  checks, and the `CorruptEntry` decode paths (the SDK's typed conversion is
  the guard now; a foreign shape fails to convert). `CorruptEntry` survives
  only for the `Market` geometry check.
- Budgets are the measured named sizes: `Level` 600 B (572 measured),
  `LevelPage` 450 (424), bitmaps 264 (264).
- The web client parses `Level` entries through `scValToNative`; the
  cross-language hex fixtures that pinned the byte layout are deleted.
- Pad byte model: the flat per-key write-byte cover (`WRITE_BYTES_PER`) rises
  600 → 720 so a full `Level` (680 B on ledger) is covered under pad v1;
  `DEFAULT_GROWTH` 32 → 48 B so three in-flight appends by other makers into a
  padded `Level` (12 B each) stay covered; the trader moves to pad v2.
- Testnet: a new deployment carrying one market, XLM/USDC as market 0. The
  `CDX3…U2RO` deployment (markets 0 PBA/PBB and 1 XLM/USDC) is wound down.

## Measured sizes (SDK XDR encoder)

| Entry | Packed (before) | Named (now) | Full ledger entry now |
|---|---|---|---|
| `Level`, empty | 296 | 188 | 296 |
| `Level`, one order | 296 | 200 | 308 |
| `Level`, 32 orders | 296 | 572 | 680 |
| `LevelPage`, 32 slots | 268 | 424 | 532 |
| `TickWord` / `TickSummary` | 268 | 264 | 372 / 368 |

The map encoding costs about 150 B of field names plus 12 B per slot. A level
is written full only when 32 orders rest at one price; a swept level is written
empty. So the hot-path writes got smaller and the ceiling moved to deep levels:

| Shape (in-repo gate) | Before | Now |
|---|---|---|
| place, rest at existing level | 1,200 B | 1,116 B |
| place, rest on an empty side (five entries created) | 2,104 | 2,000 |
| settle | 924 | 828 |
| replace, one quote to a new tick | 1,980 | 1,784 |
| place, take 8 levels | 5,288 | 4,416 |
| place, maximal take (32 levels, 32 words) | 26,640 | 23,052 |
| replace_batch 40, same ticks | 27,700 | 23,880 |
| replace_batch 40, fresh ticks | 44,256 | 36,572 |
| place, the 32nd rest at a price (full `Level`) | 1,200 | 1,476 |
| replace_batch 40 onto 31-deep levels | ≈44,000 | 51,080 |

Rent per created entry at the 1,000/KB floor over 120 days: a `Level` is
created by a first rest at 308 B (~0.051 XLM, was 0.067) and grows 12 B
(~0.002 XLM) per further order, paid by the rest that grows it, to ~0.113 XLM
at 32. A rest to a fresh tick costs ~0.099 XLM (was 0.115); a fresh-tick
40-quote batch ~2.1 XLM (was 2.7).

Instructions: a full-level rewrite costs about 180k more host instructions than
a one-slot one (713k vs 426k for a rest, native test host); a 32-deep sweep
1.45M. A 40-item batch onto deep levels is roughly 35 to 40M on the network,
well inside the 100M cap. The SDK test host itself meters storage size, not
footprint size: with ~1,300 orders seeded, the same batch reads as 117M and
`footprint_of`'s storage snapshot trips the 400M per-transaction cap, so the
deep-batch gate lifts the budget and asserts bytes only.

## Why

Simplicity. The packed layouts existed to hold `Level` under a 384 B budget
inherited from a table of hot entries. Measured, the budget was the wrong
lever: what the hot path rewrites is sparse and swept levels, and those are
smaller as occupancy-sized vectors than they were packed. What got bigger is
a rewrite of a deep level, and that is gated and priced explicitly now. In
exchange the contract loses ~150 lines of encode/decode, its length and
version checks, and the web client loses a byte-layout decoder and the
fixtures that pinned it across languages. The version byte's remaining job
after ADR-023 (a decode guard) is done by the SDK's typed conversion, which is
how every other named entry already behaved.

## Cutover record

- Admin / fee recipient: `pagebook-builder-2`,
  `GB2JQQZB4K2R6UTQYN7OQHZQ72LGAQ3UQOVQ6ZEE42U5D64LJDST5SLK` (friendbot-funded;
  kept in the repo's `.stellar/` keychain next to the fly bot identities).
- Wasm hash `ba787bf32c232db0db7fa4f37234d041c0480e636360b3a10e55afcf7a787550`
  (33,165 B, +180 B over the packed build). Upload tx `936962…c3bb`, deploy tx
  `7bbdbe…32a8`.
- Contract `CB6I37Y57URALZR2KWJNAYTR64LST3OXODBQUFBQKE76YTSBKJ4TDAZB`.
- Market 0 (tx `449e49…7520`): base native XLM SAC `CDLZ…CYSC`, quote USDC SAC
  `CBIE…DAMA`, lot 100,000,000 stroops, tick 1,000, band [1, 4,194,304), fee
  5 bps, 1 to 1,000,000 lots — ADR-026's geometry, one id lower.
- Smoke on the new contract before touching production identities: a 5-level
  maker on `pb-fly-funder-1` (pad v2) and the trader on `pb-fly-funder-2` (pad
  v2), both funded by `refill.ts`. Results below.
- Old deployment wind-down and fly cutover: below.

### Smoke run

_(filled in as the run completes)_

### Wind-down and cutover

_(filled in as the steps land)_

## What changed

- `crates/pagebook-types`: `packed.rs` → `bitmap.rs` (bit ops only); `Level`,
  `LevelPage` in `entries.rs` with `slot` / `set_slot` / `clear_slots`;
  constants `PACKED_VERSION`, `LEVEL_BYTES`, `LEVEL_PAGE_BYTES`,
  `TICK_BITMAP_BYTES`, `LEVEL_HEADER_BYTES` removed; budgets updated.
- `contracts/pagebook`: `store.rs` and `bitmap.rs` load and save the types
  directly; `level.rs` writes slots positionally with the page-start rule.
  Tests: `sizes.rs` pins the empty, one-slot and full sizes; `property.rs`
  asserts the occupancy invariant after every op; `pages.rs` covers page
  truncation; `worst_case.rs` recalibrates and adds the deep-level shapes and
  the same-tick refresh; `footprint.rs` and `fee_gates.rs` gates re-measured.
- `clients/web`: `decode.ts` (`parseLevel`, 256-byte bitmaps), `book.ts`,
  `decode.test.ts`; `fixtures.json` deleted; `txdata.ts` byte model;
  `trader.ts` pad v2; `MARKET` env in `fly.toml`, `fly-entrypoint.sh`,
  `docker-compose.yml`; scratch tooling (`market0.ts`,
  `docker-compose.scratch.yml`) marked retired; default contract and READMEs.
- Docs: architecture Part I intro, §2, §5, §9, §10, §17, §20; 05 module tree
  and encoding decisions; 08 sizes, formulas, in-repo numbers, fee table; 09
  header note; README; both explainer pages.
