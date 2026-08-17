# PageBook architecture

*Normative design. MUST/never statements are requirements; numbers marked "target" are
tunable via config or measurement. Rationale lives in docs 01–03. Revised twice after
adversarial review — see `decisions/001-adversarial-review-round-1.md` and
`decisions/003-adversarial-review-round-2-resolutions.md`.*

*The document is organized around the system's data structures and the processes that
act on them: §0 states the model and the arithmetic it stands on; Part I (§1–§6)
specifies each storage structure — layout, invariants, lifecycle — in one place;
Part II (§7–§14) specifies the mechanisms, the entry points that compose them, and the
client's half of the protocol; Part III (§15–§20) states what emerges from their
composition. ADR-009 maps this structure to the previous section numbering. Invariant
numbers (1–9, indexed in §19) are stable across both.*

## Part 0 — Foundations

### 0.1 Model and vocabulary

One contract hosts many **markets**. A market is a sorted token pair (SAC addresses)
plus quantization params. Each market has two **sides** (bids, asks) of price **levels**;
each level is a FIFO queue of maker orders at exactly one price. Takers cross the book
and settle atomically; makers rest, then later **settle** — one exit that pays whatever
happened (filled → proceeds, open → refund, mixed → both).

Vocabulary (normative; used consistently in all docs, code, and tables):

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

### 0.2 Quantization (exactness by construction)

- `lot_size`: base atoms per lot (u64 lots on the book).
- `tick_size`: quote atoms per (base lot) per tick.
- Price of tick `t` (u32, band-limited by market config `[tick_min, tick_max)`,
  `tick_min ≥ 1` — tick 0 would admit zero-price, zero-escrow orders):
  `t × tick_size` quote atoms per base lot.
- Quote value of a take = `qty_lots × t × tick_size` — **integer, exact**. There is no
  rounding anywhere in the matching path; Deepstate's correction-code machinery is
  unnecessary. All intermediate math in i128 (checked). The **only** rounding in the
  system is the taker fee: `fee = ceil(output × fee_bps / 10_000)` — rounds up, dust
  accrues to `FeeAccrual`.

### 0.3 Bounds (proved at creation, not checked per trade)

`create_market` MUST enforce, with `LEVEL_CAP = INLINE_SLOTS + PAGE_SLOTS × MAX_PAGES`
(max orders per level-generation):

- `LEVEL_CAP × max_order_lots × tick_max × tick_size ≤ i128::MAX / (4 × MAX_ROUTE_LEGS)`
  — covers one order, one full level, one max sweep, and a max route, with 4× headroom
  for fee math. (A taker's aggregate quote is bounded by its own `qty_lots`, which is
  itself ≤ `max_order_lots`.)
- `LEVEL_CAP × max_order_lots × lot_size ≤ i128::MAX / (4 × MAX_ROUTE_LEGS)` — same
  proof for the base side (escrow and level totals).
- `taker_fee_bps ≤ FEE_BPS_MAX` (config constant, e.g. 1,000 = 10%) — `FeeTooHigh`.

Any order or taker quantity outside `[min_order_lots, max_order_lots]` is rejected —
the floor is the dust-order defense, the ceiling is half the overflow proof.
`FeeAccrual(token)` accrues in i128; its ceiling is total token supply, which SAC bounds
below i128 by construction.

### 0.4 Actors

- **Maker, taker** — the on-book roles (§0.1).
- **Client (SDK)** — simulates, chooses nonces, computes and pads footprints before
  submission (§14). Padding is a client responsibility, not contract logic.
- **Admin** — governs the configuration structures (§1) through authenticated entry
  points (§12); the trust model is stated there.
- **Cranker** — anyone; runs the permissionless cranks (`collect_fees`, `keepalive`),
  whose effects are defined by config, not caller (§12).

## Part I — Data structures

Two principles govern every structure.

