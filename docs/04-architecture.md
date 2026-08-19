# PageBook architecture

*Normative design. MUST/never statements are requirements; numbers marked "target" are
tunable via config or measurement. Rationale lives in docs 01-03.*

*The document is organized around the system's data structures and the processes that
act on them: §0 states the model and the arithmetic it stands on; Part I (§1-§6)
specifies each storage structure, including its layout, invariants, and lifecycle, in one place;
Part II (§7-§14) specifies the mechanisms, the entry points that compose them, and the
client's half of the protocol; Part III (§15-§20) states what emerges from their
composition. Invariant numbers (1-9, indexed in §19) are stable across the document.*

## Part 0: Foundations

### 0.1 Model and vocabulary

One contract hosts many **markets**. A market is a token pair, two *distinct* SAC
addresses, `base` and `quote`, in that semantic order (asks escrow base, bids escrow
quote; the pair is not sorted lexicographically), plus quantization params. Several
markets MAY share a pair with different quantization; there is no pair index and no
duplicate-pair check (creation is admin-gated in v1, §12). Each market has two **sides** (bids, asks) of price **levels**;
each level is a FIFO queue of maker orders at exactly one price. Takers cross the book
and settle atomically; makers rest, then later **settle**, one exit that pays whatever
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
  *cancels* it (tombstones its slot); settling a filled order *claims* its proceeds,
  "cancel" and "claim" name outcomes of `settle`, not operations.

### 0.2 Quantization (exactness by construction)

- `lot_size`: base atoms per lot (u64 lots on the book).
- `tick_size`: quote atoms per (base lot) per tick.
- Price of tick `t` (u32, band-limited by market config `[tick_min, tick_max)`,
  `tick_min ≥ 1`, tick 0 would admit zero-price, zero-escrow orders):
  `t × tick_size` quote atoms per base lot.
- Quote value of a take = `qty_lots × t × tick_size`, **integer, exact**. There is no
  rounding anywhere in the matching path; Deepstate's correction-code machinery is
  unnecessary. All intermediate math in i128 (checked). The **only** rounding in the
  system is the taker fee, `ceil(output × fee_bps / 10_000)`, rounds up, dust
  accrues to `FeeAccrual`. It MUST be computed in the split form
  `fee = (output ÷ 10_000) × fee_bps + ceil((output mod 10_000) × fee_bps / 10_000)`,
  which is arithmetically identical but never forms an intermediate larger than
  `output` (the first term is ≤ `output` because `fee_bps ≤ 10_000`; the second is
  < 10⁸). The naive form multiplies `output` by up to `FEE_BPS_MAX` first and would
  need that factor of headroom in the §0.3 proof.

### 0.3 Bounds (proved at creation, not checked per trade)

`create_market` MUST enforce, with `LEVEL_CAP = INLINE_SLOTS + PAGE_SLOTS × MAX_PAGES`
(max orders per level-generation):

- `LEVEL_CAP × max_order_lots × tick_max × tick_size ≤ i128::MAX / (4 × MAX_ROUTE_LEGS)`,
  which covers one order, one full level, one max sweep, and a max route's per-token
  netting, with 4× slack for sums. Fee math needs no headroom: §0.2's split form never
  exceeds `output`. (A taker's aggregate quote is bounded by its own `qty_lots`, which
  is itself ≤ `max_order_lots`.)
- `LEVEL_CAP × max_order_lots × lot_size ≤ i128::MAX / (4 × MAX_ROUTE_LEGS)`, same
  proof for the base side (escrow and level totals).
- `taker_fee_bps ≤ FEE_BPS_MAX` (config constant, e.g. 1,000 = 10%), `FeeTooHigh`.
- `1 ≤ tick_min < tick_max ≤ 2^22`, the tick index covers ticks `[0, 2^22)` per side
  (§5); a band outside it has ticks whose bits have nowhere to live, `TickOutOfBand`.
- `base ≠ quote`, `SameToken`.

Any order or taker quantity outside `[min_order_lots, max_order_lots]` is rejected,
the floor is the dust-order defense, the ceiling is half the overflow proof.
`FeeAccrual(token)` accrues in i128; its ceiling is total token supply, which SAC bounds
below i128 by construction. Config constants that bound loops but are not per-market:
`MAX_ROUTE_LEGS` (target 4) and `MAX_REPLACE_BATCH` (40: a replace item's two events
measure ~340 B together, so 40 items are ~13.9 KB of the 16,384-byte event budget
(§13) and 64 would exceed it; 40 items on dispersed levels are ~170 footprint entries
and ~164 writes, inside the 400 / 200 caps, ADR-024).

### 0.4 Actors

- **Maker, taker:** the on-book roles (§0.1).
- **Client (SDK):** simulates, chooses nonces, computes and pads footprints before
  submission (§14). Padding is a client responsibility, not contract logic.
- **Admin:** governs the configuration structures (§1) through authenticated entry
  points (§12); the trust model is stated there.
- **Cranker:** anyone; runs the permissionless cranks (`collect_fees`, `keepalive`),
  whose effects are defined by config, not caller (§12).

## Part I: Data structures

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
fixed per-key framing (~50-90 B: contract address, envelope) dwarfs that; legibility in
explorers and test dumps wins. The same rule applies to key coordinates and capacity
constants: `market`, `word`, `page`, `INLINE_SLOTS`, `PAGE_SLOTS`, never `mkt`, `w`,
`p`, `N`, `P`.

**The order store is authoritative; the tick index is derived.** The order store,
the level queue (§2), `Order` (§3), `FeeAccrual` (§4), is the source of truth and
funds-bearing: strict invariants, never stale. The tick index (§5) holds no funds and
only decides how quickly matching finds the next live tick, so an error there costs a
wasted step on the walk, never a wrong settlement. That is why the store carries the
hard rules (never delete a `Level`; never read past `tail_seq`) while the index carries
a one-directional staleness contract instead: a live level always has its bit set; a
set bit over an emptied level is tolerated and cleared by the next place that lands on
it. Configuration (§1) is money-free and admin-governed; the vault (§6) is not
PageBook's storage at all, but every settling footprint touches it.

Payload sizes are XDR-serialized targets at max occupancy; M0 size tests enforce
them. Packed entries carry a leading schema-version byte as a guard against misreading
a layout (a mismatch is a typed error, never a silent decode). Each section below specifies one structure: purpose, key and
durability, layout and target size, capacity where it has one, the invariants it owns
(indexed in §19), and its lifecycle, who creates, writes, and deletes it, and how its
TTL behaves. TTL constants and the policy summary: §18.

### 1. Configuration: `Config` and `Market`

**Purpose.** Venue-wide governance state and per-market parameters. Money-free,
admin-governed, exact at all times.

| Entry | Durability | Key | Contents | Target size |
|---|---|---|---|---|
| `Config` | instance | `Config` | admin `Address`, fee recipient `Address`, paused flag, market counter | ~190 B (named struct; ADR-022) |
| `Market` | persistent | `Market(market_id)` | base/quote SAC addrs, lot_size, tick_size, tick band, fee bps, min/max order lots, `MAX_LEVELS_CROSSED`, `MAX_SLOTS_SCANNED`, `INLINE_SLOTS`, `PAGE_SLOTS`, `MAX_PAGES` | ~490 B (named struct; written at creation and retune only; ADR-022) |

**Mutability classes.** Market variables split by what may ever change (full analysis
in `06-slp-sensitivity.md`). Frozen forever: quantization (`lot_size`, `tick_size`,
tick band) and queue geometry (`INLINE_SLOTS`, `PAGE_SLOTS`), slot location and price
are pure functions of them, so changing them corrupts live state. Geometry is not a
`create_market` parameter: `INLINE_SLOTS` and `PAGE_SLOTS` are contract-wide
compile-time constants, copied into `Market` at creation for introspection and so a
future wasm with different constants can still decode old markets; `MAX_PAGES` starts
at the contract constant and is retunable per market. Retunable via
`set_market_caps` (§12): `MAX_LEVELS_CROSSED`, `MAX_SLOTS_SCANNED`, `taker_fee_bps`
(≤ `FEE_BPS_MAX`), `min_order_lots`/`max_order_lots`, and `MAX_PAGES` (raise-only,
existing seqs may live beyond a lowered value). `Config`'s fields change only through
the dedicated admin entry points (§12).

