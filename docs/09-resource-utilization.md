# Resource utilization per invocation, measured on testnet


Every number in this document comes from a landed transaction on the live
XLM/USDC market (market 1 on
`CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO`, testnet,
protocol 27): 30 sampled transactions per category out of the market maker's
and the trader's continuous traffic (ADR-026), pulled from the RPC by
`tools/mm/resources.py`. For each transaction it records two sides:

- **declared**: what the client signed after simulation plus the section 14
  pad, from the transaction envelope: the read-only and read-write footprint
  entry counts, the instruction, write-byte and disk-read-byte limits, and
  the resource fee. This is what capacity the transaction reserves.
- **metered**: what the host actually counted while applying it, from the
  `core_metrics` diagnostic events: cpu instructions, ledger entries read and
  written, bytes read and written, host memory, wall time. This is what the
  work truly cost. The fee charged is from the transaction result; the
  difference against the declared fee is refunded at apply.

The gap between the two columns is the price of the padding protocol: the
footprint declares every key the book could touch however it moves between
simulation and apply, so the declared side scales with the *possible* book
and the metered side with the *actual* one.

Context, the protocol 27 per-transaction ceilings (docs/03): 400 footprint
entries, 200 read-write entries, 400M instructions, 132,096 write bytes. The
heaviest transaction sampled here (a 6-level sweep: 126 entries, 30.9M
declared instructions, 70 KB declared writes) uses under a third of the
entry caps, 8 percent of the instruction cap, and half the write bytes; the
constraint that binds first at this market's geometry is write bytes, then
read-write entries, exactly as section 17 predicts.

Two systematic observations before the tables:

- **Declared vs metered instructions.** Declared is roughly 1.5 to 2 times
  metered. That is the pad's doing: simulation is exact, and the client adds
  20 percent plus 120k instructions per padded key plus a flat 1M (ADR-026;
  the host charges about 100k instructions per footprint entry whether or
  not the entry exists).
- **Disk reads are almost zero.** Metered disk reads are a constant 260
  bytes in every category: the caller's classic trustline. All Soroban state
  lives in memory under protocol 27, so reads of levels, orders, words and
  balances cost no disk at all; the declared disk-read budget exists for the
  padded classic entries.

Fees are in stroops (1 XLM = 10,000,000 stroops); at these numbers the whole
range is 0.005 to 0.051 XLM per transaction, rent excluded (these
transactions create at most one new entry; ADR-024 measures rent).

## Summary: the range per invocation (min to max over 30 samples)


| invocation | RW entries declared | entries written | instructions declared (M) | instructions metered (M) | write KB declared | write KB metered | fee charged (stroops) |
|---|---:|---:|---:|---:|---:|---:|---:|
| place, post-only rest (maker quote) | 16 to 16 | 12 to 12 | 4.8 to 4.9 | 3.0 to 3.2 | 7.2 to 7.8 | 3.1 to 3.1 | 100,138 to 142,501 |
| place, rest inside the spread (band pad) | 19 to 19 | 16 to 17 | 6.1 to 6.1 | 3.3 to 3.3 | 9.1 to 9.2 | 4.2 to 4.6 | 112,132 to 154,175 |
| place, take crossing 0 to 1 levels | 21 to 33 | 16 to 28 | 6.4 to 8.0 | 3.1 to 4.4 | 9.4 to 17.1 | 4.3 to 9.0 | 90,092 to 136,617 |
| place, take crossing 2 to 3 levels | 35 to 65 | 17 to 56 | 8.3 to 12.9 | 4.1 to 8.8 | 17.4 to 34.8 | 4.7 to 20.1 | 143,506 to 260,577 |
| place, take crossing 4 to 6 levels | 39 to 123 | 28 to 56 | 9.9 to 30.9 | 5.6 to 20.6 | 19.8 to 68.8 | 9.0 to 20.1 | 162,776 to 510,180 |
| place, 1-lot walk over 1 to 8 empty levels | 19 to 76 | 16 to 71 | 6.2 to 15.3 | 3.0 to 10.3 | 9.7 to 41.6 | 4.3 to 26.0 | 83,582 to 301,582 |
| place, 1-lot walk over 9 to 32 empty levels | 29 to 84 | 26 to 79 | 10.2 to 24.6 | 5.6 to 15.4 | 15.3 to 46.3 | 8.3 to 29.2 | 130,792 to 336,000 |
| replace, one quote | 16 to 17 | 14 to 15 | 6.0 to 6.4 | 3.4 to 3.5 | 6.6 to 8.4 | 3.5 to 3.9 | 72,047 to 76,794 |
| replace_batch, 6 to 8 quotes | 41 to 54 | 29 to 38 | 14.3 to 19.0 | 9.2 to 12.6 | 18.1 to 24.1 | 8.5 to 12.0 | 188,272 to 243,414 |
| settle | 11 to 12 | 8 to 9 | 4.8 to 5.0 | 2.5 to 2.6 | 5.0 to 5.4 | 1.8 to 2.1 | 50,702 to 53,945 |

