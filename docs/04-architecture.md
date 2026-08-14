# PageBook architecture

*Normative design. MUST/never statements are requirements; numbers marked "target" are
tunable via config or measurement. Rationale lives in docs 01–03.*

## 0. Model

One contract hosts many **markets**. A market is a sorted token pair (SAC addresses)
plus quantization params. Each market has two **sides** (bids, asks) of price **levels**;
each level is a FIFO queue of maker orders at exactly one price. Takers cross the book
and settle atomically; makers rest, then later **claim/cancel** — one entry point that
settles whatever happened (filled → proceeds, open → refund, mixed → both).

### Quantization (exactness by construction)

- `lot_size`: base atoms per lot (u64 lots on the book).
- `tick_size`: quote atoms per (base lot) per tick.
- Price of tick `t` (u32, band-limited by market config `[tick_min, tick_max)`):
  `t × tick_size` quote atoms per base lot.
- Quote value of a fill = `qty_lots × t × tick_size` — **integer, exact**. There is no
  rounding anywhere in the matching path; Deepstate's correction-code machinery is
  unnecessary. All intermediate math in i128 (checked).

## 1. Storage schema

All keys are pure functions of static identifiers — this is the load-bearing property
(footprint paddability). Payload sizes are XDR-serialized targets at max occupancy;
enforce with tests.

| # | Entry | Durability | Key | Contents | Target size |
|---|---|---|---|---|---|
| 1 | `Market` | instance | `(mkt_id)` | base/quote SAC addrs, lot_size, tick_size, tick band, fee bps caps, `MAX_LEVELS_PER_FILL`, level inline capacity N, page capacity P | ~200 B |
| 2 | `Best(side)` | persistent | `("B", mkt, side)` | best tick (u32), empty flag | ~40 B |
| 3 | `L1(side)` | persistent | `("S", mkt, side)` | summary bitmap: bit w = "L0 word w has any set bit" (2,048 words) | 256 B |
| 4 | `L0(side, w)` | persistent | `("W", mkt, side, w)` | presence bitmap for ticks `[w·2048, (w+1)·2048)` | 256 B |
| 5 | `Level(side, tick)` | persistent | `("L", mkt, side, tick)` | `generation:u32, head_seq:u32, tail_seq:u32, head_consumed:u64, total_open:u64, orders: Vec<(seq:u32, qty:u64)>` (≤ N inline, target N=32) | ~500 B |
| 6 | `Page(side, tick, p)` | persistent | `("P", mkt, side, tick, p)` | overflow `(seq, qty)` FIFO continuation, ≤ P entries | ~500 B |
| 7 | `OrderRef(order_id)` | persistent | `("O", mkt, order_id)` | owner `Address`, side, tick, qty_lots, generation, seq | ~90 B |
| 8 | `Fees(token)` | persistent | `("F", mkt, token)` | accrued protocol fees (i128) | ~50 B |

`order_id` = packed `(side:1 | tick:u32 | generation:u32 | seq:u32)` — returned to the
maker on rest; `OrderRef` is written **once** at rest and deleted at claim. The bitmap
hierarchy covers `2048 × 2048 ≈ 4.19M` ticks per side per market — the market's tick
band MUST fit inside one L1 entry (plenty at sane tick sizes; wider-range assets choose
a coarser `tick_size` or a geometric-tick market type, out of scope for v1).

Vault: the contract holds escrow in its own SAC balances (one balance entry per token —
part of every settling footprint). Bids escrow quote (`qty × t × tick_size`); asks
escrow base (`qty × lot_size`).

## 2. Level accounting (the core mechanism)

A level is FIFO by `seq` (assigned per level-generation, contiguous). Three counters
carry all fill history:

- `generation` — increments each time the level is swept **empty** by matching; the
  queue resets (seqs restart at 0).
- `head_seq` — first seq not yet fully filled (within current generation).
- `head_consumed` — lots already consumed from the head order.

**Claim logic** for `order = (side, tick, generation g, seq s, qty q)` against
`Level(side, tick)` with state `(G, H, C)`:

| Condition | Status | Settlement |
|---|---|---|
| `g < G` | fully filled | pay `q` at tick price |
| `g == G`, `s < H` | fully filled | pay `q` at tick price |
| `g == G`, `s == H` | partially filled `C` | pay `C` at tick price; refund `q − C`; remove head, advance `H`, reset `C` |
| `g == G`, `s > H` | open | refund `q`; zero its queue slot (tombstone) |

Then delete `OrderRef`, emit event. O(1), ~3 writes. Because every fill at a level
happens at exactly the tick price, *when* the fill happened is irrelevant — counters are
a complete proof. This re-derives Deepstate's "absent from tree ⇒ fully filled" claim
at stable keys, and is the direct replacement for Phoenix seats / DeepBook settled-owed
ledgers with **zero maker-related writes during matching**.

Tombstones (`qty = 0` from mid-queue cancels) are skipped when matching advances the
head. `total_open` tracks live lots for aggregate-consumption checks and depth queries.

## 3. Matching (taker path)

```
fill(taker, market, side, limit_tick, qty_lots, flags {post_only, fill_or_kill, no_rest}):
  best = Best(opposite)                       # 1 read
  while qty_lots > 0 and best crosses limit_tick and levels_crossed < MAX_LEVELS_PER_FILL:
    lvl = Level(opposite, best)
    if lvl.total_open <= qty_lots:            # sweep whole level
      qty_lots -= lvl.total_open
      quote += lvl.total_open * best * tick_size
      lvl.generation += 1; reset queue        # ONE small write; orders abandoned
      clear bit in L0(word(best)) [and L1 if word empties]
      best = next_set_tick(L0/L1)             # bitmap walk, reads only
    else:                                     # partial: advance head
      consume from head (skip tombstones), update head_seq/head_consumed/total_open
      quote += consumed * best * tick_size    # ONE small write; loop ends
  if qty_lots > 0: fill_or_kill ⇒ fail; post_only+crossed ⇒ fail; else rest remainder
  settle: SAC transfers taker↔vault (base, quote); fees from taker output → Fees(token)
  update Best(opposite) if moved; emit events
```

