# PageBook architecture

*Normative design. MUST/never statements are requirements; numbers marked "target" are
tunable via config or measurement. Rationale lives in docs 01–03. Revised twice after
adversarial review — see `decisions/001-adversarial-review-round-1.md` and
`decisions/003-adversarial-review-round-2-resolutions.md`.*

## 0. Model

One contract hosts many **markets**. A market is a sorted token pair (SAC addresses)
plus quantization params. Each market has two **sides** (bids, asks) of price **levels**;
each level is a FIFO queue of maker orders at exactly one price. Takers cross the book
and settle atomically; makers rest, then later **settle** — one exit that pays whatever
happened (filled → proceeds, open → refund, mixed → both).

### Vocabulary (normative; used consistently in all docs, code, and tables)

- **Entry points** (what a caller invokes): `place` (cross and/or rest an order),
  `replace` / `replace_batch` (move quotes), `settle` (the one maker exit), `route`,
  `create_market`, the cranks (`collect_fees`, `keepalive`), and admin functions.
- **Behaviors** (what an invocation did): **take** (consume resting liquidity),
  **rest** (leave an order on the book), **sweep** (consume a whole level). One
  `place` may both take and rest.
- **Roles**: the **maker** is whoever's order rests; the **taker** is whoever takes.
- **Order states**: open → partially filled → filled. "Fill" is only ever an order
  state (or the flag `fill_or_kill`), never an operation name. Settling an open order
  *cancels* it (tombstones its slot); settling a filled order *claims* its proceeds —
  "cancel" and "claim" name outcomes of `settle`, not operations.

### Quantization (exactness by construction)

- `lot_size`: base atoms per lot (u64 lots on the book).
- `tick_size`: quote atoms per (base lot) per tick.
- Price of tick `t` (u32, band-limited by market config `[tick_min, tick_max)`,
  `tick_min ≥ 1` — tick 0 would admit zero-price, zero-escrow orders):
  `t × tick_size` quote atoms per base lot.
- Quote value of a take = `qty_lots × t × tick_size` — **integer, exact**. There is no
  rounding anywhere in the matching path; Deepstate's correction-code machinery is
  unnecessary. All intermediate math in i128 (checked). The **only** rounding in the
  system is the taker fee: `fee = ceil(output × fee_bps / 10_000)` — rounds up, dust
  accrues to `Fees`.

### Bounds (proved at creation, not checked per trade)

`create_market` MUST enforce, with `LEVEL_CAP = N + P × MAX_PAGES` (max orders per
level-generation):

- `LEVEL_CAP × max_order_lots × tick_max × tick_size ≤ i128::MAX / (4 × MAX_ROUTE_LEGS)`
  — covers one order, one full level, one max sweep, and a max route, with 4× headroom
  for fee math. (A taker's aggregate quote is bounded by its own `qty_lots`, which is
  itself ≤ `max_order_lots`.)
- `LEVEL_CAP × max_order_lots × lot_size ≤ i128::MAX / (4 × MAX_ROUTE_LEGS)` — same
  proof for the base side (escrow and level totals).
- `taker_fee_bps ≤ FEE_BPS_MAX` (config constant, e.g. 1,000 = 10%) — `FeeTooHigh`.

Any order or taker quantity outside `[min_order_lots, max_order_lots]` is rejected —
the floor is the dust-order defense, the ceiling is half the overflow proof.
`Fees(token)` accrues in i128; its ceiling is total token supply, which SAC bounds
below i128 by construction.

## 1. Storage schema

All keys are pure functions of **client-known** identifiers — this is the load-bearing
property (footprint paddability). Nothing execution assigns at apply time (generation,
seq, page index) may appear in a key the client must declare, unless the client can
bound it; that rule shapes `OrderRef` below. Payload sizes are XDR-serialized targets
at max occupancy; enforce with tests.