## Detail per invocation

### place, post-only rest (maker quote)

No walk: own-side keys, the order, both tokens, both fee accruals. Book-independent.

| metric | min | median | p95 | max |
|---|---:|---:|---:|---:|
| footprint entries, read-only (declared) | 3 | 3 | 3 | 3 |
| footprint entries, read-write (declared) | 16 | 16 | 16 | 16 |
| entries read (metered) | 19 | 19 | 19 | 19 |
| entries written (metered) | 12 | 12 | 12 | 12 |
| instructions (declared) | 4,835,051 | 4,835,231 | 4,878,363 | 4,936,797 |
| instructions (metered) | 3,010,407 | 3,010,551 | 3,038,628 | 3,180,398 |
| write bytes (declared) | 7,356 | 8,028 | 8,028 | 8,028 |
| write bytes (metered) | 3,172 | 3,172 | 3,172 | 3,172 |
| disk read bytes (declared) | 3,744 | 4,544 | 4,544 | 4,544 |
| disk read bytes (metered) | 260 | 260 | 260 | 260 |
| resource fee (declared, stroops) | 154,030 | 218,963 | 219,597 | 219,597 |
| fee charged (stroops) | 100,138 | 142,243 | 142,501 | 142,501 |
| host memory (bytes, metered) | 1,856,606 | 1,856,606 | 1,863,696 | 1,881,798 |
| host invoke time (ns) | 574,752 | 676,268 | 891,687 | 995,990 |

### place, rest inside the spread (band pad)

A place whose walk starts and immediately rests; the pad carries a 1-tick band from quote_place.

| metric | min | median | p95 | max |
|---|---:|---:|---:|---:|
| footprint entries, read-only (declared) | 3 | 3 | 3 | 3 |
| footprint entries, read-write (declared) | 19 | 19 | 19 | 19 |
| entries read (metered) | 22 | 22 | 22 | 22 |
| entries written (metered) | 16 | 17 | 17 | 17 |
| instructions (declared) | 6,093,966 | 6,147,522 | 6,147,761 | 6,147,761 |
| instructions (metered) | 3,276,351 | 3,318,426 | 3,323,777 | 3,325,641 |
| write bytes (declared) | 9,356 | 9,356 | 9,384 | 9,384 |
| write bytes (metered) | 4,288 | 4,692 | 4,692 | 4,692 |
| disk read bytes (declared) | 5,316 | 5,316 | 5,344 | 5,344 |
| disk read bytes (metered) | 260 | 260 | 260 | 260 |
| resource fee (declared, stroops) | 174,281 | 174,918 | 209,281 | 237,397 |
| fee charged (stroops) | 112,132 | 112,394 | 135,374 | 154,175 |
| host memory (bytes, metered) | 1,965,070 | 1,983,185 | 1,984,539 | 1,984,539 |
| host invoke time (ns) | 618,979 | 696,869 | 1,195,009 | 11,461,998 |

### place, take crossing 0 to 1 levels

Crossing at the touch; band pad spans up to ~12 ticks.