Resting the remainder (or a pure maker order): assign `seq = tail_seq++`, append
`(seq, qty)` to level (create level + set bitmap bits if new), write `OrderRef`, escrow
via one SAC transfer. Post-only rests MUST NOT read the opposite side beyond `Best`
(footprint stability).

Pages: when a level's inline vector is full, append to `Page(side, tick, p)`; the level
header tracks page count and the head location. Matching consumes inline first, then
pages in order. (Deep single-level queues are the only case that grows footprint per
maker *count* — bounded by P per entry.)

**Events** (per tx ≤ 16,384 bytes — enforce by construction): `rested(order_id, owner)`,
`filled(side, tick, lots, quote)` one per crossed level, `swept(side, tick, generation)`,
`claimed(order_id, filled_lots, refunded_lots)`, `top_changed(side, old_tick, new_tick)`.
No synchronous hooks — Soroban cannot resource-cap an untrusted call.

`route(legs[])`: sequential fills across markets, deltas netted in invocation memory,
one SAC transfer per token at the end (Deepstate's `fillRoute`, minus transient storage).

## 4. Footprints: the product surface

Everything above exists so this section works:

- All keys derive from `(mkt, side, tick, w, p)` — a client/SDK computes them without
  chain state.
- **Padding rule:** simulation crossed levels `t1..tk` ⇒ declare RW: those levels, the
  next `pad_levels` set ticks beyond `tk` (walk the simulated bitmaps), their L0 words
  (+L1), `Best`, and — if resting is possible — the taker's own level + bitmap words.
  A fill then fails only if the book moves past the pad between simulation and
  inclusion. `pad_levels` is a client knob (default target: 2× simulated crossing).
- Declared-but-untouched entries are free apart from footprint slots (budget 400).
- **Concurrency:** RW-key sets are per-(market, side) — bid rests vs ask rests are
  disjoint clusters under P23 parallel execution; different markets fully disjoint. The
  serialization domain of a hot market is `Best(side)` + top levels — the CLOB-inherent
  minimum (cf. Phoenix's whole-market lock).

Budgets (targets, incl. SAC instance/balance entries; verify in tests):

| Op | Footprint | Writes | Write bytes |
|---|---|---|---|
| rest (existing level) | ~10 | ~5 | ~0.6 KB |
| rest (new level) | ~12 | ~7 | ~0.9 KB |
| cancel / claim | ~8 | ~3–4 | ~0.4 KB |
| taker, 8 levels (padded 16) | ~28 | ~14 | ~2.5 KB |
| max sweep (32 levels) | ~50 | ~40 | ~8 KB |

vs limits 400 / 200 / 132 KB per tx. Network ceiling: 286,720 ledger write bytes ⇒
~100–250 book ops/ledger shared with all Soroban traffic — the reason every hot entry is
a few hundred bytes. (SLP history suggests this rises; per-op bytes here are ~50–100x
under a whole-book-blob design.)

## 5. TTL / archival policy

| Entry | Extended by | Target TTL | On archival |
|---|---|---|---|
| `Market` (instance) | any op (bump_instance) | ~90 d | auto-restore |
| `Best`, `L1`, `L0` | ops that touch them | ~30 d | auto-restore on touch |
| `Level`, `Page` | ops that touch them | ~30 d | auto-restore on touch (generation survives) |
| `OrderRef` | maker at rest (+ re-bump on touch) | 90–180 d | claimant auto-restores; costs land on beneficiary |
| `Fees` | fee ops | ~90 d | recipient restores |

Requirements: **never `del` a `Level`** (counters must survive for claims; cold levels
sleep in the archive — archival IS the garbage collector, and restore-on-touch is the
designed lifecycle). `OrderRef` IS deleted on claim (its lifecycle is done). Temporary
storage is allowed only for lossless-if-lost data (e.g., optional time-in-force expiry
index) — never for funds-bearing state.

## 6. Explicit non-goals / deferred

- **Global orders** (Manifest-style cross-market capital): reintroduces third-party
  vault entries into taker footprints and sim-to-apply races; v2 at most, with bounded
  global makers per level and skippable-order semantics.
- **Synchronous hooks**: impossible to sandbox (no per-call cap); events instead.
- **Self-trade prevention, oracle-pegged orders, geometric ticks, batch-auction market
  type** (SPEEDEX-flavored sibling for hot markets): design notes exist in
  `01-prior-art.md`; not v1.

## 7. Invariants (must hold; property-test all)

1. Conservation: vault balance per token == Σ open escrows + Σ unclaimed proceeds +
   accrued fees (across all markets).
2. `total_open` == Σ live queue qtys (inline + pages, tombstones excluded).
3. Bitmap bit set ⟺ level has `total_open > 0`; `Best` == max/min set bit.
4. Claim settlement is exact and path-independent: any interleaving of fills/cancels
   ending in the same counters pays the same amounts (single-price levels make this
   provable).
5. Price-time priority: fills consume strictly best tick first, FIFO within level.
6. No operation touches entries outside its declared key family (footprint discipline).
7. Every loop is bounded by a config constant.
