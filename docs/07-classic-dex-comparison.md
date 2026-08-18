# PageBook against the classic Stellar DEX: limitations

*Research note, August 2026. Companion to `04-architecture.md`; ADR-005 covers maker
economics in depth. Where a fact about the classic DEX is a protocol constant, it is
stated as of the current mainnet protocol. Verify against `stellar-core` before quoting
it elsewhere.*

## 1. Purpose and framing

The classic Stellar DEX (SDEX) is an order book built into the protocol: offers are
ledger entries, matching runs inside transaction apply, and payments can route through
it. PageBook is an order book built as a Soroban contract on top of the same ledger.
The two occupy different layers, so a fair comparison asks one question: what does a
user of SDEX give up if the same market lived in PageBook? This document answers that
question in the direction the title says, PageBook's limitations, and only at the end
lists where PageBook is not worse, so the reader is not left with a one-sided picture.

Everything about SDEX below is standard behaviour of the classic protocol. Everything
about PageBook cites the architecture doc, an ADR, or a measured number from the M0 to
M3 branch.

## 2. The two systems in one table

| | SDEX (classic protocol) | PageBook (Soroban contract) |
|---|---|---|
| Where matching runs | inside the protocol, at transaction apply | inside a contract invocation, at apply |
| Order representation | `OfferEntry` ledger entry per offer; price a rational `n/d` of two i32s; amount an i64 | one `Order` entry per resting order plus a positional slot in a packed `Level`; price an integer tick; size in lots (§0.2, §2, §3) |
| Placing an order | `ManageBuyOffer` / `ManageSellOffer` / `CreatePassiveSellOffer`, ~100 stroops base fee | `place`, resource-priced; ~0.029 XLM to rest (dominated by 120-day `Order` rent), ~0.009 to 0.037 XLM to take (§17) |
| Cost to hold an order | 0.5 XLM base reserve locked per offer, fully refundable; no rent | ~0.027 XLM per order per 120 days, non-refundable; entry archives after 120 idle days (§3, §18) |
| Cost to update a quote | modify in place, ~100 stroops | `replace` rewrites the `Order` in place, ~0.003 XLM; a 40-quote `replace_batch` ~0.03 XLM (ADR-005) |
| Fill delivery | credited to both sides at apply | taker settled at apply; the maker must call `settle` to receive proceeds or a refund (§7) |
| Custody while resting | funds stay in the account, reserved as liabilities | funds transferred into the contract's vault (§6) |
| Depth a taker can cross per op | up to the protocol's per-operation work limit (1,000 offers; `opEXCEEDED_WORK_LIMIT`) | at most `MAX_LEVELS_CROSSED` levels (32) and `MAX_SLOTS_SCANNED` slots (64) per transaction, shared across `route` legs (§8) |
| Footprint | none for the user; the protocol reads what it needs | client simulates, pads a contiguous tick band and page windows, declares every key (§14) |
| Prices | any rational; no market setup | markets created by the admin with fixed `lot_size`, `tick_size`, band `[tick_min, tick_max)` of at most 2^22 ticks (§0.2, §12) |
| Multi-hop | path payments through offers and liquidity pools, up to 5 intermediate assets, one operation | `route`: at most `MAX_ROUTE_LEGS` (4) PageBook markets, one shared budget; no AMM, no classic offers |
| Time in force | resting remainder always; passive offers; path payment as a strict-receive or strict-send atomic swap | `post_only`, `fill_or_kill`, `no_rest` (IOC); no passive semantics (§8) |
| Self-trade | rejected (`CROSS_SELF`) | not prevented within a market (05 open q4); rejected only across `route` legs (`SelfTrade`) |
| Fees to a fee recipient | none | taker fee in bps of output, rounded up (§0.2, §4) |
| Discoverability | Horizon order-book, trades, and aggregation endpoints; every wallet | contract views and events; needs an indexer |
| Callable from contracts | no | yes (any Soroban contract can be taker or maker) |

## 3. Limitations, grouped

Each item says what SDEX gives, what PageBook does instead, why the design chose it,
who feels it, and what (if anything) is on the roadmap.

### 3.1 It is not part of the liquidity network

On SDEX, every offer on a pair is in one book that path payments, wallets, anchors and
arbitrage bots already read and cross. Liquidity pools sit beside it and path payments
cross both. A payment can convert through several assets in one operation.

A PageBook market is a separate pool of liquidity that nothing in the classic protocol
can see or cross: no path payment routes through it, no classic `ManageOffer` can hit
it, no liquidity pool interacts with it. `route` composes only PageBook markets, at
most four legs, and only when the client can pad every leg's band inside one 400-entry
footprint (§8, §14). Liquidity that lives here is fragmented from the same pair on
SDEX.