| metric | min | median | p95 | max |
|---|---:|---:|---:|---:|
| footprint entries, read-only (declared) | 3 | 3 | 3 | 3 |
| footprint entries, read-write (declared) | 21 | 21 | 21 | 33 |
| entries read (metered) | 24 | 24 | 24 | 36 |
| entries written (metered) | 16 | 16 | 16 | 28 |
| instructions (declared) | 6,389,119 | 6,406,498 | 6,584,169 | 8,014,421 |
| instructions (metered) | 3,122,280 | 3,360,440 | 3,551,819 | 4,385,461 |
| write bytes (declared) | 9,628 | 10,684 | 11,100 | 17,496 |
| write bytes (metered) | 4,412 | 4,412 | 4,412 | 9,260 |
| disk read bytes (declared) | 5,460 | 6,588 | 6,944 | 11,060 |
| disk read bytes (metered) | 260 | 260 | 260 | 260 |
| resource fee (declared, stroops) | 145,073 | 145,123 | 146,210 | 215,249 |
| fee charged (stroops) | 90,092 | 91,633 | 92,423 | 136,617 |
| host memory (bytes, metered) | 1,978,904 | 1,993,345 | 2,020,605 | 2,329,359 |
| host invoke time (ns) | 595,834 | 764,512 | 1,014,452 | 1,236,159 |

### place, take crossing 2 to 3 levels

Sweeping about two levels; the band pad spans 20 to 40 ticks (one Level key per tick).

| metric | min | median | p95 | max |
|---|---:|---:|---:|---:|
| footprint entries, read-only (declared) | 3 | 3 | 3 | 3 |
| footprint entries, read-write (declared) | 35 | 37 | 64 | 65 |
| entries read (metered) | 38 | 40 | 67 | 68 |
| entries written (metered) | 17 | 28 | 45 | 56 |
| instructions (declared) | 8,315,620 | 8,948,956 | 12,158,717 | 12,880,415 |
| instructions (metered) | 4,128,755 | 5,036,106 | 7,424,640 | 8,797,517 |
| write bytes (declared) | 17,832 | 19,032 | 35,184 | 35,636 |
| write bytes (metered) | 4,816 | 9,260 | 16,027 | 20,572 |
| disk read bytes (declared) | 10,660 | 11,460 | 22,080 | 22,260 |
| disk read bytes (metered) | 260 | 260 | 260 | 260 |
| resource fee (declared, stroops) | 223,893 | 237,253 | 390,527 | 399,448 |
| fee charged (stroops) | 143,506 | 152,140 | 253,031 | 260,577 |
| host memory (bytes, metered) | 2,173,562 | 2,389,444 | 3,001,734 | 3,309,191 |
| host invoke time (ns) | 902,825 | 1,303,738 | 2,337,052 | 2,941,918 |

### place, take crossing 4 to 6 levels

Deep sweep, 4 to 6 real levels; band pad up to ~40 ticks plus consume windows.

| metric | min | median | p95 | max |
|---|---:|---:|---:|---:|
| footprint entries, read-only (declared) | 3 | 3 | 3 | 3 |
| footprint entries, read-write (declared) | 39 | 57 | 113 | 123 |
| entries read (metered) | 42 | 60 | 116 | 126 |
| entries written (metered) | 28 | 28 | 56 | 56 |
| instructions (declared) | 9,863,916 | 15,076,584 | 27,715,855 | 30,890,750 |
| instructions (metered) | 5,560,866 | 8,631,128 | 19,072,082 | 20,576,849 |
| write bytes (declared) | 20,232 | 31,130 | 63,952 | 70,436 |
| write bytes (metered) | 9,260 | 9,260 | 20,572 | 20,572 |
| disk read bytes (declared) | 12,260 | 19,660 | 40,720 | 45,460 |
| disk read bytes (metered) | 260 | 260 | 260 | 260 |
| resource fee (declared, stroops) | 253,506 | 375,210 | 720,780 | 792,139 |
| fee charged (stroops) | 162,776 | 240,038 | 465,479 | 510,180 |
| host memory (bytes, metered) | 2,448,118 | 2,756,668 | 4,419,174 | 4,680,612 |
| host invoke time (ns) | 1,464,985 | 2,798,013 | 6,804,881 | 7,215,067 |

