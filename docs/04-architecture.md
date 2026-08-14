# PageBook architecture

*Normative design. MUST/never statements are requirements; numbers marked "target" are
tunable via config or measurement. Rationale lives in docs 01–03. Revised after
adversarial review — see `decisions/001-adversarial-review-round-1.md`.*

## 0. Model

One contract hosts many **markets**. A market is a sorted token pair (SAC addresses)
plus quantization params. Each market has two **sides** (bids, asks) of price **levels**;
each level is a FIFO queue of maker orders at exactly one price. Takers cross the book
and settle atomically; makers rest, then later **claim/cancel** — one entry point that
settles whatever happened (filled → proceeds, open → refund, mixed → both).

### Quantization (exactness by construction)

- `lot_size`: base atoms per lot (u64 lots on the book).
- `tick_size`: quote atoms per (base lot) per tick.
- Price of tick `t` (u32, band-limited by market config `[tick_min, tick_max)`,
  `tick_min ≥ 1` — tick 0 would admit zero-price, zero-escrow orders):
  `t × tick_size` quote atoms per base lot.
- Quote value of a fill = `qty_lots × t × tick_size` — **integer, exact**. There is no
  rounding anywhere in the matching path; Deepstate's correction-code machinery is
  unnecessary. All intermediate math in i128 (checked). The **only** rounding in the
  system is the taker fee: `fee = ceil(output × fee_bps / 10_000)` — rounds up, dust
  accrues to `Fees`.
- **Bounds at creation:** `create_market` MUST enforce
  `max_order_lots × tick_max × tick_size ≤ i128::MAX / 4` (headroom for fee math).
  Orders outside `[min_order_lots, max_order_lots]` are rejected — the floor is the
  dust-order defense, the ceiling is the overflow proof.

## 1. Storage schema

All keys are pure functions of static identifiers — this is the load-bearing property
(footprint paddability). Payload sizes are XDR-serialized targets at max occupancy;
enforce with tests.

| # | Entry | Durability | Key | Contents | Target size |
|---|---|---|---|---|---|
| 1 | `Admin` | instance | — | admin `Address`, fee recipient `Address`, paused flag, market counter | ~150 B |
| 2 | `Market` | persistent | `("M", mkt_id)` | base/quote SAC addrs, lot_size, tick_size, tick band, fee bps, min/max order lots, `MAX_LEVELS_PER_FILL`, `MAX_SLOTS_SCANNED`, N, P, `MAX_PAGES` | ~250 B |
| 3 | `Best(side)` | persistent | `("B", mkt, side)` | best tick (u32), empty flag | ~40 B |
| 4 | `L1(side)` | persistent | `("S", mkt, side)` | summary bitmap: bit w = "L0 word w has any set bit" (2,048 words) | 256 B |
| 5 | `L0(side, w)` | persistent | `("W", mkt, side, w)` | presence bitmap for ticks `[w·2048, (w+1)·2048)` | 256 B |
| 6 | `Level(side, tick)` | persistent | `("L", mkt, side, tick)` | packed `Bytes`: version u8, `generation:u32, head_seq:u32, tail_seq:u32, head_consumed:u64, total_open:u64`, then N × qty:u64 inline slots (target N=32) | ≤ 384 B |
| 7 | `Page(side, tick, p)` | persistent | `("P", mkt, side, tick, p)` | packed `Bytes`: version u8, then P × qty:u64 slots (target P=32) | ≤ 320 B |
| 8 | `OrderRef(order_id)` | persistent | `("O", mkt, order_id)` | owner `Address`, qty_lots — nothing else; side/tick/generation/seq are already in the key | ≤ 128 B |
| 9 | `Fees(token)` | persistent | `("F", mkt, token)` | accrued protocol fees (i128) | ~50 B |

`order_id` = packed `(side:1 | tick:u32 | generation:u32 | seq:u32)` — returned to the
maker on rest; `OrderRef` is written **once** at rest and deleted at claim.

**Packed encoding is mandatory for hot entries.** `Level` and `Page` are fixed-layout
`Bytes` blobs with a leading schema-version byte, not `#[contracttype]` structs —
symbol-keyed `ScVal::Map` encoding roughly 2–2.5×'s the payload (a map-encoded Level at
N=32 is ~1.2 KB) and would cascade into every write-byte and ops/ledger figure below.
Slots store **qty only**; seq is implicit in slot position (§2). M0 size tests enforce
the targets.