The reason is the platform boundary, not a design choice: Soroban contracts cannot
invoke classic DEX operations, and the classic protocol cannot call contracts.

This affects makers who want their quotes to serve payments and every existing
integration, takers looking for the best price across venues, and anyone relying on
Horizon's order-book endpoints. Nothing inside PageBook can change it; a bridge would
be protocol work.

### 3.2 The client has a job SDEX users never had

On SDEX you submit the operation and the protocol reads whatever it needs.

In PageBook the client simulates first (`quote_place`), then declares a footprint that
covers what the book might look like at inclusion: every `Level` key in a contiguous
band from the simulated best to a chosen `pad_end`, the bitmap words from
`start_tick`'s through `limit_tick`'s, page windows around each set level's head, the
own-side rest keys, `Order`, both fee accruals, both vault balances and the caller's
own balances (§14, ADR-020/021). It must also choose a nonce, mark archived entries for
restore, and handle typed retries (`RetryRest`). If the walk needs a level past
`pad_end` the transaction fails on the footprint (§15); this is the one residual trap.
Any in-flight change the pad did not cover ends the take gracefully rather than
failing, but the taker gets less than they asked for.

Soroban requires the read/write set at submission, and the entire storage design exists
so that this set is computable and small (§15). The residual is the price of a bounded
footprint.

Wallet and bot authors feel this most: an SDK is mandatory, and the plan's M5 crate is
the beginning of one. So do takers with liberal limits on sparse books, whose trap
probability rises with `limit_tick − pad_end`. An explicit `band_end` argument would
turn the trap into a graceful stop and is a small change; it is not done.

### 3.3 Matching depth is capped per transaction

One SDEX operation can cross deep into the book (up to the protocol's 1,000-offer work
limit), so a large market order fills in one transaction if the book has the depth.

A PageBook `place` crosses at most `MAX_LEVELS_CROSSED` levels (target 32) and reads at
most `MAX_SLOTS_SCANNED` slots at the last, partially consumed level (target 64); a
`route` shares that budget across its legs. Hitting a cap ends the walk with the
remainder refunded (§8). Sweeping a whole level costs one write regardless of how many
orders sit in it, so a deep book of few price levels fills fast, but a book spread
across many ticks needs several transactions for a large order, and every extra
transaction is another footprint to pad and another chance to race.

Every crossed level is a write and a footprint entry; the 400-entry and 200-write
per-transaction limits and the 286,720-byte per-ledger write ceiling (03) force a cap.
The caps are per market and admin-retunable (`set_market_caps`, ADR-007).

Large takers on thin, dispersed books feel this. Beyond retuning as network limits
rise (06), nothing is planned.

### 3.4 Holding an order costs money that does not come back

An SDEX offer locks 0.5 XLM of base reserve, refunded when the offer is removed.
Holding is free apart from opportunity cost, and a maker can leave offers
indefinitely.

Every resting PageBook order pays ~0.027 XLM of rent for the 120-day minimum TTL when
it rests, non-refundable. An order idle past its TTL archives; the eventual `settle` or
`replace` restores it and pays another ~0.027 (§3, §18). Levels the maker touches for
the first time cost ~0.064 XLM (§17); pages and words add more.

Soroban charges rent for persistent state; there is no refundable-reserve model.
`replace` (ADR-005) makes updates rent-free by reusing the entry, which closes most of
the churn gap, but holding itself is priced.

Small orders feel this most, since the rent is a floor per order, not per notional;
so do long-lived resting quotes and anyone used to leaving an offer in place for free.
Rent is the platform, and rent-dominated figures also scale up to 10× with network
state size (§17).

### 3.5 Makers must come back to collect

When an SDEX offer fills, both parties are credited during apply. There is nothing to
do afterwards.

In PageBook a fill moves the taker's side at apply, but the maker's proceeds and
refunds sit in the vault as unclaimed proceeds until the maker calls `settle` (§7): one
more transaction per order lifecycle, paid by the maker (~0.002 XLM, plus a restore if
the order archived). Until then, the maker's capital is neither on the book nor in
their account. `order()` previews what a settle would pay. Settle is per order; only
`replace_batch` batches.

Crediting makers during a take would put every maker's balance entry into the taker's
footprint, which is exactly the whole-book race the design was built to avoid (02,
§15). Deferred O(1) claims are the trade.

Every maker feels this, especially one with many small fills, each needing its own
settle. Nothing is planned for v1; a batched `settle_batch` would be a natural addition
and does not exist yet.

### 3.6 Custody moves into a contract

On SDEX, selling assets stay in the seller's account, reserved as liabilities. No
counterparty holds user funds.