### place, 1-lot walk over 1 to 8 empty levels

The maker's index-healing take: a walk that clears stale bits over emptied levels and rewrites the words.

| metric | min | median | p95 | max |
|---|---:|---:|---:|---:|
| footprint entries, read-only (declared) | 3 | 3 | 3 | 3 |
| footprint entries, read-write (declared) | 19 | 28 | 63 | 76 |
| entries read (metered) | 22 | 32 | 66 | 79 |
| entries written (metered) | 16 | 24 | 58 | 71 |
| instructions (declared) | 6,150,127 | 8,164,120 | 13,188,895 | 15,312,376 |
| instructions (metered) | 3,004,383 | 4,543,246 | 8,482,854 | 10,279,779 |
| write bytes (declared) | 9,900 | 14,550 | 35,098 | 42,628 |
| write bytes (metered) | 4,412 | 7,644 | 21,562 | 26,632 |
| disk read bytes (declared) | 6,144 | 8,988 | 22,440 | 27,460 |
| disk read bytes (metered) | 260 | 260 | 260 | 260 |
| resource fee (declared, stroops) | 133,746 | 191,780 | 395,379 | 469,712 |
| fee charged (stroops) | 83,582 | 121,106 | 254,131 | 301,582 |
| host memory (bytes, metered) | 1,956,247 | 2,234,802 | 3,280,283 | 3,673,381 |
| host invoke time (ns) | 566,628 | 1,284,890 | 2,667,060 | 3,501,469 |

### place, 1-lot walk over 9 to 32 empty levels

The same walk over a long phantom trail (up to 32 levels, band chunked at 150 ticks).

| metric | min | median | p95 | max |
|---|---:|---:|---:|---:|
| footprint entries, read-only (declared) | 3 | 3 | 3 | 3 |
| footprint entries, read-write (declared) | 29 | 48 | 77 | 84 |
| entries read (metered) | 32 | 51 | 80 | 87 |
| entries written (metered) | 26 | 45 | 73 | 79 |
| instructions (declared) | 10,176,472 | 14,826,404 | 22,064,122 | 24,626,362 |
| instructions (metered) | 5,617,088 | 8,860,156 | 12,761,973 | 15,356,112 |
| write bytes (declared) | 15,628 | 27,286 | 43,788 | 47,428 |
| write bytes (metered) | 8,452 | 16,128 | 27,339 | 29,864 |
| disk read bytes (declared) | 9,460 | 17,730 | 28,455 | 30,660 |
| disk read bytes (metered) | 260 | 260 | 260 | 260 |
| resource fee (declared, stroops) | 208,218 | 348,067 | 506,504 | 523,765 |
| fee charged (stroops) | 130,792 | 219,642 | 321,385 | 336,000 |
| host memory (bytes, metered) | 2,310,646 | 3,008,928 | 3,888,682 | 4,017,399 |
| host invoke time (ns) | 1,470,834 | 2,560,194 | 4,604,408 | 4,796,362 |

### replace, one quote

Settles the old order and rests the new one in place; no walk, no band.

| metric | min | median | p95 | max |
|---|---:|---:|---:|---:|
| footprint entries, read-only (declared) | 3 | 3 | 3 | 4 |
| footprint entries, read-write (declared) | 16 | 17 | 17 | 17 |
| entries read (metered) | 20 | 20 | 20 | 20 |
| entries written (metered) | 14 | 15 | 15 | 15 |
| instructions (declared) | 6,049,088 | 6,380,944 | 6,446,536 | 6,446,536 |
| instructions (metered) | 3,371,560 | 3,445,562 | 3,528,312 | 3,528,780 |
| write bytes (declared) | 6,724 | 8,530 | 8,628 | 8,628 |
| write bytes (metered) | 3,540 | 3,944 | 3,944 | 3,944 |
| disk read bytes (declared) | 3,460 | 4,730 | 4,916 | 4,916 |
| disk read bytes (metered) | 260 | 260 | 260 | 260 |
| resource fee (declared, stroops) | 114,523 | 121,918 | 123,228 | 123,228 |
| fee charged (stroops) | 72,047 | 76,545 | 76,794 | 76,794 |
| host memory (bytes, metered) | 1,974,625 | 1,976,614 | 1,989,847 | 1,989,847 |
| host invoke time (ns) | 685,314 | 768,363 | 1,074,000 | 1,241,456 |