| # | Entry | Durability | Key | Contents | Target size |
|---|---|---|---|---|---|
| 1 | `Admin` | instance | — | admin `Address`, fee recipient `Address`, paused flag, market counter | ~150 B |
| 2 | `Market` | persistent | `("M", mkt_id)` | base/quote SAC addrs, lot_size, tick_size, tick band, fee bps, min/max order lots, `MAX_LEVELS_CROSSED`, `MAX_SLOTS_SCANNED`, N, P, `MAX_PAGES` | ~250 B |
| 3 | `Best(side)` | persistent | `("B", mkt, side)` | best tick (u32), empty flag | ~40 B |
| 4 | `L1(side)` | persistent | `("S", mkt, side)` | summary bitmap: bit w = "L0 word w has any set bit" (2,048 words) | 256 B |
| 5 | `L0(side, w)` | persistent | `("W", mkt, side, w)` | presence bitmap for ticks `[w·2048, (w+1)·2048)` | 256 B |
| 6 | `Level(side, tick)` | persistent | `("L", mkt, side, tick)` | packed `Bytes`: version u8, `generation:u32, head_seq:u32, tail_seq:u32, head_consumed:u64, total_open:u64`, then N × qty:u64 inline slots (target N=32) | ≤ 384 B |
| 7 | `Page(side, tick, p)` | persistent | `("P", mkt, side, tick, p)` | packed `Bytes`: version u8, then P × qty:u64 slots (target P=32) | ≤ 320 B |
| 8 | `OrderRef(owner, nonce)` | persistent | `("O", mkt, owner, nonce)` | side, tick, generation, seq, qty_lots | ≤ 160 B |
| 9 | `Fees(token)` | persistent | `("F", mkt, token)` | accrued protocol fees (i128) | ~50 B |

**Order identity.** An order's handle is `(owner, nonce)` — the nonce is chosen by the
client *before* submission, so the `OrderRef` key is declarable at simulation time no
matter what the book does in flight. The queue coordinates `(side, tick, generation,
seq)` are assigned at execution, stored *inside* the entry (contents never affect the
footprint), and reported in the `rested` event. Rest fails with `OrderExists` if the
nonce is live; nonces are reusable after settle. `OrderRef` is written at rest, **rewritten
in place by `replace`** (§3), and deleted at settle. Its layout is fixed-size so a
rewrite never changes the entry size — the property that makes `replace` rent-free.
(Keying `OrderRef` by `(generation, seq)` — round-1's design — was unsound: any
concurrent rest at the same level moves `tail_seq`, any concurrent sweep bumps
`generation`, and the simulated key is wrong. See ADR-003.)

**Packed encoding is mandatory for hot entries.** `Level` and `Page` are fixed-layout
`Bytes` blobs with a leading schema-version byte, not `#[contracttype]` structs —
symbol-keyed `ScVal::Map` encoding roughly 2–2.5×'s the payload (a map-encoded Level at
N=32 is ~1.2 KB) and would cascade into every write-byte and ops/ledger figure below.
Slots store **qty only**; seq is implicit in slot position (§2). M0 size tests enforce
the targets.

**Level capacity** within one generation is `LEVEL_CAP = N + P × MAX_PAGES` seqs; rests
beyond that fail with `LevelFull` (see §2 for the empty-level reset that makes this
recoverable). Pages wholly behind `head_seq` MAY be deleted by the operation that
advances past them (settlement never reads slots — it derives from counters +
`OrderRef.qty`), so live pages are bounded by queue *depth*, not by history.

**Stale-slot rule (page reuse).** `Page` keys do not include the generation, and a
generation reset does not clear old pages — stale slot data from a prior generation can
sit under a live key. Therefore: a slot is meaningful **iff its seq < tail_seq of the
current generation**; appends write slots strictly sequentially with no gaps; readers
MUST ignore everything at or beyond `tail_seq`. This is invariant 9 and gets its own
tests (generation reset over dirty pages, then reuse).

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
Every slot's location is therefore a pure function of coordinates the maker knows after
resting — a settling maker declares at most one specific Page.

Three counters carry all fill history:

- `generation` — increments each time the queue resets: swept **empty** by matching, or
  reset-on-rest of a cancelled-empty level (below). Seqs restart at 0.