**Level capacity** within one generation is `N + P × MAX_PAGES` seqs; rests beyond that
fail with `LevelFull`. Pages wholly behind `head_seq` MAY be deleted by the operation
that advances past them (claims never read slots — they settle from counters +
`OrderRef.qty`), so live pages are bounded by queue *depth*, not by history.

The bitmap hierarchy covers `2048 × 2048 ≈ 4.19M` ticks per side per market — the
market's tick band MUST fit inside one L1 entry (plenty at sane tick sizes; wider-range
assets choose a coarser `tick_size` or a geometric-tick market type, out of scope for v1).

Vault: the contract holds escrow in its own SAC balances (one balance entry per token —
part of every settling footprint, and the true serialization point; see §4). Bids escrow
quote (`qty × t × tick_size`); asks escrow base (`qty × lot_size`).

## 2. Level accounting (the core mechanism)

**Queue layout (positional, append-only).** Within a generation, seq `s` occupies inline
slot `s` if `s < N`, else slot `(s − N) mod P` of `Page((s − N) / P)`. Slots are never
moved or compacted; "remove head" always means counter advance, never element removal.
Every slot's location is therefore a pure function of the order_id — a canceller
declares at most one specific Page.

Three counters carry all fill history:

- `generation` — increments each time the level is swept **empty** by matching; the
  queue resets (seqs restart at 0).
- `head_seq` — first seq not yet fully filled (within current generation).
- `head_consumed` — lots already consumed from the head order. **Convention (eager
  advance):** `head_consumed` is always strictly less than the head order's open qty;
  the moment consumption reaches it, `head_seq` advances (skipping consecutive
  tombstones reachable within already-declared entries) and `head_consumed` resets to 0.

**Claim logic** for `order = (side, tick, generation g, seq s, qty q)` against
`Level(side, tick)` with state `(G, H, C)`:

| Condition | Status | Settlement |
|---|---|---|
| `g < G` | fully filled | pay `q` at tick price |
| `g == G`, `s < H` | fully filled | pay `q` at tick price |
| `g == G`, `s == H` | partially filled `C` | pay `C` at tick price; refund `q − C`; advance `H` (eagerly, past consecutive tombstones in declared entries), reset `C` |
| `g == G`, `s > H` | open | refund `q`; zero its queue slot (tombstone) |

Then delete `OrderRef`, emit event. O(1), ~3 writes. Because every fill at a level
happens at exactly the tick price, *when* the fill happened is irrelevant — counters are
a complete proof. This re-derives Deepstate's "absent from tree ⇒ fully filled" claim
at stable keys, and is the direct replacement for Phoenix seats / DeepBook settled-owed
ledgers with **zero maker-related writes during matching**.

**Bounded tombstone scan.** Tombstones (`qty = 0` slots from mid-queue cancels) are
skipped when the head advances, but the scan is bounded: a fill scans at most
`MAX_SLOTS_SCANNED` slots total, and head advancement is **always persisted**, even when
the cap ends the fill early — cleanup cost amortizes across takers instead of repeating
for each one. Without this bound, an attacker rests K dust orders, cancels the middle,
and poisons the best price with a scan bounded only by history. (`min_order_lots` raises
the cost of that attack; the scan cap removes the damage.)

`total_open` tracks live lots for aggregate-consumption checks and depth queries.

## 3. Matching (taker path)

```
fill(taker, market, side, limit_tick, qty_lots, start_tick, flags {post_only, fill_or_kill, no_rest}):
  # start_tick = the client's simulated best opposite tick. Matching never visits
  # ticks BETTER than start_tick: an order rested at a better price between
  # simulation and inclusion is simply unreachable by this fill — it cannot make
  # the tx read an undeclared key, so it cannot fail the tx.
  best = worse_of(Best(opposite), start_tick)   # bitmap walk from start_tick if needed
  while qty_lots > 0 and best crosses limit_tick
        and levels_crossed < MAX_LEVELS_PER_FILL
        and slots_scanned < MAX_SLOTS_SCANNED:
    lvl = Level(opposite, best)
    if lvl.total_open == 0:                     # stale bit (lazy clear — see §8 inv. 3)
      clear bit in L0/L1; best = next_set_tick(); continue   # counts as a crossed level
    if lvl.total_open <= qty_lots:              # sweep whole level
      qty_lots -= lvl.total_open
      quote += lvl.total_open * best * tick_size
      lvl.generation += 1; reset queue          # ONE small write; orders abandoned
      clear bit in L0(word(best)) [and L1 if word empties]
      best = next_set_tick(L0/L1)               # bitmap walk, reads only
    else:                                       # partial: advance head
      consume from head (skip tombstones, bounded by MAX_SLOTS_SCANNED)
      update head_seq/head_consumed/total_open  # progress persists even if cap hit
      quote += consumed * best * tick_size      # ONE small write; loop ends
  if qty_lots > 0:
    fill_or_kill ⇒ fail; post_only + crossed ⇒ fail
    if loop terminated by a cap while the book still crosses limit_tick:
      refund remainder                          # NEVER rest a crossing order (inv. 8)
    else: rest remainder at limit_tick
  settle: SAC transfers taker↔vault (base, quote)
  fee = ceil(taker_output × fee_bps / 10_000) → Fees(token)   # the only rounding
  update Best(opposite) if moved; emit events
```