**Keys are pure functions of client-known identifiers.** This is the load-bearing
property: it is what makes footprints paddable (§14, §15). Nothing execution assigns
at apply time (generation, seq, page index) may appear in a key the client must
declare, unless the client can bound it; that rule shapes `Order` (§3). Keys use the
idiomatic `DataKey` pattern (cf. soroban-examples' token contract): one
`#[contracttype]` enum, variant name as type tag, coordinates as fields. The tag keeps
same-shaped types (BestTick vs TickSummary, Level vs TickWord) from colliding in the
shared key space; `Config` is a unit variant so the instance entry has a proper key
too. Full-word variant names cost a few bytes more per key than single characters, but
fixed per-key framing (~50–90 B: contract address, envelope) dwarfs that; legibility in
explorers and test dumps wins. The same rule applies to key coordinates and capacity
constants: `market`, `word`, `page`, `INLINE_SLOTS`, `PAGE_SLOTS` — never `mkt`, `w`,
`p`, `N`, `P`.

**The order store is authoritative; the tick index is derived.** The order store —
the level queue (§2), `Order` (§3), `FeeAccrual` (§4) — is the source of truth and
funds-bearing: strict invariants, never stale. The tick index (§5) holds no funds and
only decides how quickly matching finds the next live tick, so an error there costs a
wasted step on the walk, never a wrong settlement. That is why the store carries the
hard rules (never delete a `Level`; never read past `tail_seq`) while the index carries
a one-directional staleness contract instead: a live level always has its bit set; a
set bit over an emptied level is tolerated and cleared by the next place that lands on
it. Configuration (§1) is money-free and admin-governed; the vault (§6) is not
PageBook's storage at all, but every settling footprint touches it.

Payload sizes are XDR-serialized targets at max occupancy; M0 size tests enforce
them. Hot entries carry a leading schema-version byte; upgraded code migrates entries
lazily on touch. Each section below specifies one structure: purpose, key and
durability, layout and target size, capacity where it has one, the invariants it owns
(indexed in §19), and its lifecycle — who creates, writes, and deletes it, and how its
TTL behaves. TTL constants and the policy summary: §18.

### 1. Configuration: `Config` and `Market`

**Purpose.** Venue-wide governance state and per-market parameters. Money-free,
admin-governed, exact at all times.

| Entry | Durability | Key | Contents | Target size |
|---|---|---|---|---|
| `Config` | instance | `Config` | admin `Address`, fee recipient `Address`, paused flag, market counter | ~150 B |
| `Market` | persistent | `Market(market_id)` | base/quote SAC addrs, lot_size, tick_size, tick band, fee bps, min/max order lots, `MAX_LEVELS_CROSSED`, `MAX_SLOTS_SCANNED`, `INLINE_SLOTS`, `PAGE_SLOTS`, `MAX_PAGES` | ~250 B |

**Mutability classes.** Market variables split by what may ever change (full analysis
in `06-slp-sensitivity.md`). Frozen forever: quantization (`lot_size`, `tick_size`,
tick band) and queue geometry (`INLINE_SLOTS`, `PAGE_SLOTS`) — slot location and price
are pure functions of them, so changing them corrupts live state. Retunable via
`set_market_caps` (§12): `MAX_LEVELS_CROSSED`, `MAX_SLOTS_SCANNED`, `taker_fee_bps`
(≤ `FEE_BPS_MAX`), `min_order_lots`/`max_order_lots`, and `MAX_PAGES` (raise-only —
existing seqs may live beyond a lowered value). `Config`'s fields change only through
the dedicated admin entry points (§12).

**Lifecycle.** `Config` is written by the constructor and by admin entry points. **No
market operation ever writes the instance entry** — this is a rule, owned here, and
§16 explains what it protects; the instance TTL is maintained out-of-band by the
`keepalive()` crank (admin ops also bump). `Market` entries are created by
`create_market` (admin-gated in v1, §12) and are per-key persistent — never an
instance-resident market table, which would be a shared-entry growth bomb that every
invocation pays to read. 120-day TTL at creation/restore; auto-restore on touch.

### 2. The level queue: `Level` and `LevelPage`

**Purpose.** One price level's FIFO queue of maker orders, stored as fixed-size
counters plus positional quantity slots. The queue records what happened at a price;
`Order` (§3) records where one maker stood in it; settlement (§7) joins the two.

| Entry | Durability | Key | Contents | Target size |
|---|---|---|---|---|
| `Level` | persistent | `Level(market, side, tick)` | packed `Bytes`: version u8, `generation:u32, head_seq:u32, tail_seq:u32, head_consumed_lots:u64, open_lots:u64`, then `INLINE_SLOTS` × qty:u64 inline slots (target 32) | ≤ 384 B |
| `LevelPage` | persistent | `LevelPage(market, side, tick, page)` | packed `Bytes`: version u8, then `PAGE_SLOTS` × qty:u64 slots (target 32). Page `page` holds seqs `INLINE_SLOTS + page·PAGE_SLOTS …` — the first seqs past the inline slots land in page 0 | ≤ 320 B |

**Packed encoding is mandatory.** `Level` and `LevelPage` are fixed-layout `Bytes`
blobs with a leading schema-version byte, not `#[contracttype]` structs — symbol-keyed
`ScVal::Map` encoding roughly 2–2.5×'s the payload (a map-encoded Level at
`INLINE_SLOTS = 32` is ~1.2 KB) and would cascade into every write-byte and ops/ledger
figure in §17. Slots store **qty only**; seq is implicit in slot position.

**Positional layout (append-only).** Within a generation, seq `s` occupies inline slot
`s` if `s < INLINE_SLOTS`, else slot `(s − INLINE_SLOTS) mod PAGE_SLOTS` of
`LevelPage((s − INLINE_SLOTS) / PAGE_SLOTS)`. Slots are never moved or compacted;
"remove head" always means counter advance, never element removal. Consumption reads
inline slots first, then pages in order. Every slot's location is a pure function of
coordinates the maker knows after resting — a settling maker names at most one
specific `LevelPage` in its footprint.

**Slot states.** A slot holding `qty > 0` at a seq in `[head_seq, tail_seq)` is
**live**. A slot zeroed by a mid-queue cancel is a **tombstone** — skipped, never
compacted. Anything at or beyond `tail_seq` is **stale** (below). Slots behind
`head_seq` are history: fully filled, never read again.

**Counters.** Three counters carry all fill history:

- `generation` — increments each time the queue resets: swept **empty** by matching,
  or reset-on-rest of a cancelled-empty level (below). Seqs restart at 0.
- `head_seq` — first seq not yet fully filled (within current generation).
- `head_consumed_lots` — lots already consumed from the head order. **Convention
  (eager advance):** `head_consumed_lots` is always strictly less than the head
  order's open qty; the moment consumption reaches it, `head_seq` advances (skipping
  consecutive tombstones reachable within entries the transaction already declared)
  and `head_consumed_lots` resets to 0.

Counters alone decide, at settle, whether any order at this level is filled, partial,
or open (§7). `open_lots` tracks live lots for aggregate-consumption checks and depth
queries (§11).

**Empty-level reset.** A rest that finds `open_lots == 0 && tail_seq > 0` MUST first
reset the queue: `generation += 1, head_seq = 0, head_consumed_lots = 0, tail_seq = 0`.
This is safe: at `open_lots == 0`, every seq in `[H, tail)` is a tombstone whose
`Order` was already deleted at cancel, and every seq `< H` is fully filled — bumping G
turns their settlements into §7's `g < G` row, which pays them identically. Without
this rule, a level emptied by *cancels* (matching never sweeps it) accumulates
`tail_seq` forever and eventually returns `LevelFull` at an empty price — a permanent
DoS on that tick. (ADR-002 finding 2.)

**Capacity.** One generation holds `LEVEL_CAP = INLINE_SLOTS + PAGE_SLOTS × MAX_PAGES`
seqs; rests beyond that fail with `LevelFull` (recoverable via the empty-level reset).
Deep single-level queues are the only case that grows footprint per maker *count* —
bounded by `PAGE_SLOTS` per entry.