- `head_seq` — first seq not yet fully filled (within current generation).
- `head_consumed` — lots already consumed from the head order. **Convention (eager
  advance):** `head_consumed` is always strictly less than the head order's open qty;
  the moment consumption reaches it, `head_seq` advances (skipping consecutive
  tombstones reachable within already-declared entries) and `head_consumed` resets to 0.

**Empty-level reset.** A rest that finds `total_open == 0 && tail_seq > 0` MUST first
reset the queue: `generation += 1, head_seq = 0, head_consumed = 0, tail_seq = 0`.
This is safe: at `total_open == 0`, every seq in `[H, tail)` is a tombstone whose
`OrderRef` was already deleted at cancel, and every seq `< H` is fully filled — bumping
G turns their settlements into the `g < G` row below, which pays them identically. Without
this rule, a level emptied by *cancels* (matching never sweeps it) accumulates
`tail_seq` forever and eventually returns `LevelFull` at an empty price — a permanent
DoS on that tick. (ADR-002 finding 2.)

**Settlement logic** for order with stored coordinates `(side, tick, generation g, seq s,
qty q)` against `Level(side, tick)` with state `(G, H, C)`:

| Condition | State | Settlement |
|---|---|---|
| `g < G` | fully filled | pay `q` at tick price |
| `g == G`, `s < H` | fully filled | pay `q` at tick price |
| `g == G`, `s == H` | partially filled `C` | pay `C` at tick price; refund `q − C`; advance `H` (eagerly, past consecutive tombstones in declared entries), reset `C` |
| `g == G`, `s > H` | open | refund `q`; zero its queue slot (tombstone) |

Then delete `OrderRef`, emit event. O(1), ~3 writes. Because every take at a level
happens at exactly the tick price, *when* it happened is irrelevant — counters are
a complete proof. This re-derives Deepstate's "absent from tree ⇒ fully filled" claim
at stable keys, and is the direct replacement for Phoenix seats / DeepBook settled-owed
ledgers with **zero maker-related writes during matching**.

**Bounded tombstone scan.** Tombstones (`qty = 0` slots from mid-queue cancels) are
skipped when the head advances, but the scan is bounded: a place scans at most
`MAX_SLOTS_SCANNED` slots total, and head advancement is **always persisted**, even when
the cap ends the loop early — cleanup cost amortizes across takers instead of repeating
for each one. Without this bound, an attacker rests K dust orders, cancels the middle,
and poisons the best price with a scan bounded only by history. (`min_order_lots` raises
the cost of that attack; the scan cap removes the damage.)

`total_open` tracks live lots for aggregate-consumption checks and depth queries.

## 3. Matching (taker path)

Sweeping a level never reads its slots (`total_open × tick × tick_size` is exact), so
the only slot access in matching is partial consumption at the final level, and the only
slot *write* outside it is the taker's own rest. Both are bounded by client-declared
windows (§4) — execution treats a window edge like a loop cap, never as a trap:

```
place(taker, market, side, limit_tick, qty_lots, start_tick, nonce, window, flags):
  # start_tick = the client's simulated best opposite tick. Matching never visits
  # ticks BETTER than start_tick: an order rested at a better price between
  # simulation and inclusion is simply unreachable by this place — it cannot make
  # the tx read an undeclared key, so it cannot fail the tx.
  # window = the slot access the client declared pages for: per-band-level page
  # ranges for consumption, plus the append range for the taker's own rest.
  best = worse_of(Best(opposite), start_tick)   # bitmap walk from start_tick if needed
  while qty_lots > 0 and best crosses limit_tick
        and levels_crossed < MAX_LEVELS_CROSSED
        and slots_scanned < MAX_SLOTS_SCANNED:
    lvl = Level(opposite, best)
    if lvl.total_open == 0:                     # stale bit (lazy clear — see §8 inv. 3)
      clear bit in L0/L1; best = next_set_tick(); continue   # counts as a crossed level
    if lvl.total_open <= qty_lots:              # sweep whole level — no slot reads
      qty_lots -= lvl.total_open
      quote += lvl.total_open * best * tick_size
      lvl.generation += 1; reset queue          # ONE small write; orders abandoned
      clear bit in L0(word(best)) [and L1 if word empties]
      best = next_set_tick(L0/L1)               # bitmap walk, reads only
    else:                                       # partial: advance head
      if head slot lies outside window[best]: break   # graceful stop, like a cap
      consume from head (skip tombstones; bounded by MAX_SLOTS_SCANNED and window)
      update head_seq/head_consumed/total_open  # progress persists even if cap hit
      quote += consumed * best * tick_size      # ONE small write; loop ends
  if qty_lots > 0:
    fill_or_kill ⇒ fail; post_only + crossed ⇒ fail
    if loop terminated by a cap or window edge while the book still crosses limit_tick:
      refund remainder                          # NEVER rest a crossing order (inv. 8)
    else: rest remainder at limit_tick (append must land in window, below)
  transfer: SAC moves taker↔vault (base, quote)
  fee = ceil(taker_output × fee_bps / 10_000) → Fees(token)   # the only rounding
  update Best(opposite) if moved; emit events
```