**Lifecycle.** `Config` is written by the constructor and by admin entry points. **No
market operation ever writes the instance entry**, this is a rule, owned here, and
§16 explains what it protects; the instance TTL is maintained out-of-band by the
`keepalive()` crank (admin ops also bump). `Market` entries are created by
`create_market` (admin-gated in v1, §12) and are per-key persistent, never an
instance-resident market table, which would be a shared-entry growth bomb that every
invocation pays to read. 120-day TTL at creation/restore; auto-restore on touch.

### 2. The level queue: `Level` and `LevelPage`

**Purpose.** One price level's FIFO queue of maker orders, stored as fixed-size
counters plus positional quantity slots. The queue records what happened at a price;
`Order` (§3) records where one maker stood in it; settlement (§7) joins the two.

| Entry | Durability | Key | Contents | Target size |
|---|---|---|---|---|
| `Level` | persistent | `Level(market, side, tick)` | packed `Bytes`: version u8, `generation:u32, head_seq:u32, tail_seq:u32, head_consumed_lots:u64, open_lots:u64`, then `INLINE_SLOTS` × qty:u64 inline slots (target 32) | ≤ 384 B |
| `LevelPage` | persistent | `LevelPage(market, side, tick, page)` | packed `Bytes`: version u8, then `PAGE_SLOTS` × qty:u64 slots (target 32). Page `page` holds seqs `INLINE_SLOTS + page·PAGE_SLOTS …`, the first seqs past the inline slots land in page 0 | ≤ 320 B |

**Packed encoding is mandatory here, and only here.** `Level` and `LevelPage` are
fixed-layout `Bytes` blobs with a leading schema-version byte, not `#[contracttype]`
structs, symbol-keyed `ScVal::Map` encoding roughly 1.5-2× the payload (a map-encoded
Level at `INLINE_SLOTS = 32` measures 440-570 B against 296 B packed) and, because
these two entries are rewritten in bulk on every take, would cascade into every
write-byte and ops/ledger figure in §17. The bitmaps (§5) are packed too, at no cost
(their payload is 256 raw bytes). Everything else, `Config`, `Market`, `BestTick`,
`Order`, `FeeAccrual`, is a plain named `#[contracttype]` struct: their extra bytes
buy nothing on the hot path (ADR-022). Slots store **qty only**; seq is implicit in
slot position.

**Positional layout (append-only).** Within a generation, seq `s` occupies inline slot
`s` if `s < INLINE_SLOTS`, else slot `(s − INLINE_SLOTS) mod PAGE_SLOTS` of
`LevelPage((s − INLINE_SLOTS) / PAGE_SLOTS)`. Slots are never moved or compacted;
"remove head" always means counter advance, never element removal. Consumption reads
inline slots first, then pages in order. Every slot's location is a pure function of
coordinates the maker knows after resting, a settling maker names at most one
specific `LevelPage` in its footprint.

**Slot states.** A slot holding `qty > 0` at a seq in `[head_seq, tail_seq)` is
**live**. A slot zeroed by a mid-queue cancel is a **tombstone**, skipped, never
compacted. Anything at or beyond `tail_seq` is **stale** (below). Slots behind
`head_seq` are history: fully filled, never read again.

**Counters.** Three counters carry all fill history:

- `generation`, increments each time the queue resets: swept **empty** by matching,
  or reset-on-rest of a cancelled-empty level (below). Seqs restart at 0. The
  increment is checked: at `u32::MAX` the reset fails `Overflow` rather than wrapping
  (a wrap would let a long-dead order's stored `g` collide with the live `G` and settle
  as open). u32 is ample: every reset costs at least one rest plus one take or cancel
  (≥ ~0.03 XLM and two transactions), so a wrap needs 2^32 of them at one tick,
  more than 10⁸ XLM and, at one reset per second, ~136 years.
- `head_seq`, first seq not yet fully filled (within current generation).
- `head_consumed_lots`, lots already consumed from the head order. **Convention
  (eager advance):** `head_consumed_lots` is always strictly less than the head
  order's open qty; the moment consumption reaches it, `head_seq` advances (skipping
  consecutive tombstones reachable within entries the transaction already declared)
  and `head_consumed_lots` resets to 0.

Counters alone decide, at settle, whether any order at this level is filled, partial,
or open (§7). `open_lots` tracks live lots for aggregate-consumption checks and depth
queries (§11): the sweep path pays `open_lots × tick × tick_size` without reading a
slot, so **every** operation that removes lots from the queue MUST decrement it,
takes (§8) by lots consumed, settles (§7) by lots refunded.

**Empty-level reset.** A rest that finds `open_lots == 0 && tail_seq > 0` MUST first
reset the queue: `generation += 1, head_seq = 0, head_consumed_lots = 0, tail_seq = 0`.
This is safe: at `open_lots == 0`, every seq in `[H, tail)` is a tombstone whose
`Order` was already deleted at cancel, and every seq `< H` is fully filled, bumping G
turns their settlements into §7's `g < G` row, which pays them identically. Without
this rule, a level emptied by *cancels* (matching never sweeps it) accumulates
`tail_seq` forever and eventually returns `LevelFull` at an empty price, a permanent
DoS on that tick. (ADR-002 finding 2.)

**Capacity.** One generation holds `LEVEL_CAP = INLINE_SLOTS + PAGE_SLOTS × MAX_PAGES`
seqs; rests beyond that fail with `LevelFull` (recoverable via the empty-level reset).
Deep single-level queues are the only case that grows footprint per maker *count*,
bounded by `PAGE_SLOTS` per entry.

**Stale-slot rule (page reuse).** `LevelPage` keys do not include the generation, and a
generation reset does not clear old pages, stale slot data from a prior generation can
sit under a live key. Therefore: a slot is meaningful **iff its seq < tail_seq of the
current generation**; appends write slots strictly sequentially with no gaps; readers
MUST ignore everything at or beyond `tail_seq`. This is invariant 9 and gets its own
tests (generation reset over dirty pages, then reuse).

**Owned invariants** (§19): **2**, `open_lots` == Σ live slot qtys − `head_consumed_lots`
(inline + pages; tombstones excluded; stale slots excluded per invariant 9; the head's
slot still stores its original qty, so its consumed part is subtracted); **9**, the
stale-slot rule above.

**Lifecycle.** A `Level` is created by the first rest at its tick and rewritten ever
after, **never deleted** (counters must survive for settlement; cold levels sleep in
the archive, archival IS the garbage collector, and restore-on-touch is the designed
lifecycle; the generation survives restore). Re-activating a swept tick is therefore a
rewrite, not a create. Pages wholly behind `head_seq` MAY be deleted by the operation
that advances past them (settlement never reads slots, it derives from counters +
`Order.qty`), so live pages are bounded by queue *depth*, not by history. 120-day TTL
at creation/restore; whoever restores pays the next chunk.

### 3. `Order`

**Purpose.** The maker's claim: one entry per resting order, holding the coordinates
that settlement (§7) checks against the level's counters. The queue (§2) is keyed by
position in the book and shared by every maker at that price; `Order` is keyed by
ownership and belongs to one maker, settlement is the join between them.

| Entry | Durability | Key | Contents | Target size |
|---|---|---|---|---|
| `Order` | persistent | `Order(market, owner, nonce)` | side, tick, generation, seq, qty_lots | ≤ 160 B |

**Identity.** An order's handle is `(owner, nonce)`, the nonce is chosen by the
client *before* submission, so the `Order` key is declarable at simulation time no
matter what the book does in flight. The queue coordinates `(side, tick, generation,
seq)` are assigned at execution, stored *inside* the entry (contents never affect the
footprint), and reported in the `rested` event. Rest fails with `OrderExists` if the
nonce is live; nonces are reusable after settle. (Keying `Order` by
`(generation, seq)` is unsound: any concurrent rest at the same level moves `tail_seq`,
any concurrent sweep bumps `generation`, and the simulated key is wrong. See ADR-003.)

**Fixed size.** The layout is fixed-size so a rewrite never changes the entry size,
the property that makes `replace` rent-free (§10).

**Lifecycle.** Written at rest (the maker pays its 120-day rent, the dominant
per-order cost, §17). The current contract has no per-order TTL extension entry point.
**Rewritten in place by `replace`** (§10). Deleted at settle. An order older
than ~120 days unsettled has an archived `Order`; the settle transaction auto-restores
it (P23), paying its next rent chunk, acceptable because settling is the entry's last
act.

### 4. `FeeAccrual`

**Purpose.** Accrued protocol fees per market and token, awaiting collection. This is
money, so it belongs to the order store, not to configuration.

