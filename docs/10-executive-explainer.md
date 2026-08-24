# PageBook: a good-enough Soroban order book

This document assumes familiarity with order books, SDEX, and basic Soroban concepts. Examples use the USDC/XLM market, with prices expressed in USDC per XLM.

## Why does Soroban need an order book?

- People like order books. Why is a separate topic.
- Stellar already has a native order book: SDEX.
- Soroban contracts cannot call SDEX operations, and SDEX cannot call contracts.
- SDEX offers are backed by refundable base reserves rather than Soroban's resource metering and state rent. They can remain on-ledger indefinitely.
- SDEX has no mechanism for sending a configurable trading fee to a market operator.


## Why is a Soroban order book not trivial?

Several Soroban constraints shape the design. Two dominate:

- A transaction's read/write set, or footprint, must be declared before execution. A naive one-entry-per-order design makes the matching footprint depend on the live queue. A Soroban order book needs predictable keys and footprints that clients can safely pad.
- Ledger resources are metered and capped. Write bytes are especially scarce, so a Soroban order book needs small entries and bounded writes on the matching path.

Two more set hard ceilings:

- Each transaction may touch a bounded number of ledger entries. A single SDEX crossing can walk through a thousand offers — roughly two thousand ledger entries — in one operation; no Soroban transaction can. Matching must do more per entry, which is why levels aggregate orders instead of storing one entry each.
- Each ledger entry has a maximum size, so entries cannot simply grow to aggregate more. Every PageBook entry type carries an explicit byte budget, enforced by tests.

## "Good enough" concessions

PageBook does not reproduce SDEX behavior exactly. It accepts the following tradeoffs:

- **Price quantization**
  - SDEX: rational prices with no market configuration.
  - PageBook: admin-configured lot size, tick size, and tick range.
  - USDC/XLM example: one lot is 10 XLM and one tick is `0.00001 USDC/XLM`. Tick `15,800` is `0.15800 USDC/XLM`, so one lot costs `1.58 USDC`.
  - Quantization is what makes matching exact. A tick fixes an exact per-lot price, so every matched amount is an integer multiplication: `25` lots at tick `15,800` is exactly `25 × 1.58 = 39.50 USDC`. Matching contains no division and nothing to round. The only division anywhere is the taker fee, which rounds up; that dust accrues to fees.

- **Maker settlement**
  - SDEX: both sides are credited during execution.
  - PageBook: the taker settles during execution; makers claim later.

- **Best-price timing**
  - SDEX: matches against the best offer at apply time.
  - PageBook: starts from the best price seen during simulation. Better offers added before inclusion are not visible to that transaction.

- **Footprint construction**
  - Typical Soroban invocation: submit the footprint returned by simulation.
  - PageBook: pad the simulated footprint with a tick band and queue page windows.

- **Per-market throughput**
  - Soroban executes non-conflicting transactions in parallel.
  - PageBook: every settling transaction on a market touches shared book state and the vault's token balances, so activity on one market serializes. A market's throughput is what one ledger's serial resources allow, not what parallelism could add. This is a smaller loss than it sounds: PageBook is IO-bound, not compute-bound — the heaviest sampled sweep used under 8% of the instruction cap — so the write-byte ceiling binds a market well before serialized execution does.


## PageBook design

PageBook is a Soroban contract for on-chain order storage, matching, and settlement.

Book state is split by function:

- **Tick index:** finds price levels with available supply.
- **Level queue:** stores FIFO supply at each tick.
- **Order record:** points a maker to its queue position for later settlement.

Storage keys are derived from client-known coordinates. Queue entries are small and packed. This keeps footprints predictable and write bytes low.

### Tick Index

Each market side has a bitmap of active price levels. Bit `T[i] = 1` means tick `i` may have resting supply. Matching uses it to find the next candidate tick without scanning every price.

#### Implementation

PageBook stores the index in two levels. The summary identifies non-empty tick words; each tick word identifies active ticks in its range.

The implementation uses 2,048-bit words and a 2,048-bit summary, covering `2^22`, or 4,194,304, ticks per market side. Each bitmap has a 257-byte packed payload.

The index is derived state. A live level must have its bit set, but a set bit may point to an empty level. Matching verifies the level and clears stale bits lazily.

### Level Queue

Each active tick has one FIFO queue per market side.

- Each slot stores the quantity of one maker order in lots.
- New maker orders append at the tail.
- Takers consume from the head.
- The queue stores quantities only. Maker identity and settlement data live in the order record.

At tick `15,800`, every slot trades at `0.15800 USDC/XLM`. A slot containing `25` represents `25` lots, or `250 XLM`. A taker consumes older slots before newer ones at the same price.

#### Implementation

The FIFO never moves data. It uses fixed-size quantity vectors and advances head and tail coordinates through them.

Each queue is split across two packed entry types:

- `Level` stores queue counters, total open lots, and the first 32 quantity slots in a 285-byte payload.
- `LevelPage` adds 32 quantity slots in a 257-byte payload when the inline slots are full.

Together they give each level a hard capacity of `64` resting orders. A rest against a full level fails with a typed error rather than degrading the queue. `LevelPage` is declared in footprints but written only when an order actually spills past the inline slots; on a thin level it is never touched.

The capacity limit is also the flood defense. Every slot costs real escrowed funds at the market's minimum order size, plus metered rent on the order record — and the rent, unlike an SDEX base reserve, is spent rather than refunded. A flooded level also clears cheaply: consuming all `64` orders is one `Level` sweep for any taker who wants the price.

Each quantity is written to one slot. Filled slots remain as history; cancelled slots become tombstones. Neither is moved or compacted.