PageBook transfers escrow into the contract's SAC balances (§6). The vault holds every
maker's escrow and every unclaimed proceed. There is no upgrade path (ADR-023), so no
admin action can move the vault, but users are trusting contract code: the
conservation invariant is tested (proptest with differential settlement), not proven.
The admin can pause the entry side of the book and retune caps; `settle` and
`collect_fees` never pause (§12).

Anyone for whom "funds never leave my account" was the point of SDEX feels this. Audits
and the design's small admin surface are the mitigation.

### 3.7 Prices and sizes are quantized, and markets are created

Any SDEX account can place an offer on any pair (given trustlines) at any rational
price with any amount. Nothing is created in advance.

PageBook markets exist only after the admin's `create_market` fixes `lot_size`,
`tick_size`, and a tick band `[tick_min, tick_max)` that must fit in 2^22 ticks; those
are frozen for the market's life (§1, §12). Orders are whole lots at whole ticks, in
`[min_order_lots, max_order_lots]`. An asset whose price moves outside the band, or
that needs finer resolution than `tick_size`, needs a new market. Two markets on the
same pair with different quantization fragment liquidity further (§0.1 allows them).

Integer ticks and lots make matching exact, with no rounding anywhere except the taker
fee (§0.2), which removes a whole class of SDEX dust and rounding artefacts, and they
let every key be computed from `(market, side, tick)`. Permissionless creation is
deferred (§20), as is a geometric-tick market type that removes the band (§20).

Long-tail pairs feel this (someone must create the market), as do volatile assets
(band exhaustion) and precision-sensitive quoting near tick boundaries. Permissionless
creation with an anti-spam fee and geometric ticks are both v2.

### 3.8 The index is allowed to lie, and users see it

The SDEX order book is exact at all times.

PageBook's tick index (`BestTick`, bitmaps) is derived and may be stale in one
direction: a level emptied by cancels keeps its bit and `BestTick` until a taker walks
through; after a sweep whose next liquidity lies far away, `BestTick` stands on the
next summary-set word's first tick rather than a live level (§5, §8). A user can see
the consequences: `best()` may report a tick with no orders; a post-only order or a
`replace` can be rejected as `Crossed` against a phantom best until a taker heals it
(§9); a take may spend one crossing slot on an empty level. All of it is bounded and
self-healing, and none of it touches funds, but SDEX has no equivalent.

Keeping the index exact would put bitmap and `BestTick` writes into `settle`, widening
its footprint and its rent; the design chose O(1) exits and lazy healing.

Post-only market makers on quiet books feel this, and so do UIs that read `best()`
without also reading `level()`. It is a documented trade-off (ADR-013, ADR-021) with
nothing planned.

### 3.9 Cheap nuisance vectors exist that SDEX does not have

Rent bounds holding K orders, not churning them: `replace` lets an attacker who has
paid rent on K nonces re-arm tombstones, stale bits, or a phantom best for ~0.001 XLM
each (§17 "Rent bounds holding, not churn", ADR-013). Every instance is capped
(`MAX_SLOTS_SCANNED`, `MAX_LEVELS_CROSSED`, one restore per stale bit) and healed by
the next taker, and the real deterrent is `min_order_lots × price`: dust rested to arm
a phantom gets filled or swept for its notional. SDEX has its own dust and spam
history, but nothing structurally like "cost one taker their crossing budget."

### 3.10 Throughput has a hard ceiling that is not the fee

SDEX capacity is the ledger's operation limit (1,000 operations per ledger by validator
setting), shared with all classic traffic; each offer is one operation.

PageBook capacity is Soroban's per-ledger write-byte budget (286,720 B): a maximal
32-level sweep is ~22 KB, so about 13 of them fit in a ledger; hundreds of rests or
settles do; ~12 full 40-quote refreshes across all users (§17, ADR-005). And because
every settling operation touches the vault's balance entry per token, all markets
sharing a token form one serialization cluster under Soroban's parallel execution
(§16), which v1 accepts. Rent-heavy costs also scale with network state size (§17).

High-frequency makers feel this most: per-ledger re-centering of a full book is not
affordable, and ADR-005 puts every-ledger refresh at ~540 XLM/day for one 40-order
book. So do venues quoting many markets in one token. Per-market vault sub-accounts
(§20) would restore parallelism; batch-auction and oracle-pegged market types are the
answer for assets that need per-ledger repricing.

### 3.11 Ecosystem and tooling start from zero

Horizon exposes SDEX order books, trades, and trade aggregations, and every Stellar
wallet renders them. PageBook's state is contract storage plus events (`rested`,
`filled`, `swept`, `settled`, `top_changed`); reading a book means an indexer, reading
a quote means `quote_place`, and placing means the padding protocol. The M5 client
crate exists; wallets, indexers, and analytics do not.