| Entry | Durability | Key | Contents | Target size |
|---|---|---|---|---|
| `FeeAccrual` | persistent | `FeeAccrual(market, token)` | accrued protocol fees (i128) | ~50 B |

**Lifecycle.** Written by every taker operation with the fee of §0.2 (the system's
only rounding; dust accrues here), RW in every taker footprint. Drained to the fee
recipient by the `collect_fees` crank (§12). Its i128 ceiling is proved in §0.3.
Counts in conservation invariant 1 (§6). 120-day TTL at creation/restore;
auto-restore on touch.

### 5. The tick index: `BestTick`, `TickSummary`, `TickWord`

**Purpose.** Find the next tick with liquidity without scanning the band. Derived and
money-free, staleness is allowed, each tier in one known direction, healed lazily by
the next place that walks through.

| Entry | Durability | Key | Contents | Target size |
|---|---|---|---|---|
| `BestTick` | persistent | `BestTick(market, side)` | best tick (u32), empty flag | ~60 B (named struct; ADR-022) |
| `TickSummary` | persistent | `TickSummary(market, side)` | summary bitmap: bit `word` = "`TickWord(word)` has any set bit" (2,048 words) | 257 B payload, 268 B XDR (ADR-017) |
| `TickWord` | persistent | `TickWord(market, side, word)` | presence bitmap for ticks `[word·2048, (word+1)·2048)` | 257 B payload, 268 B XDR (ADR-017) |

**Coverage.** The bitmap hierarchy covers ticks `[0, 2048 × 2048 = 2^22)` per side per
market, the market's tick band MUST fit inside one TickSummary entry, enforced at
`create_market` as `tick_max ≤ 2^22` (§0.3, §12; plenty at sane tick sizes,
wider-range assets choose a coarser `tick_size` or a geometric-tick market type, out
of scope for v1, §20).

**Staleness contract (owned invariant 3, §19).** `open_lots > 0` ⇒ bitmap bit set.
The converse is deliberately weak: a stale set bit over an empty level is permitted
(cancel-to-empty is O(1) and does not walk bitmaps or move `BestTick`) and is cleared
lazily by the next place that takes through it. `BestTick` is never *worse* than the
true best set tick; matching may walk forward from it.