**Stale-slot rule (page reuse).** `LevelPage` keys do not include the generation, and a
generation reset does not clear old pages — stale slot data from a prior generation can
sit under a live key. Therefore: a slot is meaningful **iff its seq < tail_seq of the
current generation**; appends write slots strictly sequentially with no gaps; readers
MUST ignore everything at or beyond `tail_seq`. This is invariant 9 and gets its own
tests (generation reset over dirty pages, then reuse).

**Owned invariants** (§19): **2** — `open_lots` == Σ live queue qtys (inline + pages,
tombstones excluded, stale slots excluded per invariant 9); **9** — the stale-slot
rule above.

**Lifecycle.** A `Level` is created by the first rest at its tick and rewritten ever
after — **never deleted** (counters must survive for settlement; cold levels sleep in
the archive — archival IS the garbage collector, and restore-on-touch is the designed
lifecycle; the generation survives restore). Re-activating a swept tick is therefore a
rewrite, not a create. Pages wholly behind `head_seq` MAY be deleted by the operation
that advances past them (settlement never reads slots — it derives from counters +
`Order.qty`), so live pages are bounded by queue *depth*, not by history. 120-day TTL
at creation/restore; whoever restores pays the next chunk.

### 3. `Order`

**Purpose.** The maker's claim: one entry per resting order, holding the coordinates
that settlement (§7) checks against the level's counters. The queue (§2) is keyed by
position in the book and shared by every maker at that price; `Order` is keyed by
ownership and belongs to one maker — settlement is the join between them.

| Entry | Durability | Key | Contents | Target size |
|---|---|---|---|---|
| `Order` | persistent | `Order(market, owner, nonce)` | side, tick, generation, seq, qty_lots | ≤ 160 B |

**Identity.** An order's handle is `(owner, nonce)` — the nonce is chosen by the
client *before* submission, so the `Order` key is declarable at simulation time no
matter what the book does in flight. The queue coordinates `(side, tick, generation,
seq)` are assigned at execution, stored *inside* the entry (contents never affect the
footprint), and reported in the `rested` event. Rest fails with `OrderExists` if the
nonce is live; nonces are reusable after settle. (Keying `Order` by
`(generation, seq)` — round-1's design — was unsound: any concurrent rest at the same
level moves `tail_seq`, any concurrent sweep bumps `generation`, and the simulated key
is wrong. See ADR-003.)

**Fixed size.** The layout is fixed-size so a rewrite never changes the entry size —
the property that makes `replace` rent-free (§10).

**Lifecycle.** Written at rest (the maker pays its 120-day rent — the dominant
per-order cost, §17); the maker MAY `extend_ttl` to the 180-day max for long-lived
quotes. **Rewritten in place by `replace`** (§10). Deleted at settle. An order older
than ~120 days unsettled has an archived `Order`; the settle transaction auto-restores
it (P23), paying its next rent chunk — acceptable because settling is the entry's last
act.

### 4. `FeeAccrual`

**Purpose.** Accrued protocol fees per market and token, awaiting collection. This is
money, so it belongs to the order store, not to configuration.

| Entry | Durability | Key | Contents | Target size |
|---|---|---|---|---|
| `FeeAccrual` | persistent | `FeeAccrual(market, token)` | accrued protocol fees (i128) | ~50 B |

**Lifecycle.** Written by every taker operation with the fee of §0.2 (the system's
only rounding; dust accrues here) — RW in every taker footprint. Drained to the fee
recipient by the `collect_fees` crank (§12). Its i128 ceiling is proved in §0.3.
Counts in conservation invariant 1 (§6). 120-day TTL at creation/restore;
auto-restore on touch.

### 5. The tick index: `BestTick`, `TickSummary`, `TickWord`

**Purpose.** Find the next tick with liquidity without scanning the band. Derived and
money-free — staleness is allowed, each tier in one known direction, healed lazily by
the next place that walks through.

| Entry | Durability | Key | Contents | Target size |
|---|---|---|---|---|
| `BestTick` | persistent | `BestTick(market, side)` | best tick (u32), empty flag | ~40 B |
| `TickSummary` | persistent | `TickSummary(market, side)` | summary bitmap: bit `word` = "`TickWord(word)` has any set bit" (2,048 words) | 256 B |
| `TickWord` | persistent | `TickWord(market, side, word)` | presence bitmap for ticks `[word·2048, (word+1)·2048)` | 256 B |

**Coverage.** The bitmap hierarchy covers `2048 × 2048 ≈ 4.19M` ticks per side per
market — the market's tick band MUST fit inside one TickSummary entry (plenty at sane
tick sizes; wider-range assets choose a coarser `tick_size` or a geometric-tick market
type, out of scope for v1, §20).

**Staleness contract (owned invariant 3, §19).** `open_lots > 0` ⇒ bitmap bit set.
The converse is deliberately weak: a stale set bit over an empty level is permitted
(cancel-to-empty is O(1) and does not walk bitmaps or move `BestTick`) and is cleared
lazily by the next place that takes through it. `BestTick` is never *worse* than the
true best set tick; matching may walk forward from it.

**Lifecycle.** Bits are set by rests that give a tick liquidity (§9), cleared by
sweeps — or lazily, on the walk (§8). `BestTick` moves toward the book on rest and
away from it on take. 120-day TTL at creation/restore; auto-restore on touch.
Staleness is benign because the index carries no funds: a stale bit costs one extra
step on the walk, and the place that lands on it clears it (§8). Archival is benign
for the same reason: a word comes back on restore exactly as last written, and every
write that gives a tick liquidity touches its word, so the hard direction of the
contract holds across the gap.

### 6. The vault

**Purpose.** Escrow. The contract holds maker deposits and taker payments in its own
SAC balances; every settling operation moves tokens to or from it, and nothing else
holds funds.

| Entry | Durability | Key | Contents | Size |
|---|---|---|---|---|
| SAC balance | persistent (owned by the token contract) | `Balance(pagebook_address)` inside each token's SAC | i128 balance | SAC-defined (~100 B) |