Resting the remainder (or a pure maker order): enforce `[min_order_lots,
max_order_lots]`, assign `seq = tail_seq++` (fail `LevelFull` at generation capacity
`N + P × MAX_PAGES`), write qty into the positional slot (create level + set bitmap bits
if new), write `OrderRef`, escrow via one SAC transfer. Post-only rests MUST NOT read
the opposite side beyond `Best` (footprint stability).

Pages: slots beyond N spill into `Page(side, tick, p)` positionally (§2). Matching
consumes inline first, then pages in order; an op that advances `head_seq` past the end
of a page MAY delete it. (Deep single-level queues are the only case that grows
footprint per maker *count* — bounded by P per entry.)

**Events** (per tx ≤ 16,384 bytes — enforce by construction): `rested(order_id, owner)`,
`filled(side, tick, lots, quote)` one per crossed level, `swept(side, tick, generation)`,
`claimed(order_id, filled_lots, refunded_lots)`, `top_changed(side, old_tick, new_tick)`.
No synchronous hooks — Soroban cannot resource-cap an untrusted call.

`route(legs[])`: sequential fills across markets (`legs.len() ≤ MAX_ROUTE_LEGS`), deltas
netted in invocation memory, one SAC transfer per token at the end (Deepstate's
`fillRoute`, minus transient storage).

## 4. Footprints: the product surface

Everything above exists so this section works:

- All keys derive from `(mkt, side, tick, w, p)` — a client/SDK computes them without
  chain state.
- **Padding rule (contiguous band).** The client simulates, gets crossed ticks starting
  at simulated best `t1`, passes `start_tick = t1`, and declares RW: **every `Level` key
  in the contiguous tick band `[t1, pad_end]`** — set or not (unset keys cost only
  footprint slots) — plus the L0 words covering the band, L1, `Best`, both vault
  balances, `Fees`, and, if resting is possible, the taker's own level/page/bitmap
  words and `OrderRef`. Band padding is required: a new level can appear at *any* tick
  inside the walk range between simulation and inclusion, so padding only the next few
  *currently-set* ticks is unsound. `start_tick` closes the better-priced direction
  (never visited); `pad_end` bounds the worse direction.
- **Honest failure mode:** a fill fails iff it needs to walk past `pad_end`. On sparse
  books a band deep enough to be safe may not fit in the 400-entry footprint; clients
  trade `pad_end` against failure probability. This residual is inherent and far
  smaller than the whole-book race in 02, but it is not zero — do not claim otherwise.
- Declared-but-untouched entries are free apart from footprint slots (budget 400).
- **Concurrency (honest version).** The true serialization points are the vault's SAC
  balance entries — one per (token, contract). Every settling op RWs one or both, so
  same-side rests serialize with each other, takers serialize with both sides, and
  **all markets sharing a token join one cluster** under P23/CAP-63: a venue quoted
  mostly in USDC is effectively one serial cluster. v1 accepts this — the network
  write-bytes ceiling, not cluster parallelism, is the binding throughput limit at
  current numbers. Recovering parallelism (per-market vault sub-accounts, or internal
  balance entries netted at claim edges) is an explicit v2 item (§7).

Budgets (targets, packed encoding, incl. SAC instance/balance entries and the now-
persistent `Market`; verify in tests):

| Op | Footprint | Writes | Write bytes |
|---|---|---|---|
| rest (existing level) | ~11 | ~5 | ~0.7 KB |
| rest (new level) | ~13 | ~7 | ~1.0 KB |
| cancel / claim | ~9 | ~3–4 | ~0.5 KB |
| taker, 8 levels (band pad ~24 keys) | ~45 | ~14 | ~2.5 KB |
| max sweep (32 levels, worst-case dispersal: 32 L0 words) | ~75 + pad | ~40 | ~8 KB |