**Lifecycle.** A rest that raises a level's `open_lots` from zero sets the tick's
`TickWord` bit and its word's `TickSummary` bit, idempotently, and whether the
`Level` entry is new, swept, or cancel-emptied (§9; the hard direction of the contract
depends on this, since `Level`s are never deleted and re-liquifying a swept tick is a
rewrite). Bits are cleared by sweeps, or lazily, on the walk (§8). `BestTick` moves
toward the book on rest and away from it on take; its **empty flag** is set only when a
walk's `next_set_tick` finds no set bit on that side, and is cleared by any rest on
that side (a rest onto an empty-flagged side takes `BestTick` regardless of how the
stale recorded tick compares). After a sweep the walk moves `BestTick` to the next set
tick within `limit_tick`'s word, or to the first tick of the next word whose summary bit
is set (a bit-less tick that is still never worse than the true best), or marks the
side empty when the summary shows nothing beyond (§8). 120-day TTL at creation/restore; auto-restore on touch.
Staleness is benign because the index carries no funds: a stale bit costs one extra
step on the walk, and the place that lands on it clears it (§8). Archival is benign
for the same reason: a word comes back on restore exactly as last written, and every
write that gives a tick liquidity touches its word, so the hard direction of the
contract holds across the gap. A stale bit over an *archived* level is the one place
the two combine: the walk that lands on it restores the `Level` (~0.067 XLM, surfaced
by simulation and paid by that taker) and clears the bit, after which no walk ever
touches that level again until someone rests there, so each such bit costs at most
one restore, ever, against a seeding cost of a rest plus a cancel (§14; via `replace`
the marginal seeding cost is ~0.002 XLM at a tick that already has a `Level`, so the bound that matters is the one restore
*per bit*, not the seeder's fee, §17 "rent bounds holding, not churn").

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
`transfer` only, to and from the vault, no synchronous calls out to untrusted
contracts.

**Owned invariant (§19): 1**, conservation: vault balance per token == Σ open escrows
+ Σ unclaimed proceeds + accrued fees (across all markets).

**Lifecycle.** The balance entry is created by the first transfer into the vault for
that token and never deleted while a market uses the token. Its TTL and archival are
the SAC's: it is a persistent entry restored on touch, and the toucher pays; in
practice it is touched every ledger the market is active. It appears in every settling
footprint (place, settle, replace, route, collect_fees), which makes it the true
serialization point of the system (§16).

## Part II: Processes

Part II has three kinds of section, and the template differs by kind:

- **Mechanisms** (§7 settlement, §8 the walk, §9 rest, §10 replace): algorithm,
  degradation and failure modes, owned invariants, resource budget line. Mechanisms do
  not authenticate or declare footprints, the entry point that invokes them does.
- **Entry points** (§11 views, §12 the state-changing surface): authorization,
  inputs, which mechanisms compose, declared footprint by pointer, per-op rules.
- **The client's half** (§14): the padding protocol, and events (§13) as the contract's
  output surface.

Vocabulary the mechanism sections use before §14 defines it fully: the client declares
a **band**, every `Level` key in a contiguous tick range from the simulated best to a
chosen `pad_end`, plus **windows**: for each set level, a small range of `LevelPage`
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
| `g == G`, `s == H` | partially filled `C` | pay `C` at tick price; refund `q − C`; **`open_lots −= q − C`**; advance `H` (eagerly, past consecutive tombstones in declared entries), reset `C` |
| `g == G`, `s > H` | open | refund `q`; **`open_lots −= q`**; zero its queue slot (tombstone) |

Then delete `Order`, emit `settled`. Proceeds and refunds always go to `owner` from the
`Order` key, there is no alternate recipient. O(1), ~3 writes. Because every take at
a level happens at exactly the tick price, *when* it happened is irrelevant, counters
are a complete proof. This re-derives Deepstate's "absent from tree ⇒ fully filled"
claim at stable keys, and is the direct replacement for Phoenix seats / DeepBook
settled-owed ledgers with **zero maker-related writes during matching**. The
`open_lots` decrements in the last two rows are load-bearing: a sweep pays
`open_lots × tick × tick_size` without reading slots (§8), so lots refunded by settle
that stayed in `open_lots` would be paid out a second time from other makers' escrow.

**Failure modes.** `UnknownOrder` if no `Order(market, owner, nonce)` is live;
`NotOwner` if the authenticated address is not the key's owner. There is no cap or
window to hit: the machine touches `Order`, one `Level`, and at most one `LevelPage`
(the head's, if the `s == H` row must advance into pages).

**Stranded head (bounded advance).** The `s == H` row advances `H` only through
tombstones inside the entries settle declared, the inline slots and at most one
`LevelPage`. If a tombstone run continues past that page, `H` is left *on a tombstone*
at the boundary. This is safe and intended: every order behind it is `s > H` and
settles as open (correct, nothing behind a tombstone run has been consumed), the
tombstone's own `Order` is already deleted so nothing settles *at* `H`, and the next
take whose window covers the run skips it (bounded by `MAX_SLOTS_SCANNED`) and moves
`H` on. Settle MUST NOT widen its footprint to advance further.

**Owned invariant (§19): 4**, settlement is exact and path-independent: any
interleaving of takes and settles ending in the same counters pays the same amounts
(single-price levels make this provable).

**Budget** (§17): `settle` ≈ 9 touched entries, 5 writes, ~0.9 KB, **~0.0015
XLM**, no rent; it only deletes and rewrites.

### 8. The matching walk (the taker path)

The body of `place`; `route` runs it once per leg (below). Sweeping a level never
reads its slots (`open_lots × tick × tick_size` is exact), so the only slot access in
matching is partial consumption at the final level, and the only slot *write* outside
it is the taker's own rest. Both are bounded by client-declared windows (§14):

```
place(taker, market, side, limit_tick, qty_lots, start_tick, nonce, window, flags):
  # start_tick = the client's simulated best opposite tick. Matching never visits
  # ticks BETTER than start_tick: an order rested at a better price between
  # simulation and inclusion is simply unreachable by this place, it cannot make
  # the tx read an undeclared key, so it cannot fail the tx.
  # window = the slot access the client declared pages for: per-band-level page
  # ranges for consumption, plus the append range for the taker's own rest.
  # flags = post_only | fill_or_kill | no_rest
  best = worse_of(BestTick(opposite), start_tick)   # bitmap walk from start_tick if needed
  while qty_lots > 0 and best crosses limit_tick
        and levels_crossed < MAX_LEVELS_CROSSED
        and slots_scanned < MAX_SLOTS_SCANNED:
    lvl = Level(opposite, best)
    if lvl.open_lots == 0:                     # stale bit (lazy clear, §19 inv. 3)
      clear bit in TickWord/TickSummary; best = next_set_tick(); continue   # counts as a crossed level
    if lvl.open_lots <= qty_lots:              # sweep whole level, no slot reads
      qty_lots -= lvl.open_lots
      quote += lvl.open_lots * best * tick_size
      lvl.generation += 1; reset queue          # ONE small write; orders abandoned
      clear bit in TickWord(word(best)) [and TickSummary if word empties]
      best = next_set_tick(bounded by word(limit_tick))        # bitmap walk, reads only (below)
      if none: best = first tick of the next summary-set word, or mark the side empty if there is none
      if qty_lots == 0 or none: break
    else:                                       # partial: advance head
      if head slot lies outside window[best]: break   # graceful stop, like a cap
      consume from head (skip tombstones; bounded by MAX_SLOTS_SCANNED and window)
      update head_seq/head_consumed_lots/open_lots  # progress persists even if cap hit
      quote += consumed * best * tick_size      # ONE small write; loop ends
  if qty_lots > 0:
    fill_or_kill ⇒ fail Unfilled; post_only + crossed ⇒ fail Crossed
    if no_rest, or the recorded BestTick(opposite) still crosses limit_tick:
      refund remainder                          # NEVER rest a crossing order (inv. 8)
    else: rest remainder at limit_tick (append must land in window, §9)
  transfer: taker pays the vault the FULL escrow at limit_tick (bid: qty × limit × tick_size
            quote; ask: qty × lot_size base), a pure function of the arguments, and the
            vault pays back the unspent part and the output net of fee (below)
  fee = split-form ceil(taker_output × fee_bps / 10_000) → FeeAccrual(token)   # §0.2
  update BestTick(opposite) if moved; emit filled/swept per level, top_changed if moved
```

**The bounded scan, and where `BestTick` stands after a sweep.** `next_set_tick` never
reads a `TickWord` beyond `limit_tick`'s word, the words from `start_tick`'s to
`limit_tick`'s are part of every declared pad (§14), so the scan cannot trap, and it
runs after every sweep, the last one included. Its outcomes: the next set tick (the
walk continues, or, if the quantity is done, `BestTick(opposite)` moves there); or
nothing set up to the end of `limit_tick`'s word, in which case the walk consults only
`TickSummary` (always declared): if some word beyond has a set bit, `BestTick(opposite)`
stands on the *first tick of that word* in the walk direction, a bit-less tick, no
`TickWord` beyond the bound read, at-or-better than every live level in and beyond that
word (invariant 3), so the other side's post-only orders and replaces are not
false-rejected by a swept tick; if no word beyond has a set bit the side is marked
empty, exactly. Scanning past the limit's word would read whichever `TickWord` holds the
next set bit, possibly far past `pad_end`, and turn a completed take into a footprint
trap that anyone could arm for ~0.12 XLM by resting one min-size order at a distant
tick. Consequently the band never needs to extend beyond the deepest level a take can
*consume* plus the words through `limit_tick`'s (§14). Only a walk that began at the
recorded best moves `BestTick` (otherwise the recorded best is still live and
unvisited); an empty recorded side is never overwritten with a frontier. A walk whose
first tick is a recorded best it did not get from the client (worse than `start_tick`,
or a frontier written in flight) checks that tick's bit in its word before reading any
`Level` there, a bit-less tick outside the client's band is never read.

**Deterministic pay-in (auth).** Every SAC `transfer(user → vault, amount)` carries
`user.require_auth()` on its exact arguments, and the user's signed authorization tree
is built at simulation. A pay-in that depended on the book (the netted "what I ended
up spending") would therefore fail authorization on any race, the opposite of
graceful degradation. So the taker's pay-in is the full escrow at the limit price
(bid: `qty × limit_tick × tick_size` quote; ask: `qty × lot_size` base), knowable from
the arguments alone; what the walk did not spend and did not rest flows back out of
the vault, together with the taker's output net of fee, and the rested part stays as
the order's escrow. Pay-ins are never netted against pay-outs. Per token the flush order
is fixed: first what the vault already holds for certain (fills, and a settled order's
proceeds and refund), then the pay-in, then the unspent part of this call's own pay-in,
so a chained `route` pays a later leg with what an earlier leg bought, a `replace`
needs no liquid duplicate of escrow it already holds, and the vault is never asked to
front a user's own refund; the order depends on nothing but the call (`replace`: the
full new escrow in; the old order's proceeds and refund out; `route` / `replace_batch`:
sums of the same). Vault → user transfers need no user authorization, so they may vary
freely.

**`start_tick` validity, and "still crosses".** `start_tick` MUST lie in
`[tick_min, tick_max)`, otherwise `BadStartTick`. Every in-band value is legal: one
better than the recorded best is clamped by `worse_of`; one worse than `limit_tick`
makes the walk a no-op (a pure rest); one past the book's end simply finds no set bit.
On an empty-flagged opposite side `worse_of(empty, start_tick) = start_tick` and the
walk proceeds normally (a rest may have arrived in flight); `quote_place` returns
`start_tick = limit_tick` and a one-key band in that case. "The book still crosses
`limit_tick`" is decided from the **recorded `BestTick(opposite)` as it stands after
this walk's own updates**, never by reading further levels: a rest that arrived at a
price better than `start_tick` is invisible to the walk (invariant 5) but did move
`BestTick`, so it is exactly what this check catches; the remainder is refunded, not
rested, and the book stays uncrossed (invariant 8).

**Degradation: the bounded tombstone scan.** Tombstones (§2) are skipped when the head
advances, but the scan is bounded: a place scans at most `MAX_SLOTS_SCANNED` slots
total, and head advancement is **always persisted** in a transaction that succeeds,
even when the cap ends the loop early, cleanup cost amortizes across takers instead
of repeating for each one. (A typed error such as `RetryRest` reverts the whole
transaction, cleanup included; §9 prices that path.)
Without this bound, an attacker rests K dust orders, cancels the middle, and poisons
the best price with a scan bounded only by history. (`min_order_lots` raises the cost
of that attack; the scan cap removes the damage.) The other degradations are in the
pseudocode: `MAX_LEVELS_CROSSED`, a window edge at the partial level, and a stale bit
each end or skip a step with progress persisted; a remainder that still crosses is
refunded, never rested.

**Multi-leg composition: `route(legs[])`.** Sequential walks across markets, deltas
netted in invocation memory, one SAC transfer per token at the end. **Route caps are
per-transaction, not per-leg:** `legs.len() ≤ MAX_ROUTE_LEGS`, and one shared
`MAX_LEVELS_CROSSED` / `MAX_SLOTS_SCANNED` budget spans all legs, so a route's
worst-case writes, events, and footprint are the same as a single maximal place plus
per-leg constants, and the §0.3 creation bound already reserves `MAX_ROUTE_LEGS`
headroom for the netted transfers. Legs are placed in order; a leg's failure fails the
route.

**Owned invariants (§19): 5**, price-time priority, scoped by `start_tick`: takes
consume strictly best-tick-first among ticks at-or-worse than `start_tick`, FIFO
within level (tombstones skipped); orders rested at better ticks after simulation keep
their place, they are not consumed and not harmed. **7**, every loop is bounded by a
config constant (`MAX_LEVELS_CROSSED`, `MAX_SLOTS_SCANNED`, `MAX_ROUTE_LEGS`,
`MAX_REPLACE_BATCH`, `INLINE_SLOTS`, `PAGE_SLOTS`, `MAX_PAGES`), route caps shared
across legs, not multiplied by them. **8** (shared with §9), the book is never
crossed after any operation completes: a matching loop terminated by a cap or window
refunds its remainder.

**Budget** (§17): take-only, 8 levels swept ≈ 22 touched (band padding on top) /
17 writes / ~5.3 KB / **~0.006 XLM**; maximal take (32 levels, 32 distinct `TickWord`
entries) ≈ 77 touched + pad / 72 writes / ~26.6 KB / **~0.026 XLM** (arithmetic in
§17).

### 9. Rest (append)

Rests the remainder of a take, or a pure maker order; also the second half of
`replace` (§10). Enforce `[min_order_lots, max_order_lots]` (`QtyOutOfBounds`); fail
`OrderExists` if `Order(owner, nonce)` is live; apply the empty-level reset (§2) if
due; assign `seq = tail_seq++` (fail `LevelFull` at `LEVEL_CAP`); the slot for `seq`
must be inline or in a page inside the declared append window, if a concurrent rest
pushed the tail past it, fail with the typed error `RetryRest` (graceful; client
re-simulates), never a footprint trap. Write the qty slot and add to `open_lots`. **If
`open_lots` was zero before this rest**, the level is new, was swept, or was emptied
by cancels, set the tick's `TickWord` bit and its word's `TickSummary` bit,
idempotently; the `Level` entry existing already is not a reason to skip this (§5,
invariant 3's hard direction). If `BestTick(side)` carries the empty flag, or the tick
is better than the recorded value, set `BestTick(side)` to this tick, clear the flag,
and emit `top_changed`. Write `Order(owner, nonce)`; escrow via one SAC transfer; emit
`rested`.

The append window is cheap to make safe: `{page(tail_sim), page(tail_sim)+1, page 0}`
covers concurrent same-level rests up to a full page (`PAGE_SLOTS` orders) *and* a
concurrent sweep or reset (which sends the tail back toward 0). **`RetryRest` priced:**
because it is a typed error, the whole place reverts, completed takes and the walk's
persisted head cleanup included, and the victim loses one failed-transaction fee
(~0.05 XLM for a take-plus-rest at an existing tick). Forcing it needs more same-level rests than the
window covers, landed *ahead of the victim in the same ledger*: at least
`PAGE_SLOTS + 1` (~1.6 XLM at ~0.048 each) and up to `2 × PAGE_SLOTS` (~3 XLM), rent
the attacker never gets back. A 25-50:1 cost ratio against the attacker per attempt,
plus an intra-ledger ordering requirement, is why the all-or-nothing choice stands;
the alternative (keep the take, refund the remainder) would silently drop maker intent.

**Post-only semantics (deliberately conservative).** A post-only rest compares its
tick against the recorded `BestTick(opposite)` **as stored**, one read,
footprint-stable. If it would cross the recorded best, it fails `Crossed`, *even if
that best is a stale bit over an emptied level*. Because `BestTick` is never worse
than the true best (inv. 3), this check can false-reject near stale state (until the
next place that takes there cleans it) but can never rest a truly crossing order.
Trying to be smarter, walking past stale levels to find the "true" best, would
either widen the footprint unboundedly or create a crossed book; both are forbidden
(invariant 8's fail-closed half).

*The phantom-best griefing this admits, priced.* Anyone can rest one min-size order
inside the spread (which moves `BestTick`) and cancel or `replace` it away (which does
not move `BestTick` back). Until the next taker walks through, every post-only rest on
the other side that would cross the phantom fails `Crossed`, and every non-post-only
taker spends one crossing slot clearing it. Re-arming costs the griefer one `replace`
item (~0.002 XLM once the nonce's rent is paid, at a tick that already has a `Level`) plus the risk that a taker fills the
dust while it rests, a `min_order_lots`-sized fill inside the spread, which is why
`min_order_lots × price` and not rent is the deterrent for this class (§17). The
damage is bounded to a quiet interval on one side of one market and heals on the
first take; v1 accepts it rather than read the recorded best's `Level` on every
post-only rest.

**Budget** (§17): rest at an existing level ≈ 12 footprint / ~5 writes / ~0.9 KB /
**~0.048 XLM** (dominated by `Order` rent); first touch / restore of a tick ≈ 15 / 8
/ ~2.1 KB / **~0.115 XLM** (adds `Level` rent; ~0.27 XLM on an empty side, where the
word, summary and best are created too).

### 10. Replace: the maker update path

`replace(owner, nonce, side, tick, qty)` settles the old order exactly per §7's claim
table (pay what filled, refund what didn't, tombstone the slot), then rewrites the
**same `Order` in place** with the new coordinates and appends at the new tick under
the normal rest rules (§9: bounds, append window, `LevelFull`, empty-reset). Because
the entry is reused at fixed size (§3), **no rent is charged** while the entry is
live: the maker's nonce is a durable quote slot whose 120-day rent amortizes across
every update, for a market maker and, equally, for a griefer (§17 "rent bounds
holding, not churn"). (An `Order` idle past its TTL is archived; the next `replace`
restores it and pays the next 120-day chunk, ~0.046 XLM, the same charge a settle
would carry.) Replace never
takes liquidity: it applies §9's conservative post-only check against recorded
`BestTick` and fails `Crossed` instead. And it is atomic, the maker is never unquoted
between the settlement and the re-rest, which a settle-then-place pair cannot
guarantee. The maker pays in the full new escrow (a function of the arguments, so the
signed authorization holds whatever filled in flight, §8 "Deterministic pay-in") and
the old order's proceeds and refund flow back out; per token, at most one transfer
each way.

**`replace_batch(items[])`**, ≤ `MAX_REPLACE_BATCH` items, settlement deltas netted
in invocation memory, one transfer per token at the end. A full book refresh is one
transaction. Failure of any item fails the batch (all-or-nothing).

**Failure modes.** Everything §7 and §9 can raise (`UnknownOrder`, `NotOwner`,
`QtyOutOfBounds`, `LevelFull`, `RetryRest`, `Crossed`); `Paused`, replace contains a
rest, so it pauses with the entry side of the book (§12).

**Budget** (§17): one quote to a new tick ≈ 13 touched / 7 writes / ~2.0 KB /
**~0.0024 XLM** of execution (plus `Level` rent if the tick had none); a 40-quote
same-tick refresh ≈ 90 / 83 / ~27.7 KB / **~0.031 XLM**, zero rent. Why this
matters, settle+place would re-pay ~0.046 XLM of `Order` rent per update, is the
second reading in §17 and ADR-005.

### 11. Views (read-only)

Read-only entry points for routers and UIs; none writes, so their footprints are
declared as read-only and never conflict.

- `best(market, side) → Option<tick>`, reads `BestTick` as stored (subject to the
  §5 staleness contract).
- `level(market, side, tick) → LevelInfo`, counters and `open_lots` (depth) from one
  `Level`.
- `order(market, owner, nonce) → OrderInfo`, the stored coordinates plus a settlement
  preview: §7's table evaluated read-only against the current counters.
- `quote_place(market, side, limit_tick, qty) → QuoteResult`, the **simulate** step
  of the client's protocol (§14): walks the book read-only and returns the
  `start_tick`, the crossed ticks, and the band and slot windows the client should
  declare. It MUST run the same walk code as `place` (same caps, same lazy-clear
  decisions, computed but not written) so that simulation and application diverge only
  by what the book does in flight, never by logic; and it returns the keys the
  simulated execution touched, so the client can tell touched keys from padded-only
  keys when it marks restores (§14). Archival itself is not observable from inside a
  contract (an archived entry cannot be read); the client learns which of those keys
  are archived from RPC. Return shape: 05 "Encoding decisions" and ADR-020.

### 12. Entry points, authentication, administration, cranks

Every state-changing entry point authenticates, explicitly:

| Entry point | Auth | Composes | Declared footprint | Blocked by pause |
|---|---|---|---|---|
| `place` | `taker.require_auth()` | walk (§8) + rest (§9) | band + windows + own rest keys (§14) | yes |
| `route` | `taker.require_auth()` | walk per leg (§8) | per-leg bands, split across the 400-entry budget (§14) | yes |
| `settle` | `owner.require_auth()` | settlement (§7) | `Order`, its `Level`, at most one `LevelPage`, both vault balances | **never** |
| `replace` / `replace_batch` | `owner.require_auth()` | settlement (§7) + rest (§9) per item (§10) | union of settle's and rest's keys per item | yes |
| `create_market` | `admin.require_auth()` |, | new `Market`, `Config` read |, |
| `set_admin`, `set_fee_recipient`, `set_paused` | `admin.require_auth()` |, | `Config` (write) |, |
| `set_market_caps` | `admin.require_auth()` | §0.3 re-proof | one `Market` |, |
| `collect_fees` | none |, | `FeeAccrual`, one vault balance, recipient's balance | **never** |
| `keepalive` | none |, | instance + code TTL bump |, |

Views (§11) authenticate nothing and write nothing.

- **`create_market`**, admin-gated in v1 (permissionless creation deferred, §20).
  Enforces, exhaustively: `base ≠ quote` (`SameToken`); `1 ≤ tick_min < tick_max ≤ 2^22`
  (`TickOutOfBand`, §0.2's zero-price floor and §5's bitmap coverage);
  `lot_size, tick_size ≥ 1` and `1 ≤ min_order_lots ≤ max_order_lots`
  (`BadQuantization` / `QtyOutOfBounds`); the two §0.3 overflow bounds (`Overflow`);
  and `taker_fee_bps ≤ FEE_BPS_MAX` (`FeeTooHigh`). It does not check for a duplicate
  pair (§0.1). Assigns the next `market_id` from `Config`'s counter. ~0.098 XLM,
  dominated by `Market` rent (§17).
- **Asset eligibility (admin's call, contract cannot verify).** The vault is a SAC
  contract balance (§6): no trustline or reserve, the entry is created by the first
  transfer in. Two issuer flags reach through it. *Auth-required* assets leave a
  contract balance unauthorized until the issuer authorizes it, so the first escrow
  fails and the market is dead on arrival; and if the issuer later freezes the vault or
  a maker, `settle` for that token reverts until the freeze lifts, funds stay in the
  vault (conservation holds), but "exit is never gated" is then true at PageBook's
  layer and false at the asset's. *Clawback-enabled* assets let the issuer pull from
  the vault directly, breaking conservation with no contract involvement. `create_market`
  SHOULD refuse an asset whose SAC reports `authorized(vault) == false` (one read of a
  trusted SAC, the only cross-contract call outside `transfer`); clawback is not
  observable on-chain, so deployments custodying value MUST document that residual
  issuer trust. A taker whose own output-asset balance is frozen simply fails the
  final transfer (makers unharmed, taker burns the fee).
- **Cranks.** `collect_fees(market, token)` pays the accrued `FeeAccrual` to the fee
  recipient; ALWAYS works, under any admin state. `keepalive()` bumps the instance TTL
  out-of-band (~2.3 XLM per ~120 days, mostly wasm code-entry rent, §17), anyone may
  crank it; admin ops also bump. Market ops never write the instance entry (§1). The
  crank has no reward, so **if nobody cranks, the instance and code archive**, and the
  next market operation of any kind auto-restores them at that caller's expense
  (~2.3 XLM on a ~0.03 XLM operation, shown by simulation, never silently charged);
  the venue self-heals but the surprise reads as an outage. Custodial deployments run
  the crank on a schedule; burn-address deployments rely on the first-caller-pays
  fallback or on a v2 reimbursing crank (§20).
- **Initialization is the constructor.** `__constructor(admin, fee_recipient)` runs
  atomically at deploy, there is no `init` entry point and no first-caller-wins race.
- **Trust model, stated plainly:** there is no upgrade entry point (ADR-023); the
  deployed wasm is final for that address, and no admin action can move the vault. The
  admin's powers are: create markets, retune caps, rotate the admin and fee recipient,
  and pause the entry side of the book (`settle` and `collect_fees` never pause). A
  new version is a new deployment; migrating a live book to it means makers settle
  here and rest there. Deployments that custody real value SHOULD still put the admin
  behind a multisig/timelock, because pause and cap retuning shape the market;
  "trustless" deployments set admin to a burn address after market creation. This
  contract custodies every maker's escrow; the admin story is deliberately small.
- **Pause blocks `place`, `route`, and `replace`. `settle` and `collect_fees` ALWAYS
  work**, funds exit is never gated, under any admin state. (`replace` contains a
  rest, so it pauses with the entry side of the book; the exit half stays available
  through `settle`.)
- **Cap retuning: `set_market_caps`.** Retunes the mutable class of §1 per market;
  every call re-runs the §0.3 overflow proof and rejects values that break it. The
  entry point exists because validators retune Soroban's limits every few months (the
  SLP process) and a contract cannot read network config, no host function exposes
  resource limits or remaining budget, so stored caps can only track the network
  through an authorized transaction. The contract can verify its own §0.3 proof
  on-chain but cannot verify caps against live limits; choosing caps that fit the
  network is the admin's job, informed off-chain. Client-side knobs (band width,
  windows, batch composition) need no retuning: clients read live config over RPC per
  transaction.
- **No upgrade.** Deliberately absent at this stage (ADR-023): an upgrade path is
  only worth having with a tested lazy migration of every stored layout, and the
  trust cost of a live-vault-moving admin power is not worth paying before then. A
  version bump is a new address. Listed in §20.

### 13. Events

The contract's output surface (per tx ≤ 16,384 bytes):

| Event | Emitted by | Fields |
|---|---|---|
| `rested` | rest (§9), replace (§10) | `owner, nonce, side, tick, generation, seq` |
| `filled` | walk (§8), one per crossed level | `side, tick, lots, quote`, `side` is the consumed level's (makers') side, as for `swept` |
| `swept` | walk (§8) | `side, tick, generation` |
| `settled` | settlement (§7), replace (§10) | `owner, nonce, filled_lots, refunded_lots` |
| `top_changed` | walk (§8), rest (§9) | `side, old, new` |

Event bytes are bounded by the same caps that bound the loops: ≤ `MAX_LEVELS_CROSSED`
take/sweep events per invocation (shared across route legs) ⇒ worst case ≈ 64 ×
~100 B ≈ 6.4 KB, asserted in tests. Top-of-book changes are events, not hooks,
Soroban cannot resource-cap an untrusted synchronous call (§20).

### 14. The client's process: simulate → pad → submit

Padding is the client/SDK's half of the protocol. All keys derive from
`(market, side, tick, word, page, owner, nonce)`, a client computes them without
chain state, before submission.

**Simulate.** Call `quote_place` (§11) or simulate locally: obtain the crossed ticks
starting at simulated best `t1`, the per-level head positions, and the tail position
at the intended rest tick. Choose a nonce that is not live for this owner (§3).

**Pad (contiguous band + slot windows).** Pass `start_tick = t1`, and declare RW, on
the **opposite** (walk) side: **every `Level` key in the contiguous tick band
`[t1, pad_end]`**, set or not (unset keys cost only footprint slots), plus the
`TickWord` entries covering the band, that side's `TickSummary` and `BestTick`, and the
slot windows: for each *set* level in the band, pages
`[page(head_sim), page(head_sim) + width]` (window width small; unset/fresh levels need
none, their queues are inline). On the taker's **own** side, for its possible rest:
`Level(own_side, limit_tick)` (set or not, the rest rewrites or creates it),
`TickWord(own_side, word(limit_tick))`, own-side `TickSummary` and `BestTick`,
`Order(taker, nonce)`, and append pages `{page(tail_sim), +1, 0}`. The own-side word
is on the list even though a rest onto a live level never reads it (§9 sets the bit
only when the level was empty): if that level empties in flight, the rest must set the
bit at apply, and simulation had no reason to declare the word (ADR-025). The same
own-side set applies to every rest, a `replace` item included. For **both** tokens
(not only the one simulation happened to move): the SAC contract instance, the vault's
SAC balance, and the caller's own balance entry (a trustline for a classic asset), plus
both `FeeAccrual`s. That list is exhaustive: a take-plus-rest place touches nothing
else. Two rules the testnet soak made explicit (ADR-025): every band key is declared
**read-write**, and a key simulation listed as read-only (an empty level, a word with
no bit) is *promoted* to read-write, because the book may move it in flight and the
walk would then write it; and the declared resources need headroom over the simulated
ones (instructions for the extra keys, write bytes for band keys that exist, disk-read
bytes for classic entries), since simulation budgets exactly what it touched. Band
padding is required because a new level can appear at *any* tick inside the walk
range; window padding is required because a concurrent take can move a head into
pages, and a concurrent rest can move a tail across a page boundary. The band need not
extend past the deepest level the take can *consume*: the walk never scans for the
next set tick once its quantity is done (§8). For a `route`, split the footprint across
legs' bands. Padding is cheap in fees but not free in capacity (§17): a read-write key
pays the write-entry fee (~2,500 stroops) whether or not it is written, an *existing*
read-write key is charged its write bytes as if written, and both count against the
per-transaction caps (400 entries, 200 read-write entries, 132 KB) and the ledger's
write budget. Pad the band the book can plausibly move into, not the maximum.

**Archived keys in the pad.** P23 restore is opt-in per footprint entry: the
transaction lists which archived entries to restore and pays their rent; an archived
key that is declared but *not* listed costs only its footprint slot, and traps only if
execution touches it. So: mark for restore exactly the archived entries simulation
touched (a stale bit over an archived level, an archived word on the walk, an archived
`Level` at the rest tick, `quote_place` returns the touched key set, §11, and RPC
says which are archived) and pad every other archived key unmarked. Nothing can turn an unmarked archived key into a touched one in
flight: the only way an archived `Level` re-enters the walk is a rest at that tick,
which restores it first. Restore rent therefore lands only on entries the taker's own
execution needs, once. A stale bit over an archived level costs one restore (~0.067
XLM) and one `MAX_LEVELS_CROSSED` slot, for exactly one taker, ever; seeding it costs
its author a rest plus a cancel, ~0.12 XLM fresh, or ~0.002 XLM per `replace` item on
a nonce whose rent is already paid, plus a `Level` that must be created or restored at
each new tick (§17 "rent bounds holding, not churn"). Even at the churn price the
attack is one-shot per bit and 120 days per level.

**Submit, and what can happen**, the contract's side of this contract is §15: only
walking past `pad_end` traps; every other race degrades gracefully or returns a typed
error the client can act on (`RetryRest` ⇒ re-simulate and resubmit; `Crossed`,
`LevelFull`, `Unfilled` ⇒ the client's call).

## Part III: System properties

### 15. Footprints: the product surface

Everything in Parts I-II exists so this section holds. Every key is computable
client-side before submission (Part I); every loop is capped (invariant 7); every
race degrades gracefully except one. Concretely:

**Failure modes, exhaustively.** A place **traps** (footprint violation) only if the
walk must pass `pad_end`. Every other race **degrades gracefully**: scan cap, level
cap, and window edges end the loop with progress persisted and the remainder refunded;
an append landing outside the window is the typed error `RetryRest`. On sparse books a
band deep enough to be safe may not fit in the 400-entry footprint; clients trade
`pad_end` against trap probability. This residual is inherent and far smaller than the
whole-book race in 02, but it is not zero, do not claim otherwise.

Declared-but-untouched entries cost no rent and no restore, live or archived, provided
archived ones are not marked for restore (§14); a *touched* archived entry costs its
restore rent, and only entries simulation touched are marked. They are not free of
fees or capacity: a read-write key pays the write-entry fee, and one that exists is
charged its write bytes as if written (measured on testnet, ADR-025). Per-transaction
limits: 400 footprint entries, 200 writes, 132 KB written; per-ledger: 286,720 write
bytes (03).

**Owned invariant (§19): 6**, no operation touches entries outside its declared key
family; window/cap edges degrade gracefully (refund / `RetryRest`), and only walking
past `pad_end` traps.

### 16. Concurrency and serialization

The honest version: the true serialization points are the vault's SAC balance entries,
one per (token, contract). Every settling op RWs one or both, so same-side rests
serialize with each other, takers serialize with both sides, and **all markets sharing
a token join one cluster** under P23/CAP-63: a venue quoted mostly in USDC is
effectively one serial cluster. v1 accepts this, the network write-bytes ceiling, not
cluster parallelism, is the binding throughput limit at current numbers (§17).
Recovering parallelism (per-market vault sub-accounts, or internal balance entries
netted at settlement edges) is an explicit v2 item (§20).

Why §1's instance rule matters: a per-op `bump_instance` would put an instance
**write** in every transaction, one global serialization point across every market
and token, silently undoing the whole analysis above. Reads of instance config are
shared read-only and do not conflict. The cluster analysis above is therefore the
whole story.

### 17. Budgets and fees

Budgets are measured (M4, ADR-024: `tests/footprint.rs`, `tests/worst_case.rs`,
`tests/fee_gates.rs`; derivation in `08-worst-case-matrix.md`). "Touched" is what the
host meters for the invocation; the client's *declared* footprint for a `place` is
larger (the padded band, §14). Every call whose authorizer is not the transaction
source also writes one temporary authorization-nonce entry (+1 write, ~72 B, plus
temporary rent); it is inside every row below.

| Op | Touched entries | Writes | Write bytes |
|---|---|---|---|
| place, rest only (existing level) | 13 | 5 | 1.2 KB |
| place, rest only (new level, empty side) | 15 | 8 | 2.1 KB |
| settle | 9 | 5 | 0.9 KB |
| replace (one quote, new tick) | 13 | 7 | 2.0 KB |
| replace_batch (40 quotes, same ticks: the refresh) | 90 | 83 | 27.7 KB |
| replace_batch (40 quotes, each to a fresh tick) | 130 | 124 | 44.3 KB |
| place, take only, 8 levels swept (one word) | 22 | 17 | 5.3 KB |
| place, take 8 levels + rest | 27 | 22 | 6.9 KB |
| place, maximal take (32 levels in 32 words) | 77 | 72 | 26.6 KB |
| route (2 legs, 8 levels, no rest) | 22 | 17 | 5.3 KB |
| create_market | 9 | 3 | 1.0 KB |
| set_market_caps | 5 | 2 | 0.7 KB |
| collect_fees | 6 | 3 | 0.6 KB |
| keepalive | 2 | 0 | 0 |
| quote_place, views | 7 | 0 | 0 |

Worst-case write-byte arithmetic for the max sweep, so nobody trusts the table
blindly. The host meters each write as the full ledger entry (payload + key + ~56 B of
framing): Level 404 B, TickWord 376, TickSummary 372, BestTick 156, FeeAccrual 184,
SAC balance 224, auth nonce 72. 32 × 404 + 32 × 376 + 372 + 156 + 184 + 4 × 224 + 72 =
**26,640 B over 72 writes** (32 Levels, 32 TickWords, summary, best, fee accrual, four
SAC balances, nonce), within per-tx limits (400 entries / 200 writes / 132 KB) but
**9.3% of a whole ledger's 286,720 write bytes**. Typical ops are the rest/settle rows
(~1 KB); the ledger sustains hundreds of those, or ~10 max sweeps, per close, the
reason every hot entry is a few hundred bytes. (SLP history suggests the ceiling
rises; per-op bytes here are ~50-100× under a whole-book-blob design.)

**Rent per created entry.** Rent is charged on the full ledger entry, at ~1,667
stroops per byte per 120-day minimum TTL at the 1,000/KB floor (03 §Fees, ADR-004):

| Entry | Full size | Rent per 120 d |
|---|---|---|
| `Order` | 276 B | ~0.046 XLM |
| `Level` | 404 B | ~0.067 XLM |
| `LevelPage` | ~376 B | ~0.063 XLM |
| `TickWord` / `TickSummary` | 376 / 372 B | ~0.063 / ~0.062 XLM |
| `BestTick` | 156 B | ~0.026 XLM |
| `FeeAccrual` | 184 B | ~0.031 XLM |
| `Market` | 580 B | ~0.097 XLM |
| a caller's first SAC balance in a token | 224 B | ~0.037 XLM |

**Estimated resource fees per operation.** Execution (instructions, write entries at
2,500 stroops, write bytes at 875/KB, events at 5,000/KB) is measured in-repo against
the SDK's 2026-07-10 mainnet snapshot; instructions are a lower bound (the native test
contract does not model wasm instantiation) and tx-size fees (~406/KB) are not in
these figures. Rent uses the table above. Rows assume the entries an operation
rewrites are live and name what it creates:

| Op | Est. resource fee | Of which |
|---|---|---|
| place, rest only (existing level) | **~0.048 XLM** | exec 0.0016 + `Order` rent 0.046 |
| place, rest only (new tick, word already live) | **~0.115 XLM** | + `Level` rent 0.067 |
| place, rest only (empty side: new word, summary, best) | **~0.27 XLM** | Order + Level + TickWord + TickSummary + BestTick |
| settle | **~0.0015 XLM** | exec only; no rent |
| replace (one quote, to a new tick that has a `Level`) | **~0.0024 XLM** | exec only (measured shape); a same-tick size change is at most this |
| replace (to a tick that never had a `Level`) | **~0.07 XLM** | + `Level` rent 0.067 |
| replace_batch (40 quotes, same ticks) | **~0.031 XLM** | exec 312k stroops; zero rent |
| replace_batch (40 quotes, each to a fresh tick) | **~2.7 XLM** | exec 0.043 + 40 × `Level` rent |
| + settle or replace of an *archived* `Order` (idle > 120 d) | **+ ~0.046 XLM** | `Order` restore rent, paid by the maker |
| place, take only, 8 levels swept | **~0.006 XLM** | exec 62k stroops (+ `FeeAccrual` 0.031 and the taker's first balance 0.037, once) |
| place, take 8 levels + rest (empty side, first take) | **~0.34 XLM** | exec 0.008 + the rest's five entries 0.264 + `FeeAccrual` and first balance 0.068 |
| place, maximal take (32 levels) | **~0.026 XLM** | exec 256k stroops (72 writes) |
| `create_market` | **~0.098 XLM** | `Market` rent 0.097 |
| `collect_fees` | **~0.001 XLM** | exec (+ recipient's first balance 0.037, once) |
| `keepalive` (whole venue, per ~120 d) | **~2.3 XLM** | wasm code-entry rent (~40 KB at ⅓ discount) |

Readings, in design terms:

- **Matching is nearly free; placement pays rent.** A 32-level sweep costs about half
  of one `Order`. The book's carrying cost sits with makers at ~0.046 XLM per open
  order per 120 days, an anti-spam economics that arrives for free and stacks with
  `min_order_lots` (a dust-storm of K *simultaneously open* orders has a hard cost of
  ~0.046 K XLM, non-refundable, plus K escrows).
- **Rent bounds holding, not churn.** Because `replace` moves an existing `Order` for
  ~0.002 XLM, an attacker who has paid rent on K nonces can re-arm anything a rest
  plus a cancel can arm, a tombstone, a stale bit, a phantom `BestTick` inside the
  spread (§9), a re-filled dust level, K times per transaction for ~0.03 XLM,
  indefinitely, provided the target ticks already have a `Level` (a fresh tick costs
  the `Level` rent). None of it reaches funds, and every instance is bounded by a cap
  and healed by the next taker (`MAX_SLOTS_SCANNED`, `MAX_LEVELS_CROSSED`,
  sweep-resets, the one-restore-per-stale-bit bound of §5); but the per-instance cost
  figures in §5/§9/§14 are *rent* figures and overstate the churn case by ~30×. The
  churn deterrent is **`min_order_lots × price`**: dust rested inside the spread to
  arm a phantom or fragment the book is filled at that price by the first taker, and
  dust rested at the best price to poison a queue is swept for its notional. Set
  `min_order_lots` so that notional is worth more than the nuisance; that knob is
  retunable via `set_market_caps` (§12) without touching the design.
- **Churn is priced separately from holding, use `replace`.** Updating a quote via
  settle+place re-creates the `Order` and re-pays its rent every time (~0.048
  XLM/quote, a 40-order book refreshed every minute would burn ~2,800 XLM/day, so
  SDEX-style churn is impossible on that path). `replace` reuses the entry: a full
  40-quote same-tick refresh in one tx is ~0.031 XLM, and the per-quote carrying cost
  stays ~0.0004 XLM/day regardless of update frequency. Moving quotes to ticks that
  have never held a level pays `Level` rent per new tick, once. Capacity, not fees,
  then binds: at ~28 KB per same-tick refresh the *network* fits ~10 per ledger, and
  ~6 when every quote changes tick (44 KB). Full analysis and SDEX comparison in
  ADR-005.
- **Padding is cheap in fees, not in capacity.** A declared-but-untouched key that
  does not exist costs its tx bytes (~300 stroops) plus, if read-write, the
  write-entry fee (2,500 stroops, 0.00025 XLM); one that exists and is read-write is
  also charged its write bytes as if written (~350 stroops for a `Level`); a 100-key
  band is therefore ~0.03 XLM, still small. What it is not small in is capacity: each
  read-write key is one of the transaction's 200 and the ledger's 1,000 write entries,
  and each existing one is write bytes against 132 KB / 286,720 B (ADR-025). The
  exception in rent terms is an archived entry the walk *touches* (a stale bit over an
  archived level): that one is restored at ~0.067 XLM, once, and simulation shows it
  (§14).
- **Level rent is paid once per tick per ~120 days of activity**, by whoever
  creates/restores it (`Level`s are never deleted, so re-activating a swept tick is a
  rewrite, not a create).
- **Volatility caveat:** the 1,000/KB rate is the protocol *floor*; it climbs toward
  10,000/KB as live Soroban state approaches the 3 GB target, rent-dominated rows
  scale with it (worst case ~10×). M4 regression-gates measured fees against this
  table (`tests/fee_gates.rs`).

### 18. TTL and archival: policy summary

Mainnet's minimum persistent TTL is **2,073,600 ledgers (~120 days)**, charged as rent
at creation/restore; the maximum is ~180 days (03 §Storage). That makes the policy
almost entirely passive, entries live in prepaid 120-day chunks, and **no hot path
ever extends a TTL** (matching, resting, and settling pay zero rent on existing
entries). Per-structure lifecycles are specified in Part I; the summary:

| Entry | TTL comes from | On archival (~120 d idle) |
|---|---|---|
| `Config` (instance) + wasm code | permissionless `keepalive()` crank + admin ops, **never market ops** | crank restores (~2.3 XLM/120 d, mostly code rent); if the crank lapses, the next market op of any kind auto-restores at that caller's expense (§12) |
| `Market`, `BestTick`, `TickSummary`, `TickWord`, `Level`, `LevelPage`, `FeeAccrual` | 120-d minimum at creation/restore; whoever restores pays the next chunk | auto-restore on touch (generation survives) |
| `Order` | 120-d minimum at rest (maker pays); the current contract has no per-order TTL extension entry point | the settling maker auto-restores; costs land on beneficiary |
| Vault SAC balances (§6) | the token contract's policy; touched by every settling op | auto-restore on touch; toucher pays (in practice never idle while a market is active) |

Requirements: **never `del` a `Level`** (§2, archival IS the garbage collector).
`Order` on settle IS deleted; pages wholly behind the head MAY be deleted (v1 leaves them: the stale-slot rule makes them unobservable, ADR-021).
Temporary storage is allowed only for lossless-if-lost data (e.g., optional
time-in-force expiry index), never for funds-bearing state.

### 19. Invariants (must hold; property-test all)

The canonical numbered index. Each invariant is stated in context in the section that
owns it; property tests cite these numbers.

1. Conservation: vault balance per token == Σ open escrows + Σ unclaimed proceeds +
   accrued fees (across all markets). *(§6)*
2. `open_lots` == Σ live slot qtys − `head_consumed_lots` (inline + pages; tombstones
   excluded; stale slots excluded per invariant 9). Takes decrement it by lots
   consumed, settles by lots refunded. *(§2, §7)*
3. `open_lots > 0` ⇒ bitmap bit set, maintained by every rest that raises `open_lots`
   from zero, whether or not the `Level` entry existed. The converse is deliberately
   weak: a stale set bit over an empty level is permitted (cancel-to-empty is O(1) and
   does not walk bitmaps or move `BestTick`) and is cleared lazily by the next place
   that takes through it. `BestTick` is never *worse* than the true best set tick;
   matching may walk forward from it. *(§5, §9)*
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
   `PAGE_SLOTS`, `MAX_PAGES`), route caps shared across legs, not multiplied by
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
- **Permissionless market creation** with an anti-spam fee (§12); v2. A pair index
  (`MarketByPair`) would come with it if duplicate pairs need refusing.
- **Reimbursing `keepalive`**, pay the cranker's measured restore cost out of
  `FeeAccrual` so burn-address deployments do not depend on altruism (§12); v2.
- **In-place upgrade** (`upgrade(wasm_hash)` + lazy migration of packed layouts on
  touch, keyed by the schema-version byte), removed for v1 (ADR-023); a version
  is a new deployment until a migration story exists and is tested.
- **Synchronous hooks**: impossible to sandbox (no per-call cap); events instead.
- **Geometric-tick market type** using Liquidity Book's `(1+step)^id` map, changes
  only the id→price function (bitmaps/levels/settlement untouched), removes the
  per-market tick-band config, and makes a fixed-width pad band a constant percentage
  depth; see `01-prior-art.md` §Liquidity Book. v2.
- **Pooled (pro-rata) levels**, LB-style fungible per-`(level, generation)` shares as
  a sibling market type: deletes pages/tombstones/windows/`Order` (whose rent is the
  dominant per-order cost, ADR-004) at the price of time priority within a level. MUST
  keep generation-on-sweep for fill finality (final order states without keepers). v2.
- **Volatility-scaled taker fee** (LB surge pricing): the matching loop already counts
  crossings and `FeeAccrual` is already RW, zero added footprint; costs `quote_place`
  exact fee determinism. v2, decision note required.
- **Self-trade prevention, oracle-pegged orders, batch-auction market type**
  (SPEEDEX-flavored sibling for hot markets): design notes exist in
  `01-prior-art.md`; not v1.