One balance entry per token, keyed by PageBook's own address inside the token
contract; PageBook neither defines nor encodes it. Bids escrow quote
(`qty × t × tick_size`); asks escrow base (`qty × lot_size`). Token movement is SAC
`transfer` only, to and from the vault — no synchronous calls out to untrusted
contracts.

**Owned invariant (§19): 1** — conservation: vault balance per token == Σ open escrows
+ Σ unclaimed proceeds + accrued fees (across all markets).

**Lifecycle.** The balance entry is created by the first transfer into the vault for
that token and never deleted while a market uses the token. Its TTL and archival are
the SAC's: it is a persistent entry restored on touch, and the toucher pays; in
practice it is touched every ledger the market is active. It appears in every settling
footprint (place, settle, replace, route, collect_fees), which makes it the true
serialization point of the system (§16).

## Part II — Processes

Part II has three kinds of section, and the template differs by kind:

- **Mechanisms** (§7 settlement, §8 the walk, §9 rest, §10 replace): algorithm,
  degradation and failure modes, owned invariants, resource budget line. Mechanisms do
  not authenticate or declare footprints — the entry point that invokes them does.
- **Entry points** (§11 views, §12 the state-changing surface): authorization,
  inputs, which mechanisms compose, declared footprint by pointer, per-op rules.
- **The client's half** (§14): the padding protocol, and events (§13) as the contract's
  output surface.

Vocabulary the mechanism sections use before §14 defines it fully: the client declares
a **band** — every `Level` key in a contiguous tick range from the simulated best to a
chosen `pad_end` — plus **windows**: for each set level, a small range of `LevelPage`
keys around the simulated head, and for the taker's own rest, an **append window** of
pages around the simulated tail. Execution treats a window edge like a loop cap, never
a trap: caps and windows end loops gracefully with progress persisted; only walking
past `pad_end` traps.

### 7. The settlement state machine

Runs inside `settle` and `replace` (§10, §12). For an order with stored coordinates
`(side, tick, generation g, seq s, qty q)` against `Level(side, tick)` with state
`(G, H, C)`:

| Condition | State | Settlement |
|---|---|---|
| `g < G` | fully filled | pay `q` at tick price |
| `g == G`, `s < H` | fully filled | pay `q` at tick price |
| `g == G`, `s == H` | partially filled `C` | pay `C` at tick price; refund `q − C`; advance `H` (eagerly, past consecutive tombstones in declared entries), reset `C` |
| `g == G`, `s > H` | open | refund `q`; zero its queue slot (tombstone) |

Then delete `Order`, emit `settled`. O(1), ~3 writes. Because every take at a level
happens at exactly the tick price, *when* it happened is irrelevant — counters are a
complete proof. This re-derives Deepstate's "absent from tree ⇒ fully filled" claim at
stable keys, and is the direct replacement for Phoenix seats / DeepBook settled-owed
ledgers with **zero maker-related writes during matching**.