vs limits 400 / 200 / 132 KB per tx. The max-sweep row is the *ceiling*, assuming every
swept level sits in its own L0 word — resource tests gate against these numbers, so they
must be the real worst case, not the typical one. Network ceiling: 286,720 ledger write
bytes ⇒ ~100–250 book ops/ledger shared with all Soroban traffic — the reason every hot
entry is a few hundred bytes. (SLP history suggests this rises; per-op bytes here are
~50–100x under a whole-book-blob design.)

## 5. TTL / archival policy

| Entry | Extended by | Target TTL | On archival |
|---|---|---|---|
| `Admin` (instance) | any op (bump_instance) | ~90 d | auto-restore |
| `Market` | any op on the market | ~90 d | auto-restore on touch |
| `Best`, `L1`, `L0` | ops that touch them | ~30 d | auto-restore on touch |
| `Level`, `Page` | ops that touch them | ~30 d | auto-restore on touch (generation survives) |
| `OrderRef` | maker at rest (+ re-bump on touch) | 90–180 d | claimant auto-restores; costs land on beneficiary |
| `Fees` | fee ops | ~90 d | recipient restores |

Requirements: **never `del` a `Level`** (counters must survive for claims; cold levels
sleep in the archive — archival IS the garbage collector, and restore-on-touch is the
designed lifecycle). Pages behind the head and `OrderRef` on claim ARE deleted (their
lifecycles are done). Temporary storage is allowed only for lossless-if-lost data (e.g.,
optional time-in-force expiry index) — never for funds-bearing state.

## 6. Administration, upgrade, pause

This contract custodies every maker's escrow; "no admin story" is not an option.

- `init(admin, fee_recipient)` — once. Admin MAY: rotate admin, set fee recipient,
  upgrade the wasm (`update_current_contract_wasm`), pause/unpause, create markets.
- **Market creation is admin-gated in v1.** Permissionless creation is deferred: it
  needs an anti-spam creation fee, and `Market` entries are per-key persistent
  (never instance — an instance-resident market table is a shared-entry growth bomb
  that every invocation pays to read).
- **Pause blocks `fill`/rest only. `cancel`, claim, and `claim_fees` ALWAYS work** —
  funds exit is never gated, under any admin state.
- `claim_fees` is callable by anyone and transfers accrued fees to the configured
  recipient (a permissionless crank; custody is defined by config, not by caller).
- Hot entries carry a leading schema-version byte (§1); upgraded code migrates entries
  lazily on touch.

## 7. Explicit non-goals / deferred

- **Global orders** (Manifest-style cross-market capital): reintroduces third-party
  vault entries into taker footprints and sim-to-apply races; v2 at most, with bounded
  global makers per level and skippable-order semantics.
- **Per-market vault sub-accounts** (or internal balance accounting netted at claim
  edges) to break the shared-token serialization cluster (§4); v2.
- **Permissionless market creation** with an anti-spam fee (§6); v2.
- **Synchronous hooks**: impossible to sandbox (no per-call cap); events instead.
- **Self-trade prevention, oracle-pegged orders, geometric ticks, batch-auction market
  type** (SPEEDEX-flavored sibling for hot markets): design notes exist in
  `01-prior-art.md`; not v1.

## 8. Invariants (must hold; property-test all)

1. Conservation: vault balance per token == Σ open escrows + Σ unclaimed proceeds +
   accrued fees (across all markets).
2. `total_open` == Σ live queue qtys (inline + pages, tombstones excluded).
3. `total_open > 0` ⇒ bitmap bit set. The converse is deliberately weak: a stale set
   bit over an empty level is permitted (cancel-to-empty is O(1) and does not walk
   bitmaps or move `Best`) and is cleared lazily by the next fill that visits it.
   `Best` is never *worse* than the true best set tick; fills may walk forward from it.
4. Claim settlement is exact and path-independent: any interleaving of fills/cancels
   ending in the same counters pays the same amounts (single-price levels make this
   provable).
5. Price-time priority, scoped by `start_tick`: fills consume strictly best-tick-first
   among ticks at-or-worse than `start_tick`, FIFO within level (tombstones skipped).
   Orders rested at better ticks after simulation keep their place; they are not
   consumed and not harmed.
6. No operation touches entries outside its declared key family (footprint discipline).
7. Every loop is bounded by a config constant (`MAX_LEVELS_PER_FILL`,
   `MAX_SLOTS_SCANNED`, `MAX_ROUTE_LEGS`, N, P, `MAX_PAGES`).
8. The book is never crossed after any operation completes: a fill loop terminated by a
   cap refunds its remainder rather than resting it.