### 3.12 Smaller gaps

- No passive offers. SDEX's "don't cross an equal price" is not offered; PageBook has
  `post_only`, which fails rather than resting worse.
- No self-trade prevention inside a market (05 open q4; `SelfTrade` only across
  `route` legs). SDEX rejects `CROSS_SELF`.
- A taker fee. SDEX charges nothing to a fee recipient; PageBook charges bps of taker
  output, rounded up (§0.2), and on a 1-lot fill the ceiling can be the whole output
  (documented dust behaviour).
- Failed transactions cost real fees. A `RetryRest`, a footprint trap, or a
  cap-truncated fill costs the Soroban resource fee (~0.01 to 0.04 XLM), not 100
  stroops.
- Orders have a shelf life: 120-day minimum TTL, 180-day maximum (§18). A maker who
  wants a standing quote must extend or accept a restore at settle.
- Asset scope: SAC tokens (which include wrapped classic assets) only. The vault cannot
  receive an auth-required asset until the issuer authorizes it, and clawback reaches
  the vault (§12 "Asset eligibility"). SDEX handles those flags natively.
- An admin surface exists at all: markets, caps, pause, rotation. SDEX has no operator.

## 4. Where PageBook is not worse

- Exact matching. Integer lots and ticks: no rounding, no dust from price ratios, no
  unfavourable rounding on small amounts. The only rounding is the taker fee.
- Deterministic footprints once the pad is right; every race but one degrades
  gracefully with a typed reason.
- Update economics after ADR-005. `replace_batch` re-quotes 40 orders for ~0.03 XLM
  with zero rent; still 60 to 75 times SDEX per refresh, but a fixed, predictable cost.
- Composability. Contracts can be makers and takers; `route` is atomic across markets;
  a signed pay-in is a pure function of the arguments, so an authorization built at
  simulation survives any race (ADR-021).
- Time in force. `fill_or_kill`, `no_rest`, and `post_only` exist; SDEX offers have
  none of them.
- Fill finality without keepers. Generation-on-sweep makes "your order filled" a fact
  settle can prove from counters alone, with no crank and no expiry loop.

## 5. Summary

| Limitation | Severity for a typical user | Fixable inside PageBook? |
|---|---|---|
| Outside the classic liquidity network (3.1) | high | no (platform boundary) |
| Client must simulate and pad; residual trap (3.2) | medium; needs an SDK | mostly (band_end); trap class removable |
| Matching depth capped per tx (3.3) | medium on dispersed books | retune only |
| Non-refundable rent to hold (3.4) | medium for small or long orders | no (platform) |
| Makers must settle to collect (3.5) | medium | partly (settle batching) |
| Contract custody (3.6) | depends on trust posture | audits; small admin surface |
| Quantized, admin-created markets (3.7) | medium for long tail and volatile assets | v2 (permissionless, geometric ticks) |
| Index staleness visible to users (3.8) | low to medium (post-only makers) | design trade-off |
| Cheap nuisance vectors (3.9) | low, bounded | tune `min_order_lots` |
| Write-byte throughput ceiling, shared-token cluster (3.10) | high for HFT-style makers | v2 (vault sub-accounts, other market types) |
| Tooling from zero (3.11) | high initially | build it |

In one sentence: PageBook trades SDEX's universality, zero-effort clients, and free
holding for exactness, bounded footprints, composability, and a predictable update
cost, and it cannot become part of the classic liquidity network from inside a
contract.

## 6. Facts to re-verify before external use

- SDEX per-operation work limit on offers crossed (1,000; `opEXCEEDED_WORK_LIMIT`)
  and per-account subentry limit (1,000; `opTOO_MANY_SUBENTRIES`) are protocol
  constants that have been stable but are validator and protocol governed.
- Ledger capacity figures (1,000 classic operations per ledger; Soroban write-byte
  budget 286,720 B, 03 §Fees) are retuned by validators through the SLP process (06).
- All PageBook fee figures are the §17 estimates at August 2026 rates; the M4 fee gates
  that would pin them are not yet run (ADR-019).

Sources: [Liquidity on Stellar: SDEX and Liquidity Pools](https://developers.stellar.org/docs/learn/fundamentals/liquidity-on-stellar-sdex-liquidity-pools), [Path payments](https://developers.stellar.org/docs/build/guides/transactions/path-payments), [Horizon operation result codes](https://developers.stellar.org/docs/data/apis/horizon/api-reference/errors/result-codes/operations), [Protocol 11 improvements](https://stellar.org/blog/developers/protocol-11-improvements-stellar?locale=en), [CAP-0006](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0006.md), [Resource limits and fees](https://developers.stellar.org/docs/networks/resource-limits-fees).