**Resting** (the remainder, or a pure maker order): enforce `[min_order_lots,
max_order_lots]`; apply the empty-level reset (§2) if due; assign `seq = tail_seq++`
(fail `LevelFull` at `LEVEL_CAP`); the slot for `seq` must be inline or in a page inside
the declared append window — if a concurrent rest pushed the tail past it, fail with the
typed error `RetryRest` (graceful; client re-simulates), never a footprint trap. Write
the qty slot (create level + set bitmap bits if new), write `OrderRef(owner, nonce)`,
escrow via one SAC transfer. The append window is cheap to make safe: `{page(tail_sim),
page(tail_sim)+1, page 0}` covers concurrent same-level rests up to a full page (P
orders) *and* a concurrent sweep or reset (which sends the tail back toward 0).

**Post-only semantics (deliberately conservative).** A post-only rest compares its tick
against the recorded `Best(opposite)` **as stored** — one read, footprint-stable. If it
would cross the recorded best, it fails `Crossed`, *even if that best is a stale bit
over an emptied level*. Because `Best` is never worse than the true best (inv. 3), this
check can false-reject near stale state (until the next place that takes there cleans it) but can never
rest a truly crossing order. Trying to be smarter — walking past stale levels to find
the "true" best — would either widen the footprint unboundedly or create a crossed
book; both are forbidden.