**Failure modes.** `UnknownOrder` if no `Order(market, owner, nonce)` is live;
`NotOwner` if the authenticated address is not the key's owner. There is no cap or
window to hit: the machine touches `Order`, one `Level`, and at most one `LevelPage`
(the head's, if the `s == H` row must advance into pages).

**Owned invariant (§19): 4** — settlement is exact and path-independent: any
interleaving of takes and settles ending in the same counters pays the same amounts
(single-price levels make this provable).

**Budget** (§17): `settle` ≈ 9 footprint entries, ~3–4 writes, ~0.6 KB, **~0.002
XLM** — no rent; it only deletes and rewrites.

### 8. The matching walk (the taker path)

The body of `place`; `route` runs it once per leg (below). Sweeping a level never
reads its slots (`open_lots × tick × tick_size` is exact), so the only slot access in
matching is partial consumption at the final level, and the only slot *write* outside
it is the taker's own rest. Both are bounded by client-declared windows (§14):

```
place(taker, market, side, limit_tick, qty_lots, start_tick, nonce, window, flags):
  # start_tick = the client's simulated best opposite tick. Matching never visits
  # ticks BETTER than start_tick: an order rested at a better price between
  # simulation and inclusion is simply unreachable by this place — it cannot make
  # the tx read an undeclared key, so it cannot fail the tx.
  # window = the slot access the client declared pages for: per-band-level page
  # ranges for consumption, plus the append range for the taker's own rest.
  # flags = post_only | fill_or_kill | no_rest
  best = worse_of(BestTick(opposite), start_tick)   # bitmap walk from start_tick if needed
  while qty_lots > 0 and best crosses limit_tick
        and levels_crossed < MAX_LEVELS_CROSSED
        and slots_scanned < MAX_SLOTS_SCANNED:
    lvl = Level(opposite, best)
    if lvl.open_lots == 0:                     # stale bit (lazy clear — §19 inv. 3)
      clear bit in TickWord/TickSummary; best = next_set_tick(); continue   # counts as a crossed level
    if lvl.open_lots <= qty_lots:              # sweep whole level — no slot reads
      qty_lots -= lvl.open_lots
      quote += lvl.open_lots * best * tick_size
      lvl.generation += 1; reset queue          # ONE small write; orders abandoned
      clear bit in TickWord(word(best)) [and TickSummary if word empties]
      best = next_set_tick(TickWord/TickSummary)               # bitmap walk, reads only
    else:                                       # partial: advance head
      if head slot lies outside window[best]: break   # graceful stop, like a cap
      consume from head (skip tombstones; bounded by MAX_SLOTS_SCANNED and window)
      update head_seq/head_consumed_lots/open_lots  # progress persists even if cap hit
      quote += consumed * best * tick_size      # ONE small write; loop ends
  if qty_lots > 0:
    fill_or_kill ⇒ fail Unfilled; post_only + crossed ⇒ fail Crossed
    if no_rest, or loop terminated by a cap or window edge while the book still crosses limit_tick:
      refund remainder                          # NEVER rest a crossing order (inv. 8)
    else: rest remainder at limit_tick (append must land in window — §9)
  transfer: SAC moves taker↔vault (base, quote)
  fee = ceil(taker_output × fee_bps / 10_000) → FeeAccrual(token)   # the only rounding (§0.2)
  update BestTick(opposite) if moved; emit filled/swept per level, top_changed if moved
```

**Degradation: the bounded tombstone scan.** Tombstones (§2) are skipped when the head
advances, but the scan is bounded: a place scans at most `MAX_SLOTS_SCANNED` slots
total, and head advancement is **always persisted**, even when the cap ends the loop
early — cleanup cost amortizes across takers instead of repeating for each one.
Without this bound, an attacker rests K dust orders, cancels the middle, and poisons
the best price with a scan bounded only by history. (`min_order_lots` raises the cost
of that attack; the scan cap removes the damage.) The other degradations are in the
pseudocode: `MAX_LEVELS_CROSSED`, a window edge at the partial level, and a stale bit
each end or skip a step with progress persisted; a remainder that still crosses is
refunded, never rested.

**Multi-leg composition: `route(legs[])`.** Sequential walks across markets, deltas
netted in invocation memory, one SAC transfer per token at the end. **Route caps are
per-transaction, not per-leg:** `legs.len() ≤ MAX_ROUTE_LEGS`, and one shared
`MAX_LEVELS_CROSSED` / `MAX_SLOTS_SCANNED` budget spans all legs — so a route's
worst-case writes, events, and footprint are the same as a single maximal place plus
per-leg constants, and the §0.3 creation bound already reserves `MAX_ROUTE_LEGS`
headroom for the netted transfers. Legs are placed in order; a leg's failure fails the
route.

**Owned invariants (§19): 5** — price-time priority, scoped by `start_tick`: takes
consume strictly best-tick-first among ticks at-or-worse than `start_tick`, FIFO
within level (tombstones skipped); orders rested at better ticks after simulation keep
their place — they are not consumed and not harmed. **7** — every loop is bounded by a
config constant (`MAX_LEVELS_CROSSED`, `MAX_SLOTS_SCANNED`, `MAX_ROUTE_LEGS`,
`MAX_REPLACE_BATCH`, `INLINE_SLOTS`, `PAGE_SLOTS`, `MAX_PAGES`) — route caps shared
across legs, not multiplied by them. **8** (shared with §9) — the book is never
crossed after any operation completes: a matching loop terminated by a cap or window
refunds its remainder.

**Budget** (§17): take-only, 8 levels swept ≈ 55 footprint / ~21 writes / ~6 KB /
**~0.009 XLM**; maximal take (32 levels, 32 distinct `TickWord` entries) ≈ 85 + pad /
~70 writes / ~22 KB / **~0.027 XLM** (arithmetic in §17).

### 9. Rest (append)

Rests the remainder of a take, or a pure maker order; also the second half of
`replace` (§10). Enforce `[min_order_lots, max_order_lots]` (`QtyOutOfBounds`); fail
`OrderExists` if `Order(owner, nonce)` is live; apply the empty-level reset (§2) if
due; assign `seq = tail_seq++` (fail `LevelFull` at `LEVEL_CAP`); the slot for `seq`
must be inline or in a page inside the declared append window — if a concurrent rest
pushed the tail past it, fail with the typed error `RetryRest` (graceful; client
re-simulates), never a footprint trap. Write the qty slot (create the level and set
`TickWord`/`TickSummary` bits if new); if the tick is better than the recorded
`BestTick(side)`, move it and emit `top_changed`; write `Order(owner, nonce)`; escrow
via one SAC transfer; emit `rested`.

The append window is cheap to make safe: `{page(tail_sim), page(tail_sim)+1, page 0}`
covers concurrent same-level rests up to a full page (`PAGE_SLOTS` orders) *and* a
concurrent sweep or reset (which sends the tail back toward 0).

**Post-only semantics (deliberately conservative).** A post-only rest compares its
tick against the recorded `BestTick(opposite)` **as stored** — one read,
footprint-stable. If it would cross the recorded best, it fails `Crossed`, *even if
that best is a stale bit over an emptied level*. Because `BestTick` is never worse
than the true best (inv. 3), this check can false-reject near stale state (until the
next place that takes there cleans it) but can never rest a truly crossing order.
Trying to be smarter — walking past stale levels to find the "true" best — would
either widen the footprint unboundedly or create a crossed book; both are forbidden
(invariant 8's fail-closed half).

**Budget** (§17): rest at an existing level ≈ 12 footprint / ~5 writes / ~0.9 KB /
**~0.029 XLM** (dominated by `Order` rent); first touch / restore of a tick ≈ 14 / ~7
/ ~1.2 KB / **~0.094 XLM** (adds `Level` rent).

### 10. Replace: the maker update path

`replace(owner, nonce, side, tick, qty)` settles the old order exactly per §7's claim
table (pay what filled, refund what didn't, tombstone the slot), then rewrites the
**same `Order` in place** with the new coordinates and appends at the new tick under
the normal rest rules (§9: bounds, append window, `LevelFull`, empty-reset). Because
the entry is reused at fixed size (§3), **no rent is charged**: the maker's nonce is a
durable quote slot whose 120-day rent amortizes across every update. Replace never
takes liquidity: it applies §9's conservative post-only check against recorded
`BestTick` and fails `Crossed` instead. And it is atomic — the maker is never unquoted
between the settlement and the re-rest, which a settle-then-place pair cannot
guarantee. Escrow moves as a single *delta* (new escrow − refund − proceeds), netted
per token.

**`replace_batch(items[])`** — ≤ `MAX_REPLACE_BATCH` items, settlement deltas netted
in invocation memory, one transfer per token at the end. A full book refresh is one
transaction. Failure of any item fails the batch (all-or-nothing).

**Failure modes.** Everything §7 and §9 can raise (`UnknownOrder`, `NotOwner`,
`QtyOutOfBounds`, `LevelFull`, `RetryRest`, `Crossed`); `Paused` — replace contains a
rest, so it pauses with the entry side of the book (§12).

**Budget** (§17): one quote ≈ 14 footprint / ~8 writes / ~1.5 KB / **~0.003 XLM**,
zero rent; a 40-quote full refresh ≈ 130 / ~90 / ~24 KB / **~0.03 XLM**. Why this
matters — settle+place would re-pay ~0.027 XLM of `Order` rent per update — is the
second reading in §17 and ADR-005.

### 11. Views (read-only)

Read-only entry points for routers and UIs; none writes, so their footprints are
declared as read-only and never conflict.

- `best(market, side) → Option<tick>` — reads `BestTick` as stored (subject to the
  §5 staleness contract).
- `level(market, side, tick) → LevelInfo` — counters and `open_lots` (depth) from one
  `Level`.
- `order(market, owner, nonce) → OrderInfo` — the stored coordinates plus a settlement
  preview: §7's table evaluated read-only against the current counters.
- `quote_place(market, side, limit_tick, qty) → QuoteResult` — the **simulate** step
  of the client's protocol (§14): walks the book read-only and returns the
  `start_tick`, the crossed ticks, and the band and slot windows the client should
  declare. Its exact return shape is an implementer decision (05 open questions).

### 12. Entry points, authentication, administration, cranks

Every state-changing entry point authenticates, explicitly:

| Entry point | Auth | Composes | Declared footprint | Blocked by pause |
|---|---|---|---|---|
| `place` | `taker.require_auth()` | walk (§8) + rest (§9) | band + windows + own rest keys (§14) | yes |
| `route` | `taker.require_auth()` | walk per leg (§8) | per-leg bands, split across the 400-entry budget (§14) | yes |
| `settle` | `owner.require_auth()` | settlement (§7) | `Order`, its `Level`, at most one `LevelPage`, both vault balances | **never** |
| `replace` / `replace_batch` | `owner.require_auth()` | settlement (§7) + rest (§9) per item (§10) | union of settle's and rest's keys per item | yes |
| `create_market` | `admin.require_auth()` | — | new `Market`, `Config` read | — |
| `set_admin`, `set_fee_recipient`, `set_paused`, `upgrade` | `admin.require_auth()` | — | `Config` (write) | — |
| `set_market_caps` | `admin.require_auth()` | §0.3 re-proof | one `Market` | — |
| `collect_fees` | none | — | `FeeAccrual`, one vault balance, recipient's balance | **never** |
| `keepalive` | none | — | instance + code TTL bump | — |

Views (§11) authenticate nothing and write nothing.

- **`create_market`** — admin-gated in v1 (permissionless creation deferred, §20).
  Enforces `tick_min ≥ 1` (§0.2), the §0.3 creation bounds, and
  `taker_fee_bps ≤ FEE_BPS_MAX`; assigns the next `market_id` from `Config`'s counter.
  ~0.043 XLM, dominated by `Market` rent (§17).
- **Cranks.** `collect_fees(market, token)` pays the accrued `FeeAccrual` to the fee
  recipient; ALWAYS works, under any admin state. `keepalive()` bumps the instance TTL
  out-of-band (~2.3 XLM per ~120 days, mostly wasm code-entry rent, §17) — anyone may
  crank it; admin ops also bump. Market ops never write the instance entry (§1).
- **Initialization is the constructor.** `__constructor(admin, fee_recipient)` runs
  atomically at deploy — there is no `init` entry point and no first-caller-wins race.
- **Trust model, stated plainly:** the admin can upgrade the wasm, and an upgraded
  wasm can move the vault. Deployments that custody real value MUST put the admin
  behind a multisig/timelock; "trustless" deployments set admin to a burn address and
  accept no upgrades. This is a disclosure, not a mitigation. This contract custodies
  every maker's escrow; "no admin story" is not an option.
- **Pause blocks `place`, `route`, and `replace`. `settle` and `collect_fees` ALWAYS
  work** — funds exit is never gated, under any admin state. (`replace` contains a
  rest, so it pauses with the entry side of the book; the exit half stays available
  through `settle`.)
- **Cap retuning: `set_market_caps`.** Retunes the mutable class of §1 per market;
  every call re-runs the §0.3 overflow proof and rejects values that break it. The
  entry point exists because validators retune Soroban's limits every few months (the
  SLP process) and a contract cannot read network config — no host function exposes
  resource limits or remaining budget — so stored caps can only track the network
  through an authorized transaction. The contract can verify its own §0.3 proof
  on-chain but cannot verify caps against live limits; choosing caps that fit the
  network is the admin's job, informed off-chain. Client-side knobs (band width,
  windows, batch composition) need no retuning: clients read live config over RPC per
  transaction.
- **Upgrade.** `upgrade(wasm_hash)`; hot entries carry a schema-version byte and
  upgraded code migrates them lazily on touch (Part I intro).

### 13. Events

The contract's output surface (per tx ≤ 16,384 bytes):

| Event | Emitted by | Fields |
|---|---|---|
| `rested` | rest (§9), replace (§10) | `owner, nonce, side, tick, generation, seq` |
| `filled` | walk (§8), one per crossed level | `side, tick, lots, quote` |
| `swept` | walk (§8) | `side, tick, generation` |
| `settled` | settlement (§7), replace (§10) | `owner, nonce, filled_lots, refunded_lots` |
| `top_changed` | walk (§8), rest (§9) | `side, old, new` |

Event bytes are bounded by the same caps that bound the loops: ≤ `MAX_LEVELS_CROSSED`
take/sweep events per invocation (shared across route legs) ⇒ worst case ≈ 64 ×
~100 B ≈ 6.4 KB, asserted in tests. Top-of-book changes are events, not hooks —
Soroban cannot resource-cap an untrusted synchronous call (§20).

### 14. The client's process: simulate → pad → submit

Padding is the client/SDK's half of the protocol. All keys derive from
`(market, side, tick, word, page, owner, nonce)` — a client computes them without
chain state, before submission.

**Simulate.** Call `quote_place` (§11) or simulate locally: obtain the crossed ticks
starting at simulated best `t1`, the per-level head positions, and the tail position
at the intended rest tick. Choose a nonce that is not live for this owner (§3).

**Pad (contiguous band + slot windows).** Pass `start_tick = t1`, and declare RW:
**every `Level` key in the contiguous tick band `[t1, pad_end]`** — set or not (unset
keys cost only footprint slots) — plus the `TickWord` entries covering the band,
`TickSummary`, `BestTick`, both vault balances, `FeeAccrual`, and the slot windows: for
each *set* level in the band, pages `[page(head_sim), page(head_sim) + width]` (window
width small; unset/fresh levels need none — their queues are inline); for the taker's
own possible rest, `Order(taker, nonce)`, the rest level's bitmap words, and append
pages `{page(tail_sim), +1, 0}`. Band padding is required because a new level can
appear at *any* tick inside the walk range; window padding is required because a
concurrent take can move a head into pages, and a concurrent rest can move a tail
across a page boundary. For a `route`, split the 400-entry footprint across legs'
bands. Padding is cheap (§17): pad generously; the 400-entry cap is the constraint,
not the fee.

**Submit, and what can happen** — the contract's side of this contract is §15: only
walking past `pad_end` traps; every other race degrades gracefully or returns a typed
error the client can act on (`RetryRest` ⇒ re-simulate and resubmit; `Crossed`,
`LevelFull`, `Unfilled` ⇒ the client's call).

## Part III — System properties

### 15. Footprints: the product surface

Everything in Parts I–II exists so this section holds. Every key is computable
client-side before submission (Part I); every loop is capped (invariant 7); every
race degrades gracefully except one. Concretely:

**Failure modes, exhaustively.** A place **traps** (footprint violation) only if the
walk must pass `pad_end`. Every other race **degrades gracefully**: scan cap, level
cap, and window edges end the loop with progress persisted and the remainder refunded;
an append landing outside the window is the typed error `RetryRest`. On sparse books a
band deep enough to be safe may not fit in the 400-entry footprint; clients trade
`pad_end` against trap probability. This residual is inherent and far smaller than the
whole-book race in 02, but it is not zero — do not claim otherwise.

Declared-but-untouched entries are free apart from footprint slots. Per-transaction
limits: 400 footprint entries, 200 writes, 132 KB written; per-ledger: 286,720 write
bytes (03).

**Owned invariant (§19): 6** — no operation touches entries outside its declared key
family; window/cap edges degrade gracefully (refund / `RetryRest`), and only walking
past `pad_end` traps.

### 16. Concurrency and serialization

The honest version: the true serialization points are the vault's SAC balance entries
— one per (token, contract). Every settling op RWs one or both, so same-side rests
serialize with each other, takers serialize with both sides, and **all markets sharing
a token join one cluster** under P23/CAP-63: a venue quoted mostly in USDC is
effectively one serial cluster. v1 accepts this — the network write-bytes ceiling, not
cluster parallelism, is the binding throughput limit at current numbers (§17).
Recovering parallelism (per-market vault sub-accounts, or internal balance entries
netted at settlement edges) is an explicit v2 item (§20).

Why §1's instance rule matters: a per-op `bump_instance` would put an instance
**write** in every transaction — one global serialization point across every market
and token, silently undoing the whole analysis above. Reads of instance config are
shared read-only and do not conflict. The cluster analysis above is therefore the
whole story.

### 17. Budgets and fees

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
| place — maximal take (32 levels, 32 distinct `TickWord` entries) | ~85 + pad | ~70 | ~22 KB |

Worst-case write-byte arithmetic for the max sweep, so nobody trusts the table
blindly: 32 Level (×384 B) + 32 TickWord (×256 B) + TickSummary + BestTick +
FeeAccrual + 2 vault balances + own-rest entries ≈ 12.3 + 8.2 + 0.3 + ~1.2 KB ≈
**22 KB** and ~70 writes — within per-tx limits (400 entries / 200 writes / 132 KB)
but **7.6% of a whole ledger's 286,720 write bytes**. Typical ops are the rest/settle
rows (≤ 1 KB); the ledger sustains hundreds of those, or ~13 max sweeps, per close —
the reason every hot entry is a few hundred bytes. (SLP history suggests the ceiling
rises; per-op bytes here are ~50–100× under a whole-book-blob design.)

**Estimated resource fees per operation.** Computed from live mainnet rates (Aug 2026;
see 03 §Fees and ADR-004): instructions 7/10k stroops, 2,500 per write entry,
write/rent floor 1,000 per KB, events 5,000/KB (refundable), tx bytes ≈ 4.4 stroops
each, live reads free, and rent ≈ **1,667 stroops per byte per 120-day minimum TTL**.
Instruction counts are rough (±3×) but immaterial — **rent on newly created entries
dominates everything else**:

| Op | Est. resource fee | Dominated by |
|---|---|---|
| place — rest only (existing level) | **~0.029 XLM** | `Order` rent (160 B × 120 d ≈ 0.027) |
| place — rest only (first touch / restore of a tick) | **~0.094 XLM** | + `Level` rent (384 B ≈ 0.064) |
| settle | **~0.002 XLM** | write entries; no rent (only deletes/rewrites) |
| replace (one quote; entry reused) | **~0.003 XLM** | write entries; zero rent |
| replace_batch (40-quote full refresh, one tx) | **~0.03 XLM** | write entries (~90 × 2,500) |
| place — take only, 8 levels swept | **~0.009 XLM** | write entries + tx size |
| place — take 8 levels + rest remainder | **~0.037 XLM** | the remainder's `Order` rent |
| place — maximal take (32 levels) | **~0.027 XLM** | write entries (70 × 2,500) |
| `create_market` | **~0.043 XLM** | `Market` rent |
| `collect_fees` | **~0.001 XLM** | — |
| `keepalive` (whole venue, per ~120 d) | **~2.3 XLM** | wasm code-entry rent (~40 KB at ⅓ discount) |

Readings, in design terms:

- **Matching is nearly free; placement pays rent.** A 32-level sweep costs about the
  same as one `Order`. The book's carrying cost sits with makers at ~0.027 XLM per
  open order per 120 days — an anti-spam economics that arrives for free and stacks
  with `min_order_lots` (a dust-storm of K orders now has a hard cost of ~0.027 K XLM,
  non-refundable).
- **Churn is priced separately from holding — use `replace`.** Updating a quote via
  settle+place re-creates the `Order` and re-pays its rent every time (~0.031
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

### 18. TTL and archival: policy summary

Mainnet's minimum persistent TTL is **2,073,600 ledgers (~120 days)**, charged as rent
at creation/restore; the maximum is ~180 days (03 §Storage). That makes the policy
almost entirely passive — entries live in prepaid 120-day chunks, and **no hot path
ever extends a TTL** (matching, resting, and settling pay zero rent on existing
entries). Per-structure lifecycles are specified in Part I; the summary:

| Entry | TTL comes from | On archival (~120 d idle) |
|---|---|---|
| `Config` (instance) + wasm code | permissionless `keepalive()` crank + admin ops — **never market ops** | crank restores (~2.3 XLM/120 d, mostly code rent) |
| `Market`, `BestTick`, `TickSummary`, `TickWord`, `Level`, `LevelPage`, `FeeAccrual` | 120-d minimum at creation/restore; whoever restores pays the next chunk | auto-restore on touch (generation survives) |
| `Order` | 120-d minimum at rest (maker pays); maker MAY `extend_ttl` to the 180-d max for long-lived quotes | the settling maker auto-restores; costs land on beneficiary |
| Vault SAC balances (§6) | the token contract's policy; touched by every settling op | auto-restore on touch; toucher pays (in practice never idle while a market is active) |

Requirements: **never `del` a `Level`** (§2 — archival IS the garbage collector).
Pages behind the head and `Order` on settle ARE deleted (their lifecycles are done).
Temporary storage is allowed only for lossless-if-lost data (e.g., optional
time-in-force expiry index) — never for funds-bearing state.

### 19. Invariants (must hold; property-test all)

The canonical numbered index. Each invariant is stated in context in the section that
owns it; property tests cite these numbers.

1. Conservation: vault balance per token == Σ open escrows + Σ unclaimed proceeds +
   accrued fees (across all markets). *(§6)*
2. `open_lots` == Σ live queue qtys (inline + pages, tombstones excluded, stale slots
   excluded per invariant 9). *(§2)*
3. `open_lots > 0` ⇒ bitmap bit set. The converse is deliberately weak: a stale set
   bit over an empty level is permitted (cancel-to-empty is O(1) and does not walk
   bitmaps or move `BestTick`) and is cleared lazily by the next place that takes
   through it. `BestTick` is never *worse* than the true best set tick; matching may
   walk forward from it. *(§5)*
4. Settlement is exact and path-independent: any interleaving of takes and settles
   ending in the same counters pays the same amounts (single-price levels make this
   provable). *(§7)*
5. Price-time priority, scoped by `start_tick`: takes consume strictly best-tick-first
   among ticks at-or-worse than `start_tick`, FIFO within level (tombstones skipped).
   Orders rested at better ticks after simulation keep their place; they are not
   consumed and not harmed. *(§8)*
6. No operation touches entries outside its declared key family; window/cap edges
   degrade gracefully (refund / `RetryRest`), and only walking past `pad_end` traps.
   *(§15)*
7. Every loop is bounded by a config constant (`MAX_LEVELS_CROSSED`,
   `MAX_SLOTS_SCANNED`, `MAX_ROUTE_LEGS`, `MAX_REPLACE_BATCH`, `INLINE_SLOTS`,
   `PAGE_SLOTS`, `MAX_PAGES`) — route caps shared across legs, not multiplied by
   them. *(§8)*
8. The book is never crossed after any operation completes: a matching loop terminated
   by a cap or window refunds its remainder; post-only compares against recorded
   `BestTick` and fails closed. *(§8, §9)*
9. Slot validity: a queue slot is meaningful iff `seq < tail_seq` of the current
   generation; appends are gapless and sequential; stale page contents from prior
   generations are never observable through any public path. *(§2)*

### 20. Non-goals / deferred

- **Global orders** (Manifest-style cross-market capital): reintroduces third-party
  vault entries into taker footprints and sim-to-apply races; v2 at most, with bounded
  global makers per level and skippable-order semantics.
- **Per-market vault sub-accounts** (or internal balance accounting netted at
  settlement edges) to break the shared-token serialization cluster (§16); v2.
- **Permissionless market creation** with an anti-spam fee (§12); v2.
- **Synchronous hooks**: impossible to sandbox (no per-call cap); events instead.
- **Geometric-tick market type** using Liquidity Book's `(1+step)^id` map — changes
  only the id→price function (bitmaps/levels/settlement untouched), removes the
  per-market tick-band config, and makes a fixed-width pad band a constant percentage
  depth; see `01-prior-art.md` §Liquidity Book. v2.
- **Pooled (pro-rata) levels** — LB-style fungible per-`(level, generation)` shares as
  a sibling market type: deletes pages/tombstones/windows/`Order` (whose rent is the
  dominant per-order cost, ADR-004) at the price of time priority within a level. MUST
  keep generation-on-sweep for fill finality (final order states without keepers). v2.
- **Volatility-scaled taker fee** (LB surge pricing): the matching loop already counts
  crossings and `FeeAccrual` is already RW — zero added footprint; costs `quote_place`
  exact fee determinism. v2, decision note required.
- **Self-trade prevention, oracle-pegged orders, batch-auction market type**
  (SPEEDEX-flavored sibling for hot markets): design notes exist in
  `01-prior-art.md`; not v1.