### replace_batch, 6 to 8 quotes

Six to eight replaces, netting settled atomically, one transfer per token.

| metric | min | median | p95 | max |
|---|---:|---:|---:|---:|
| footprint entries, read-only (declared) | 3 | 3 | 5 | 7 |
| footprint entries, read-write (declared) | 41 | 52 | 53 | 54 |
| entries read (metered) | 47 | 55 | 57 | 57 |
| entries written (metered) | 29 | 36 | 37 | 38 |
| instructions (declared) | 14,334,618 | 17,939,826 | 18,653,139 | 19,022,923 |
| instructions (metered) | 9,160,715 | 11,754,855 | 12,290,904 | 12,567,737 |
| write bytes (declared) | 18,556 | 24,384 | 24,672 | 24,672 |
| write bytes (metered) | 8,732 | 11,560 | 11,904 | 12,308 |
| disk read bytes (declared) | 7,860 | 10,516 | 10,544 | 10,660 |
| disk read bytes (metered) | 260 | 260 | 260 | 260 |
| resource fee (declared, stroops) | 279,180 | 342,094 | 352,434 | 355,373 |
| fee charged (stroops) | 188,272 | 233,721 | 240,114 | 243,414 |
| host memory (bytes, metered) | 2,844,662 | 3,121,417 | 3,244,198 | 3,281,375 |
| host invoke time (ns) | 2,716,015 | 3,420,042 | 4,691,082 | 5,128,928 |

### settle

Deletes the order, credits proceeds and refund; the cheapest write path.

| metric | min | median | p95 | max |
|---|---:|---:|---:|---:|
| footprint entries, read-only (declared) | 3 | 4 | 4 | 4 |
| footprint entries, read-write (declared) | 11 | 11 | 12 | 12 |
| entries read (metered) | 15 | 15 | 15 | 15 |
| entries written (metered) | 8 | 8 | 9 | 9 |
| instructions (declared) | 4,754,404 | 4,796,936 | 4,982,828 | 4,984,486 |
| instructions (metered) | 2,477,608 | 2,496,549 | 2,640,383 | 2,641,711 |
| write bytes (declared) | 5,140 | 5,168 | 5,572 | 5,572 |
| write bytes (metered) | 1,796 | 1,796 | 2,200 | 2,200 |
| disk read bytes (declared) | 3,316 | 3,330 | 3,344 | 3,344 |
| disk read bytes (metered) | 260 | 260 | 260 | 260 |
| resource fee (declared, stroops) | 83,564 | 84,207 | 88,047 | 88,048 |
| fee charged (stroops) | 50,702 | 50,968 | 53,944 | 53,945 |
| host memory (bytes, metered) | 1,784,514 | 1,787,222 | 1,797,410 | 1,797,410 |
| host invoke time (ns) | 387,794 | 467,840 | 698,869 | 801,419 |

## Reading the numbers against the design

- **The maker's paths are flat.** Post-only place, replace and settle have
  essentially no variance (16, 17 and 11 declared read-write entries, every
  sample within a few percent): they never walk, so their footprint is a
  function of the arguments alone. This is the design's central promise
  (section 15) showing up as four identical columns.
- **Takes scale with levels crossed, twice over.** Each real level adds its
  Level, word and page keys to the *metered* side, and the band between the
  start tick and the limit adds one Level key per tick to the *declared*
  side. At this market's geometry (one tick = 0.6 bps) the band dominates
  the declared footprint: a 40-tick-deep take declares ~120 entries to
  write ~56.