**Replace: the maker update path.** `replace(owner, nonce, side, tick, qty)` — and the
batched `replace_batch`, ≤ `MAX_REPLACE_BATCH` items, one netted transfer per token —
settles the old order exactly per the §2 claim table (pay what filled, refund what
didn't, tombstone the slot), then rewrites the **same `OrderRef` in place** with the new
coordinates and appends at the new tick under the normal rest rules (bounds, append
window, `LevelFull`, empty-reset). Because the entry is reused at fixed size, **no rent
is charged**: the maker's nonce is a durable quote slot whose 120-day rent amortizes
across every update. This is what makes market making economical (§4 fee table,
ADR-005) — settle+place re-creates the `OrderRef` and re-pays ~0.027 XLM of rent per
update; replace pays only write fees (~0.003 XLM). Replace never takes liquidity: it
applies the same conservative post-only check against recorded `Best` and fails
`Crossed` instead. And it is atomic — the maker is never unquoted between the
settlement and the re-rest, which a settle-then-place pair cannot guarantee.

Pages: slots beyond N spill into `Page(side, tick, p)` positionally (§2). Matching
consumes inline first, then pages in order; an op that advances `head_seq` past the end
of a page MAY delete it. (Deep single-level queues are the only case that grows
footprint per maker *count* — bounded by P per entry.)

**Events** (per tx ≤ 16,384 bytes): `rested(owner, nonce, side, tick, generation, seq)`,
`filled(side, tick, lots, quote)` one per crossed level, `swept(side, tick, generation)`,
`settled(owner, nonce, filled_lots, refunded_lots)`, `top_changed(side, old, new)`.
Event bytes are bounded by the same caps that bound the loops: ≤ `MAX_LEVELS_CROSSED`
take/sweep events per invocation (shared across route legs, below) ⇒ worst case ≈ 64 ×
~100 B ≈ 6.4 KB, asserted in tests. No synchronous hooks — Soroban cannot resource-cap
an untrusted call.

`route(legs[])`: sequential place legs across markets, deltas netted in invocation memory,
one SAC transfer per token at the end. **Route caps are per-transaction, not per-leg:**
`legs.len() ≤ MAX_ROUTE_LEGS`, and one shared `MAX_LEVELS_CROSSED` /
`MAX_SLOTS_SCANNED` budget spans all legs — so a route's worst-case writes, events, and
footprint are the same as a single maximal place plus per-leg constants, and the §0 creation
bound already reserves `MAX_ROUTE_LEGS` headroom for the netted transfers. The client
splits the 400-entry footprint across legs' bands (SDK responsibility).

## 4. Footprints: the product surface

Everything above exists so this section works:

- All keys derive from `(mkt, side, tick, w, p, owner, nonce)` — a client/SDK computes
  them without chain state, before submission.
- **Padding rule (contiguous band + slot windows).** The client simulates, gets crossed
  ticks starting at simulated best `t1`, passes `start_tick = t1`, and declares RW:
  **every `Level` key in the contiguous tick band `[t1, pad_end]`** — set or not (unset
  keys cost only footprint slots) — plus the L0 words covering the band, L1, `Best`,
  both vault balances, `Fees`, and the slot windows: for each *set* level in the band,
  pages `[page(head_sim), page(head_sim) + w]` (w small; unset/fresh levels need none —
  their queues are inline); for the taker's own possible rest, `OrderRef(taker, nonce)`,
  the rest level's bitmap words, and append pages `{page(tail_sim), +1, 0}`. Band
  padding is required because a new level can appear at *any* tick inside the walk
  range; window padding is required because a concurrent take can move a head into
  pages, and a concurrent rest can move a tail across a page boundary.
- **Failure modes, exhaustively.** A place **traps** (footprint violation) only if the
  walk must pass `pad_end`. Every other race **degrades gracefully**: scan cap, level
  cap, and window edges end the loop with progress persisted and the remainder
  refunded; an append landing outside the window is the typed error `RetryRest`. On
  sparse books a band deep enough to be safe may not fit in the 400-entry footprint;
  clients trade `pad_end` against trap probability. This residual is inherent and far
  smaller than the whole-book race in 02, but it is not zero — do not claim otherwise.
- Declared-but-untouched entries are free apart from footprint slots (budget 400).
- **Concurrency (honest version).** The true serialization points are the vault's SAC
  balance entries — one per (token, contract). Every settling op RWs one or both, so
  same-side rests serialize with each other, takers serialize with both sides, and
  **all markets sharing a token join one cluster** under P23/CAP-63: a venue quoted
  mostly in USDC is effectively one serial cluster. v1 accepts this — the network
  write-bytes ceiling, not cluster parallelism, is the binding throughput limit at
  current numbers. Recovering parallelism (per-market vault sub-accounts, or internal
  balance entries netted at settlement edges) is an explicit v2 item (§7). No operation
  writes the instance entry (§5) — the cluster analysis above is the whole story.

Budgets (targets, packed encoding, incl. SAC instance/balance entries and the
persistent `Market`; derived from the worst-case write set, not the typical one —
resource tests gate against these):

| Op | Footprint | Writes | Write bytes |
|---|---|---|---|
| place — rest only (existing level) | ~12 | ~5 | ~0.9 KB |
| place — rest only (new level) | ~14 | ~7 | ~1.2 KB |
| settle | ~9 | ~3–4 | ~0.6 KB |
| replace (one quote) | ~14 | ~8 | ~1.5 KB |
| replace_batch (40-quote full refresh) | ~130 | ~90 | ~24 KB |
| place — take only, 8 levels swept (band ~24 + windows) | ~55 | ~21 | ~6 KB |
| place — maximal take (32 levels, 32 distinct L0 words) | ~85 + pad | ~70 | ~22 KB |

Worst-case write-byte arithmetic for the max sweep, so nobody trusts the table blindly:
32 Level (×384 B) + 32 L0 (×256 B) + L1 + Best + Fees + 2 vault balances + own-rest
entries ≈ 12.3 + 8.2 + 0.3 + ~1.2 KB ≈ **22 KB** and ~70 writes — within per-tx limits
(400 entries / 200 writes / 132 KB) but **7.6% of a whole ledger's 286,720 write
bytes**. Typical ops are the rest/settle rows (≤ 1 KB); the ledger sustains hundreds of
those, or ~13 max sweeps, per close — the reason every hot entry is a few hundred bytes.
(SLP history suggests the ceiling rises; per-op bytes here are ~50–100× under a
whole-book-blob design.)

### Estimated resource fees per operation

Computed from live mainnet rates (Aug 2026; see 03 §Fees and ADR-004): instructions
7/10k stroops, 2,500 per write entry, write/rent floor 1,000 per KB, events 5,000/KB
(refundable), tx bytes ≈ 4.4 stroops each, live reads free, and rent ≈ **1,667 stroops
per byte per 120-day minimum TTL**. Instruction counts are rough (±3×) but immaterial —
**rent on newly created entries dominates everything else**:

| Op | Est. resource fee | Dominated by |
|---|---|---|
| place — rest only (existing level) | **~0.029 XLM** | `OrderRef` rent (160 B × 120 d ≈ 0.027) |
| place — rest only (first touch / restore of a tick) | **~0.094 XLM** | + `Level` rent (384 B ≈ 0.064) |
| settle | **~0.002 XLM** | write entries; no rent (only deletes/rewrites) |
| replace (one quote; entry reused) | **~0.003 XLM** | write entries; zero rent |
| replace_batch (40-quote full refresh, one tx) | **~0.03 XLM** | write entries (~90 × 2,500) |
| place — take only, 8 levels swept | **~0.009 XLM** | write entries + tx size |
| place — take 8 levels + rest remainder | **~0.037 XLM** | the remainder's `OrderRef` rent |
| place — maximal take (32 levels) | **~0.027 XLM** | write entries (70 × 2,500) |
| `create_market` | **~0.043 XLM** | `Market` rent |
| `collect_fees` | **~0.001 XLM** | — |
| `keepalive` (whole venue, per ~120 d) | **~2.3 XLM** | wasm code-entry rent (~40 KB at ⅓ discount) |

Readings, in design terms:

- **Matching is nearly free; placement pays rent.** A 32-level sweep costs about the
  same as one `OrderRef`. The book's carrying cost sits with makers at ~0.027 XLM per
  open order per 120 days — an anti-spam economics that arrives for free and stacks
  with `min_order_lots` (a dust-storm of K orders now has a hard cost of ~0.027 K XLM,
  non-refundable).
- **Churn is priced separately from holding — use `replace`.** Updating a quote via
  settle+place re-creates the `OrderRef` and re-pays its rent every time (~0.031
  XLM/quote — a 40-order book refreshed every minute would burn ~1,800 XLM/day, so
  SDEX-style churn is impossible on that path). `replace` reuses the entry: a full
  40-quote refresh in one tx is ~0.03 XLM, and the per-quote carrying cost stays
  0.000225 XLM/day regardless of update frequency. Capacity, not fees, then binds:
  at ~24 KB per full refresh the *network* fits ~12 per ledger. Full analysis and
  SDEX comparison in ADR-005.
- **Padding is negligible:** ~300 stroops (0.00003 XLM) per declared-but-untouched
  key — a 100-key band costs ~0.003 XLM. Pad generously; the budget constraint is the
  400-entry cap, not the fee.
- **Level rent is paid once per tick per ~120 days of activity**, by whoever
  creates/restores it (`Level`s are never deleted, so re-activating a swept tick is a
  rewrite, not a create).
- **Volatility caveat:** the 1,000/KB rate is the protocol *floor*; it climbs toward
  10,000/KB as live Soroban state approaches the 3 GB target — rent-dominated rows
  scale with it (worst case ~10×). M4 regression-gates measured fees against this
  table.

## 5. TTL / archival policy

Mainnet's minimum persistent TTL is **2,073,600 ledgers (~120 days)**, charged as rent
at creation/restore; the maximum is ~180 days (03 §Storage). That makes the policy
almost entirely passive — entries live in prepaid 120-day chunks, and **no hot path
ever extends a TTL** (matching, resting, and settling pay zero rent on existing
entries):

| Entry | TTL comes from | On archival (~120 d idle) |
|---|---|---|
| `Admin` (instance) + wasm code | permissionless `keepalive()` crank + admin ops — **never market ops** | crank restores (~2.3 XLM/120 d, mostly code rent) |
| `Market`, `Best`, `L1`, `L0`, `Level`, `Page`, `Fees` | 120-d minimum at creation/restore; whoever restores pays the next chunk | auto-restore on touch (generation survives) |
| `OrderRef` | 120-d minimum at rest (maker pays); maker MAY `extend_ttl` to the 180-d max for long-lived quotes | the settling maker auto-restores; costs land on beneficiary |

The instance rule matters for §4: a per-op `bump_instance` would put an instance
**write** in every transaction — one global serialization point across every market and
token, silently undoing the whole concurrency analysis. Reads of instance config are
shared read-only and do not conflict; the TTL is maintained out-of-band by `keepalive()`
(anyone may crank it; admin ops also bump).

An order older than ~120 days unsettled has an archived `OrderRef`; the settle
transaction auto-restores it (P23), paying its next rent chunk — acceptable because
settling is the entry's last act (it is deleted on settlement).

Requirements: **never `del` a `Level`** (counters must survive for settlement; cold levels
sleep in the archive — archival IS the garbage collector, and restore-on-touch is the
designed lifecycle). Pages behind the head and `OrderRef` on settle ARE deleted (their
lifecycles are done). Temporary storage is allowed only for lossless-if-lost data (e.g.,
optional time-in-force expiry index) — never for funds-bearing state.

## 6. Administration, upgrade, pause, authentication

This contract custodies every maker's escrow; "no admin story" is not an option.

- **Initialization is the constructor.** `__constructor(admin, fee_recipient)` runs
  atomically at deploy — there is no `init` entry point and no first-caller-wins race.
- **Every state-changing entry point authenticates**, explicitly:
  `place`/`route` → `taker.require_auth()`; `settle`/`replace` → `owner.require_auth()`;
  `create_market`, `set_admin`, `set_fee_recipient`, `set_paused`, `upgrade` →
  `admin.require_auth()`; `collect_fees` and `keepalive` → none (permissionless cranks
  whose effects are defined by config, not caller).
- **Trust model, stated plainly:** the admin can upgrade the wasm, and an upgraded wasm
  can move the vault. Deployments that custody real value MUST put the admin behind a
  multisig/timelock; "trustless" deployments set admin to a burn address and accept no
  upgrades. This is a disclosure, not a mitigation.
- **Market creation is admin-gated in v1.** Permissionless creation is deferred: it
  needs an anti-spam creation fee, and `Market` entries are per-key persistent
  (never instance — an instance-resident market table is a shared-entry growth bomb
  that every invocation pays to read).
- **Pause blocks `place` and `replace`. `settle` and `collect_fees` ALWAYS work** —
  funds exit is never gated, under any admin state. (`replace` contains a rest, so it
  pauses with the entry side of the book; the exit half stays available through
  `settle`.)
- **Cap retuning: `set_market_caps` (admin).** Market variables split into mutability
  classes (full analysis in `06-slp-sensitivity.md`). Frozen forever: quantization
  (`lot_size`, `tick_size`, tick band) and queue geometry (N, P) — slot location and
  price are pure functions of them, so changing them corrupts live state. Retunable
  via `set_market_caps`: `MAX_LEVELS_CROSSED`, `MAX_SLOTS_SCANNED`, `taker_fee_bps`
  (≤ `FEE_BPS_MAX`), `min_order_lots`/`max_order_lots`, and `MAX_PAGES` (raise-only —
  existing seqs may live beyond a lowered value); every call re-runs the §0 overflow
  proof and rejects values that break it. The entry point exists because validators
  retune Soroban's limits every few months (the SLP process) and a contract cannot
  read network config — no host function exposes resource limits or remaining budget —
  so stored caps can only track the network through an authorized transaction. The
  contract can verify its own §0 proof on-chain but cannot verify caps against live
  limits; choosing caps that fit the network is the admin's job, informed off-chain.
  Client-side knobs (band width, windows, batch composition) need no retuning: clients
  read live config over RPC per transaction.
- Hot entries carry a leading schema-version byte (§1); upgraded code migrates entries
  lazily on touch.

## 7. Explicit non-goals / deferred

- **Global orders** (Manifest-style cross-market capital): reintroduces third-party
  vault entries into taker footprints and sim-to-apply races; v2 at most, with bounded
  global makers per level and skippable-order semantics.
- **Per-market vault sub-accounts** (or internal balance accounting netted at
  settlement edges) to break the shared-token serialization cluster (§4); v2.
- **Permissionless market creation** with an anti-spam fee (§6); v2.
- **Synchronous hooks**: impossible to sandbox (no per-call cap); events instead.
- **Geometric-tick market type** using Liquidity Book's `(1+step)^id` map — changes
  only the id→price function (bitmaps/levels/settlement untouched), removes the per-market
  tick-band config, and makes a fixed-width pad band a constant percentage depth;
  see `01-prior-art.md` §Liquidity Book. v2.
- **Pooled (pro-rata) levels** — LB-style fungible per-`(level, generation)` shares as
  a sibling market type: deletes pages/tombstones/windows/`OrderRef` (whose rent is the
  dominant per-order cost, ADR-004) at the price of time priority within a level. MUST
  keep generation-on-sweep for fill finality (final order states without keepers). v2.
- **Volatility-scaled taker fee** (LB surge pricing): the matching loop already counts
  crossings and `Fees` is already RW — zero added footprint; costs `quote_place` exact
  fee determinism. v2, decision note required.
- **Self-trade prevention, oracle-pegged orders, batch-auction market type**
  (SPEEDEX-flavored sibling for hot markets): design notes exist in
  `01-prior-art.md`; not v1.

## 8. Invariants (must hold; property-test all)

1. Conservation: vault balance per token == Σ open escrows + Σ unclaimed proceeds +
   accrued fees (across all markets).
2. `total_open` == Σ live queue qtys (inline + pages, tombstones excluded, stale slots
   excluded per invariant 9).
3. `total_open > 0` ⇒ bitmap bit set. The converse is deliberately weak: a stale set
   bit over an empty level is permitted (cancel-to-empty is O(1) and does not walk
   bitmaps or move `Best`) and is cleared lazily by the next place that takes through it.
   `Best` is never *worse* than the true best set tick; matching may walk forward from it.
4. Settlement is exact and path-independent: any interleaving of takes and settles
   ending in the same counters pays the same amounts (single-price levels make this
   provable).
5. Price-time priority, scoped by `start_tick`: takes consume strictly best-tick-first
   among ticks at-or-worse than `start_tick`, FIFO within level (tombstones skipped).
   Orders rested at better ticks after simulation keep their place; they are not
   consumed and not harmed.
6. No operation touches entries outside its declared key family; window/cap edges
   degrade gracefully (refund / `RetryRest`), and only walking past `pad_end` traps.
7. Every loop is bounded by a config constant (`MAX_LEVELS_CROSSED`,
   `MAX_SLOTS_SCANNED`, `MAX_ROUTE_LEGS`, `MAX_REPLACE_BATCH`, N, P, `MAX_PAGES`) —
   route caps shared across legs, not multiplied by them.
8. The book is never crossed after any operation completes: a matching loop terminated by a
   cap or window refunds its remainder; post-only compares against recorded `Best` and
   fails closed.
9. Slot validity: a queue slot is meaningful iff `seq < tail_seq` of the current
   generation; appends are gapless and sequential; stale page contents from prior
   generations are never observable through any public path.
