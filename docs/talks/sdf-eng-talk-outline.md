# PageBook: an order book on Soroban

SDF eng talk series, 2026-09-25. ~30 min + questions.

One-line pitch: a central limit order book that fits inside Soroban's declared
footprints, write-byte limits, and rent, by making every key predictable and every
entry small.

---

## 0. Demo

- Live web client on testnet: tomerweller.com/pagebook (in-page wallet, XLM/USDC market)
- Rest a quote, take at the touch, settle the maker; show the padded footprint of one transaction
- Point at the book, then say: everything after this slide is why that footprint looks the way it does

## 1. Why build a CLOB on Soroban

- SDEX exists, but the two worlds can't reach each other: contracts can't call SDEX ops, SDEX can't call contracts
- Contracts as makers and takers; atomic multi-market `route`; composable with the rest of Soroban
- Economics SDEX can't express: a configurable taker fee to a market operator; time-in-force (post-only, IOC, FOK)
- Also a stress test of Soroban itself: does a state-heavy, contended protocol fit the platform?

## 2. Orderbook 101

- Two sides, price levels, FIFO queue of resting orders at each level
- Maker rests, taker crosses; price-time priority
- Operations: place, cancel/replace, settle; behaviors: take, rest, sweep

## 3. Naive Implementation: SDEXish

- One ledger entry per offer, keyed by offer id, like `OfferEntry`
- Footprint must be declared before execution, but the set of offers a take crosses depends on the live queue
- Any concurrent rest/cancel changes the key set between simulation and inclusion; the take fails
- Busier market, higher failure rate; no way to over-declare unpredictable keys

## 4. Naive implementation: the monolith

- Whole book in one entry; footprint trivially predictable
- Soroban charges write bytes for the whole entry on every rewrite; every trade rewrites the book
- Ledger write-byte budget (286,720 B) is the network's throughput ceiling; a big blob eats it
- Entry size cap (64 KB) bounds the book
- Solana lets you rewrite part of a 1 MB account for flat cost; Soroban doesn't

## 5. Acceptable Concessions

- Price quantization: admin-created markets with fixed lot size, tick size, tick band; integer math, no rounding
- Async maker settlement: taker settles at apply, maker calls `settle` later (O(1) claim from counters)
- Slightly stale best: the take starts from the best seen at simulation
- Footprint padding: client declares a band of price levels around the simulated best (against Soroban convention)

## 6. Introducing Pagebook

- Two principles: keys are pure functions of client-known coordinates; entries are small and occupancy-sized
- Book state split by function: tick index (find), level queue (supply), order record (claim)
- Order store is authoritative; tick index is derived and allowed to be stale in one direction
- Everything else exists so that footprints are computable, paddable, and bounded

## 7. Tick index

- Per side: `BestTick`, `TickSummary`, `TickWord` bitmaps over 2^22 ticks
- Bit set means "may have supply"; next live tick in O(1) word ops, no scan
- Stale bits tolerated: cleared lazily by the next taker to land there

## 8. Level queue

- One `Level` entry per (market, side, tick): generation, head_seq, open_lots, slots vec
- Slot vector as long as the queue has reached; 124 B empty, +12 B per order
- Sweep = write it empty + bump generation; queue depth never adds a key to a footprint
- Matching writes O(levels crossed), never O(makers)

## 9. Order record and the taker walk

- `Order(market, owner, nonce)`: client picks the nonce, so the key is declarable before execution; queue coordinates live inside
- Settle joins Order coordinates to Level counters: filled / open / mixed, all from three numbers
- The walk: bounded by `MAX_LEVELS_CROSSED` (32); cap edges refund; only walking past `pad_end` traps
- `replace` rewrites the fixed-size `Order` in place: rent-free re-quoting

## 10. Putting it all together

- Client protocol: simulate → pad → submit
- What the pad declares: the contiguous `Level` band, words, own-side rest keys, Order, vault + own balances, fee accruals
- Every race but one degrades gracefully with a typed reason; the one trap is walking past `pad_end`
- Testnet stack today: contract, TS web client with in-page wallet, market maker + soak + stress bots, cranks

## 11. Results

- Maker paths are flat: rest 16 RW entries, replace 17, settle 11; no variance because they never walk
- Fees on XLM/USDC testnet market: quote ~0.01 XLM, settle ~0.005, 32-level max take ~0.036 XLM
- Max take uses under a third of every per-tx cap; ledger write bytes is the binding limit (4 deep takes fill a ledger)
- Saturation test: 3 near-cap batches per ledger at 97% of write bytes while instructions sat at 55%
- Pad overhead measured: declared 1.7 to 3x metered; existence-aware pad recovers most of it

## 12. Future work: better Quantization

- Linear ticks: relative tick width drifts with price (5 bps at 0.02, 0.06 bps at 1.58); band exhaustion forces a new market
- Geometric ticks fix drift but break exactness (rounding inside the maker claim)
- Significant-figure / 1-2-5 tick table: exact, constant-ish relative width, no band; what traditional venues do
- Other v2 items: per-market vault sub-accounts for parallelism, settle batching, permissionless market creation

---

## Parking lot