`open_lots` tracks aggregate supply at the level. A taker that consumes the whole level can price and sweep it with one `Level` write, without reading each maker slot. Partial consumption walks slots from the head under a fixed scan limit.

`Level` entries are never deleted; the same fixed slots are reused queue lifetime after queue lifetime, like a ring buffer whose cycle is one generation. Whenever the level empties — a taker sweeps it, or the last resting order is cancelled — the generation increments, sequence numbers restart, and all `64` slots are available again. The generation preserves settlement correctness for makers from the previous queue: an order from an older generation settles as fully filled, never confused with the new occupants of its slot.

### Order Record

The level queue is optimized for matching and stores no maker identity. Each resting order therefore has a separate `Order` record owned by the maker.

- The maker chooses a nonce as the order handle.
- The record stores side, tick, queue generation, sequence number, and original quantity.
- The record does not change when takers fill the order.

For example, a maker selling `25` lots at tick `15,800` has an order for `250 XLM` at `0.15800 USDC/XLM`. If fully filled, the claim is worth `39.50 USDC`.

#### Implementation

The maker chooses the order handle before simulation. The queue position is assigned during execution and stored inside the record. Concurrent orders can change that position without changing the transaction footprint.

PageBook supports point lookup by nonce, not enumeration of a maker's orders. The maker's client or indexer tracks active nonces off-chain from `rested` and `settled` events. This avoids an on-chain maker index and its write cost.

Matching updates the shared level queue but never writes maker order records or maker balances. This keeps maker-specific entries out of the taker's footprint.

When the maker calls `settle`, PageBook compares the order's generation and sequence number with the level's counters:

- An order from an older generation, or behind the current head, is fully filled.
- An order at the head may be partially filled.
- An order ahead of the head is still open.

PageBook pays the filled amount, refunds any open amount, and deletes the order record. Settlement requires constant work regardless of how many other makers are in the queue.

### The Taker Walk

A taker walks the opposite side of the book from the best available tick toward its limit. A bid walks asks upward; an ask walks bids downward.

Suppose the USDC/XLM ask side contains:

- `20` lots at tick `15,800`, or `0.15800 USDC/XLM`
- `30` lots at tick `15,805`, or `0.15805 USDC/XLM`

A taker bids for `35` lots with a limit of tick `15,805`:

1. The tick index points to tick `15,800`.
2. The level has `20` open lots, less than the taker's remaining quantity. PageBook sweeps the whole level for `31.60 USDC`, resets its queue generation, and clears its tick bit.
3. The tick index finds the next ask at tick `15,805`.
4. The taker needs `15` more lots, so PageBook consumes them from the head of that level queue for `23.7075 USDC`.
5. The taker receives `350 XLM` before fees and spends `55.3075 USDC`. At the example market's 5 bps taker fee, the net output is `349.825 XLM`.
6. Maker order records are untouched. Makers later use them to claim the proceeds recorded by the updated level counters.

#### Implementation

The client simulates the take to get its starting tick and expected queue positions, then pads the footprint with a tick band and queue page windows.

During execution, the walk alternates between the tick index and level queues. A full-level sweep uses `open_lots` and does not read individual slots. Partial consumption reads from the queue head under a fixed slot limit.

The consequence is the design's central scaling property: taker cost grows with levels crossed, not orders crossed. Sweeping a level is one `Level` write whether the level holds one maker or sixty-four. At current defaults — `32` levels crossed per invocation, `64` orders per level — a single `place` can clear up to `2,048` resting orders. The flip side is that write bytes still grow with each level crossed, and the padded footprint declares them before execution, so a deep sweep reserves meaningful ledger write capacity even when most of it goes unused.

The walk stops when it fills the requested quantity, reaches the limit price, hits a configured work limit, or reaches the edge of a declared queue window. Depending on the order flags, any remainder rests at the limit price or is refunded. Walking beyond the padded tick band is the remaining footprint failure case.

Liquidity added at a better price after simulation is outside this walk. Covered changes inside the padded range are handled at execution without adding maker-specific entries to the footprint.

### Results

The following ranges come from 30 landed transactions per invocation type on protocol 27 testnet. Resources are declared after footprint padding. persistent-state rent is separate.

- **Rest a maker quote:** `16` read/write entries, `4.8-4.9M` instructions, `7.2-7.8 KB` of declared writes, and `0.010-0.014 XLM` charged.
- **Update quotes:** one `replace` declared `16-17` read/write entries and cost `0.0072-0.0077 XLM`. A batch of `6-8` replacements declared `41-54` read/write entries and cost `0.019-0.024 XLM`.
- **Take liquidity:** crossing `2-3` active levels declared `35-65` read/write entries, `8.3-12.9M` instructions, and `17-35 KB` of writes. It cost `0.014-0.026 XLM`. The heaviest sampled six-level sweep used `126` total footprint entries, `30.9M` instructions, about `69 KB` of writes, and cost `0.051 XLM`.
- **Settle a maker order:** `11-12` read/write entries, about `5M` instructions, `5.0-5.4 KB` of writes, and `0.0051-0.0054 XLM` charged. Settlement cost does not grow with queue depth.

Creating a persistent `Order` adds about `0.046 XLM` of rent for the 120-day minimum TTL. A new price level may also create or restore level and bitmap entries. `replace` reuses the existing order record, so normal quote updates do not pay that order rent again.

For meaningful takes, write bytes and read/write entries constrain the transaction before compute does. The heaviest sampled sweep used about half of the write-byte cap but less than 8% of the instruction cap. Full measurements are in the [resource-utilization report](09-resource-utilization.md).