- **Walks over empty levels write real bytes.** The 9-to-32-phantom walk
  writes up to 79 entries and 29 KB: every emptied level it passes gets its
  level entry rewritten and its word bit cleared, and the band pad around it
  is charged as written whether touched or not (finding 1, ADR-025). Lazy
  deletion is paid for by whoever walks the trail; ADR-026 records the
  maker-side mitigation and a candidate design change (replace clearing its
  own emptied level's bit).
- **Batching amortizes.** A 6-to-8-quote batch settles for 233k stroops
  median against 6 to 8 single replaces at 77k each: about half price per
  quote, one transaction instead of eight.
- **Fee refunds work as documented.** Charged is 64 to 65 percent of
  declared in every category: the declared fee buys the reserved capacity,
  the refund returns the unused part, and overpadding therefore costs
  capacity, not money (section 17).

## Utilization against the transaction and ledger limits

Two caps matter for every resource: the per-transaction limit (can this
invocation fit at all) and the per-ledger limit (how many can the network
apply per 5 seconds). Ledger admission goes by **declared** resources, so
declared utilization is what sets throughput; metered utilization shows what
the same traffic would cost under a perfectly tight footprint. Limits are the
August 2026 values in docs/03: per transaction 400 footprint entries, 200
read-write entries, 400M instructions, 132,096 write bytes; per ledger 1,000
write entries, 286,720 write bytes, 580M instructions.

Declared, worst sample per category (percent of the transaction cap, percent
of the ledger cap, and how many such transactions one ledger admits on write
bytes):

| invocation | RW entries, tx / ledger | footprint entries, tx | instructions, tx / ledger | write bytes, tx / ledger | fit per ledger |
|---|---:|---:|---:|---:|---:|
| place, post-only rest | 8% / 1.6% | 5% | 1.2% / 0.9% | 6% / 2.8% | 35 |
| place, rest inside the spread | 10% / 1.9% | 6% | 1.5% / 1.1% | 7% / 3.3% | 30 |
| take, 0 to 1 levels | 16% / 3.3% | 9% | 2.0% / 1.4% | 13% / 6.1% | 16 |
| take, 2 to 3 levels | 32% / 6.5% | 17% | 3.2% / 2.2% | 27% / 12.4% | 8 |
| take, 4 to 6 levels | 62% / 12.3% | 32% | 7.7% / 5.3% | 53% / 24.6% | 4 |
| walk over 1 to 8 empty levels | 38% / 7.6% | 20% | 3.8% / 2.6% | 32% / 14.9% | 6 |
| walk over 9 to 32 empty levels | 42% / 8.4% | 22% | 6.2% / 4.2% | 36% / 16.5% | 6 |
| replace, one quote | 8% / 1.7% | 5% | 1.6% / 1.1% | 7% / 3.0% | 33 |
| replace_batch, 6 to 8 quotes | 27% / 5.4% | 14% | 4.8% / 3.3% | 19% / 8.6% | 11 |
| settle | 6% / 1.2% | 4% | 1.2% / 0.9% | 4% / 1.9% | 51 |

Metered, worst sample per category (percent of the ledger cap; fit per
ledger if footprints were exact):

| invocation | RW entries | write bytes | instructions | fit per ledger |
|---|---:|---:|---:|---:|
| place, post-only rest | 1.2% | 1.1% | 0.6% | 90 |
| place, rest inside the spread | 1.7% | 1.6% | 0.6% | 61 |
| take, 0 to 1 levels | 2.8% | 3.2% | 0.8% | 30 |
| take, 2 to 3 levels | 5.6% | 7.2% | 1.5% | 13 |
| take, 4 to 6 levels | 5.6% | 7.2% | 3.6% | 13 |
| walk over 1 to 8 empty levels | 7.1% | 9.3% | 1.8% | 10 |
| walk over 9 to 32 empty levels | 7.9% | 10.4% | 2.7% | 9 |
| replace, one quote | 1.5% | 1.4% | 0.6% | 72 |
| replace_batch, 6 to 8 quotes | 3.8% | 4.3% | 2.2% | 23 |
| settle | 0.9% | 0.8% | 0.5% | 130 |

### Which limits are worth raising

Ranked by how soon each cap binds this workload:

1. **Ledger write bytes (286,720).** The ceiling for every category: a deep
   take reserves a quarter of a ledger, so four of them saturate the network
   while using 5 percent of its instruction budget. Doubling this cap
   doubles the whole book's throughput and nothing else comes close.
   (A natural question: since protocol 23, does cached contract data even
   count toward write limits? Reads no, writes yes. CAP-0066 exempts
   in-memory entries from read fees and disk-read limits, live reads being
   bounded only by the 400-entry footprint cap, but writes have no in-memory
   exemption: every write of live soroban state counts toward all four write
   limits, per transaction and per ledger. The live settings show the same
   split in their names: `ledger_max_disk_read_entries` against a plain
   `ledger_max_write_ledger_entries`. ADR-025 finding 2 measured the write
   side directly: a read-write key on live contract data consumes
   write-entry capacity and its 2,500-stroop fee whether or not it is
   written.)
2. **Ledger write entries (1,000).** The second binder: eight deep takes or
   thirteen batch refreshes fill it. It travels with write bytes (SLP-0004
   raised both); any write-byte increase should keep them proportional.
3. **Per-transaction write bytes (132,096).** The deepest sampled take
   declares 53 percent. This is what caps how deep a single sweep or heal
   chunk can go at fine-tick geometry; a 2x raise would let `MAX_LEVELS_CROSSED`
   sweeps carry full pads at sub-bps ticks without chunking.
4. **Not worth raising for this workload:** instructions (the worst declared
   sample uses 7.7 percent of the transaction cap and 5.3 percent of a
   ledger; SLP-0004's 400M is already generous), disk reads (metered is a
   constant 260 bytes, the caller's trustline), footprint entry count (the
   worst sample declares 32 percent of 400).
5. **One transaction cap is genuinely tight: contract events size.** The
   word-dispersed batch40 metered 16,332 of 16,384 event bytes (99.7
   percent), and a worst-case batch that improves the best on every item
   would exceed the cap and fail at apply. That is a contract-side sizing
   gap (issue #6), not a limit the network should raise for us.

The other lever is on our side, not the network's: declared write bytes run
2 to 3.4 times metered because the pad covers every set band level at full
entry size. Tightening the pad (skipping page keys for empty levels already
recovered a third), trimming the band to quoted depth, and the candidate
design change in ADR-026 (replace clearing the bit of the level it emptied,
which removes the walk-over-empties categories) all recover ledger capacity
without an SLP.

## Saturation, measured

The ranking above was then tested directly (ADR-027, `tools/stress/`): eight
accounts each firing a near-cap `replace_batch` (40 word-dispersed quotes,
191 declared read-write entries, 93,100 declared write bytes) about once per
ledger for 253 ledgers, an oversubscription of 2.6x on ledger write bytes.
The chain admitted at most **3 such transactions per ledger: 279,300
declared write bytes, 97.4 percent of the cap**, while the same ledgers sat
at 57 percent of write entries and 55 percent of instructions. The excess
queued (inclusion delay median 2 ledgers, max 6) and then fell to surge
pricing (`TxInsufficientFee` at the default inclusion fee); the charged
resource fee never moved. Small transactions (the market 1 maker and
trader) kept landing in the gaps throughout.

So the ranking holds under saturation, with one correction found by
metering the stress shape itself: the word-dispersed batch meters 151
written entries, 53 KB and 82M instructions (the same-tick batches in the
tables above are far lighter), so the pad gap on this shape is 1.74x, not
the larger multiples the light shapes show. The gap is now measured, not
open (ADR-028): the minimal accepted declaration equals the metered value
exactly, because the host meters every existing read-write entry at its
full size (LedgerEntryData plus 8 bytes of framing; nonexistent keys and
key XDR are free). Of the batch's 93,100 declared bytes, 53,380 (57%) are
that protocol floor, 24,000 (26%) are the flat 600 charged for 40
nonexistent page keys, and 15,720 (17%) are the flat rate's excess over
true entry sizes on existing keys. An existence-aware pad (`apply_pad`
with `sizes`, ADR-028) declares 54,484 for the same batch and fits 5 per
ledger instead of 3, the same bound metered-exact footprints would reach,
at the cost of a quantified in-flight race (about 0.08 XLM per lost race,
roughly 10 to 40 seconds of exposure).
