# Price quantization schemes: linear, geometric, significant-figure, log-base-2

*Research note, September 2026. Companion to `04-architecture.md` §0.2 (the linear
scheme PageBook ships) and §20 (geometric ticks, deferred to v2). Hyperliquid's rule and
the exchange tick tables in §2.3.1 are read off the published schedules listed under
Sources.*

## 1. What a scheme has to deliver

PageBook keys every `Level`, bitmap word and best-tick entry off `(market, side, tick)`,
where `tick` is a dense integer below 2^22. The matching path multiplies
`qty_lots × price_atoms_per_lot(tick)` and expects the result to be exact (§0.2). A
taker declares, ahead of time, every `Level` key in a contiguous tick band
`[t1, pad_end]` (§14), so the number of ticks inside a given price depth is a direct
footprint cost, capped by the 200 writes a transaction may hold.

A scheme is therefore judged on four things:

1. **Exactness.** Is `price_atoms_per_lot(tick)` an integer, so quote amounts need no
   rounding and the `Level` counters remain a complete fill proof?
2. **Relative tick width.** Tick as a fraction of price, across the price range a
   market will actually see. Makers need it fine enough to ladder inside the spread;
   coarser than about 10 bps and quoting degrades, finer than about 0.1 bps and levels
   go thin.
3. **Pad cost.** How many `Level` keys one percent of price depth costs, and whether
   that number is stable as the price moves.
4. **Range.** Whether a per-market band `[tick_min, tick_max)` is still needed, and what
   happens when the price leaves it (today: a new market and a liquidity migration).

The four schemes differ only in the tick-to-price function. Bitmaps, `Level`, `Order`,
settlement and the taker walk are untouched by any of them, so the choice is cheap to
change in code and expensive to change in a live market, since quantization is frozen at
creation (§1, ADR-023).

## 2. The schemes

Throughout, `p(t)` is the price of tick `t` in quote atoms per base lot. The worked
numbers use the explainer's example market: lot 10 XLM, quote USDC at 7 decimals, so
one lot at 0.158 USDC/XLM costs 1.58 USDC, or 15,800,000 quote atoms.

### 2.1 Linear (PageBook v1)

`p(t) = t × tick_size`, with `tick_size` in quote atoms per lot fixed per market.

Exact by construction: every price is an integer number of atoms and every quote
amount is a plain product. The cost is that a tick is a fixed quote amount, so its
width as a fraction of price is inversely proportional to price. The example market's
`tick_size` is 1,000 atoms per lot (0.00001 USDC/XLM):

| XLM price (USDC) | tick, relative | `Level` keys per 1% of depth |
|---|---|---|
| 0.02 | 5 bps | 20 |
| 0.158 | 0.63 bps | 158 |
| 1.58 | 0.063 bps | 1,580 |

At 0.02 a maker cannot ladder inside a 5 bps spread. At 1.58 one percent of depth needs
eight times the writes a transaction may hold, so takers must pad a shallower band and
accept a higher trap probability (§15). The band ends at `2^22 × tick_size`, which is
41.94 USDC/XLM here. Both failure modes are cured only by creating a new market with a
different `tick_size`, which is the migration problem §3.7 of `07-classic-dex-comparison.md`
describes.

Precedent: every on-chain CLOB surveyed in `01-prior-art.md` (Serum, OpenBook, Phoenix,
Manifest, dYdX v4, Injective) quantizes this way, with per-market tick and lot sizes.

### 2.2 Geometric (Liquidity Book, PageBook §20 v2 candidate)

`p(t) = p₀ × (1 + step)^(t − t₀)`, one `step` shared by every market, `t₀ = 2^21` so the
grid is centred on price 1.

Relative tick width is `step` everywhere, so one percent of depth is the same number of
keys at any price (about 100 at a 1 bps step, since `ln 1.01 / ln 1.0001 ≈ 99.5`). With
2^21 ticks either side of 1 at 1 bps the grid spans roughly 10^-91 to 10^91, so the
per-market band disappears.

The problem is exactness. `(1.0001)^k` is not an integer number of atoms for any `k`
other than 0, so `p(t)` has to be computed in fixed point (Liquidity Book uses 128.128
with exponentiation by squaring, about 22 multiplications for a 22-bit exponent) and
then `qty_lots × p(t)` has to be rounded. That breaks the §0.2 invariant that the taker
fee is the only rounding in the system, and it puts rounding inside the maker claim:
each maker's `filled_lots × p(t)` rounds separately, and the sum of maker claims must not
exceed what the taker paid. Deepstate solves the same problem with per-branch
"correction codes"; PageBook would need a stated rounding direction per side plus a
dust rule (dust to `FeeAccrual` is the natural one) and new property tests over the
`Level` fill proof. The explainer's "more complex and harder to debug" is this.

Liquidity Book gets away with it because its bins hold fungible shares, not a queue of
orders, so per-order rounding never arises.

### 2.3 Significant-figure (Hyperliquid, traditional tick tables)

Hyperliquid does not quantize with a tick size at all. A price is valid if it has at
most 5 significant figures and at most `MAX_DECIMALS − szDecimals` decimal places
(`MAX_DECIMALS` is 6 for perpetuals and 8 for spot; integer prices are always valid),
and a size is valid if it has at most `szDecimals` decimals. The effective tick is
therefore one unit in the fifth significant figure: $1 on BTC at $60,000, $0.1 on ETH
at $3,000, $0.0001 on a token at $1.5. Traditional venues do the same thing with
explicit tables (MiFID II tick-size bands, exchange price filters), stepping the tick
at price thresholds.

Cast as a dense-integer grid for PageBook, with `S = 5` significant figures applied to
the per-lot price in quote atoms:

```
d = t div 90_000            # decade
m = 10_000 + t mod 90_000   # mantissa, 10_000 ≤ m ≤ 99_999
p(t) = m × 10^d             # quote atoms per lot
```

Each decade holds 90,000 ticks, so 2^22 ticks cover 46 decades, from 10,000 atoms per
lot upward. The grid is continuous across decade boundaries (`99_999 × 10^d` is
followed by `100_000 × 10^d`).

Two properties fall out:

- **Exact.** `p(t)` is an integer for every `t`, so matching math stays plain integer
  products and §0.2 holds unchanged. This is the same reason Hyperliquid's decimal cap
  is `MAX_DECIMALS − szDecimals`: price × size then never has more decimals than the
  quote asset carries.
- **Bounded relative width.** Tick over price is `1/m`, between 1 bps (`m = 10_000`)
  and 0.1 bps (`m = 99_999`). It saws between those bounds once per decade instead of
  drifting without limit.

The example market under this grid:

| XLM price (USDC) | atoms per lot | `d`, `m` | tick, relative | keys per 1% |
|---|---|---|---|---|
| 0.02 | 2,000,000 | 2, 20,000 | 0.5 bps | 200 |
| 0.158 | 15,800,000 | 3, 15,800 | 0.63 bps | 158 |
| 1.58 | 158,000,000 | 4, 15,800 | 0.63 bps | 158 |

Pad cost for one percent of depth is between 100 and 1,000 keys depending on where in
the decade the price sits, so at `S = 5` a full percent fits the 200-write cap only while
the mantissa is below 20,000, the first ninth of each decade's ticks. `S = 4` (9,000 ticks per decade, 1 to 10 bps) keeps it
between 10 and 100 keys at every price, at the cost of coarser quoting near the top of
each decade. `S` is the one design knob and would be a global constant, not a
per-market parameter.

The per-market band is still technically present because §0.3 bounds
`level_cap × max_order_lots × p(tick_max)` for overflow, but 46 decades is far more
than any pair will traverse, so `tick_max` becomes an overflow guard rather than a
price-range choice. `lot_size` remains per market and shifts which decade a given
price lands in, without changing relative widths.

#### 2.3.1 Variants of the significant-figure grid

The grid above steps the tick by ten at every decade. That is one point in a family;
the members differ in how far the tick steps at each boundary, which sets the
sawtooth amplitude, the ticks a decade costs, and how round the prices look. All of
them keep prices as whole atoms, so all of them preserve §0.2.

**Pure significant figures.** Fixed digit count `S`, one tick per decade, tenfold swing
in relative width. The `m × 10^d` map above. Simplest to explain, roundest prices,
widest swing: the top of each decade is where one percent of depth clears the
200-write cap.

**Significant figures with linear tails (Hyperliquid).** Hyperliquid's rule as actually
stated: at most 5 significant figures, at most `MAX_DECIMALS − szDecimals` decimals,
and any integer price is valid regardless of digit count. The grid is therefore
significant-figure only in a middle band. Below it the decimal cap clamps the tick at
a floor; above 10^5 the tick is one unit, so BTC above $100,000 trades at a $1 tick,
finer than the rule alone would give. For PageBook the floor is the atom and comes for
free, and the integer ceiling is an artifact of decimal-string prices with no reason
to copy it.

**Sub-decade tick tables (1-2-5).** The tick changes at round breakpoints inside the
decade, almost always the 1-2-5 series: tick 1 on `[1, 2)`, tick 2 on `[2, 5)`, tick 5
on `[5, 10)`, then times ten. With a 5-digit mantissa:

```
segment      mantissa range      tick   ticks    relative width
[1, 2)       10_000 .. 19_999      1    10_000   1 bps → 0.5 bps
[2, 5)       20_000 .. 49_999      2    15_000   1 bps → 0.4 bps
[5, 10)      50_000 .. 99_999      5    10_000   1 bps → 0.5 bps
                                        35_000 per decade
```

The swing drops from tenfold to 2.5-fold, one percent of depth costs 100 to 250 keys
(over 200 only for mantissas in `[40_000, 50_000)`), 2^22 ticks cover 119 decades, and
every price is still a round decimal. The tick-to-price map needs a three-segment
lookup per decade instead of a division.

This is the European standard. MiFID II's RTS 11 table, in force on every EU and UK
equity venue since January 2018 (Euronext, Deutsche Börse, London Stock Exchange, SIX,
Nasdaq Nordic and Baltic, Vienna, Warsaw, Zagreb, Aquis, Equiduct), has 19 price rows
with breakpoints at 0.1, 0.2, 0.5, 1, 2, 5 and so on up to 50,000, and six liquidity
columns chosen by the instrument's average daily number of transactions. Every column
is the 1-2-5 series: the least liquid band ticks 0.01 on prices from 1 to 2, 0.02 from
2 to 5, 0.05 from 5 to 10, so relative width runs 1% down to 0.4%. Each step up in
liquidity shifts the column one 1-2-5 cell finer, not one decade, so the most liquid
band runs 2 bps down to 0.8 bps. That is the detail to take: a per-market granularity
knob in 1-2-5 steps is smoother than `S` in decades. The PageBook analogue is a
per-market column index instead of a global `S`, coarser for thin markets, still
bounded in relative width whatever the price does.

Asia uses coarser cousins. KRX ticks 1, 5, 10, 50, 100, 500 and 1,000 won at
breakpoints of 1,000, 5,000, 10,000, 50,000, 100,000 and 500,000, a 1-5 series with a
fivefold swing; TSE's TOPIX100 table has the same shape (0.1 yen below 1,000, 0.5 to
5,000, 1 above). HKEX's spread table is 1-2-5 at both ends with a flat 0.01 from 0.50
all the way to 20.00, a linear segment over which the relative tick drifts fortyfold;
SGX's is similarly irregular. US equities are a flat cent above $1 under Reg NMS
Rule 612, CME futures a fixed tick per contract, and Binance, Coinbase and the other
crypto venues a per-symbol tick adjusted by announcement when the price has moved
enough. Those three are the linear scheme of §2.1 with an operator doing the
migration by hand. No venue arrived at 1-2-5 independently the way Liquidity Book
arrived at geometric ticks; it is a regulatory construct that a whole region adopted.

**Binary mantissa.** Floating point without the fraction: `p(t) = (2^M + m) × 2^e`,
with `e = t >> M` and `m = t & (2^M − 1)`. The tick doubles at every octave, so the
swing is exactly twofold and the map is two bit operations. With `M = 13` the relative
width runs 1.22 to 0.61 bps, a decade costs about 27,200 ticks, one percent of depth
costs 82 to 164 keys, always under the cap. The cost is that ticks are not round in
decimal: 0.158 USDC/XLM lands on the grid at 0.15799296, stepping by 0.00001024. No
exchange quotes this way as far as the survey found; it makes sense only where prices
are never shown to a person. Any preferred-number series (Renard R5, R10) works as
breakpoints too, and the geometric grid of §2.2 is the limit as the steps shrink to
nothing, with roundness lost at every step along the way.

The same three example prices under each decimal variant, with the coarsest tick set
near 1 bps:

| XLM price (USDC) | pure `S = 5` | 1-2-5, 5-digit | binary `M = 13` |
|---|---|---|---|
| 0.02 | 0.5 bps, 200 keys | 1 bps, 100 keys | 0.64 bps, 156 keys |
| 0.158 | 0.63 bps, 158 keys | 0.63 bps, 158 keys | 0.65 bps, 154 keys |
| 1.58 | 0.63 bps, 158 keys | 0.63 bps, 158 keys | 1.04 bps, 96 keys |

Summary of the family, coarsest tick near 1 bps in each case:

| Variant | Relative tick, coarse to fine | Ticks per decade | Keys per 1% | Prices |
|---|---|---|---|---|
| Pure sig-fig, `S = 5` | 1 to 0.1 bps | 90,000 | 100 to 1,000 | round decimal |
| 1-2-5 table, 5-digit | 1 to 0.4 bps | 35,000 | 100 to 250 | round decimal |
| Binary, `M = 13` | 1.22 to 0.61 bps | 27,200 | 82 to 164 | unround |
| Geometric, 1 bps (§2.2) | 1 bps flat | 23,000 | 100 | irrational, rounded |

The finer the sub-decade steps, the closer the table gets to geometric's flat pad
cost, and the less round the prices. The 1-2-5 table is the point where both are still
good: pad cost inside the cap for most of each decade, a swing small enough that a
maker's ladder keeps its shape as price moves, and prices a trader would type.

### 2.4 Log-base-2 (Deepstate)

`p(t) = 2^(96 t / 2^31)` over 32-bit `t`, covering `[2^-96, 2^96)`.

Geometric with a step of `2^(96/2^31) − 1 ≈ 3 × 10^-8`, about 0.0003 bps, so prices are
effectively continuous. Every notional is rounded and the correction-code machinery
described in `02-deepstate-evaluation.md` exists to make branch aggregates agree with
the rounded leaves. It works on EVM because tree nodes are read lazily and there is no
pad band. On Soroban it is unusable as-is: one percent of depth is about 320,000 ticks,
and PageBook must declare every `Level` key in the band it walks. Listed for
completeness as the far end of the fineness axis.

## 3. Side by side

| | Linear (v1) | Geometric | Significant-figure | Log-base-2 |
|---|---|---|---|---|
| `p(t)` | `t × tick_size` | `p₀(1+step)^(t−t₀)` | `(10^4 + t mod 9·10^4) × 10^(t div 9·10^4)` | `2^(96t/2^31)` |
| Integer atoms, no rounding | yes | no | yes | no |
| Relative tick across price | `tick_size / p`, unbounded drift | constant `step` | saws in `[1/10^S, 1/10^(S−1)]`; 2.5× with a 1-2-5 table (§2.3.1) | constant, ~0.0003 bps |
| Keys per 1% depth | grows with price (20 → 1,580 in the example) | constant (~100 at 1 bps) | 100 to 1,000 at `S = 5`; 100 to 250 with a 1-2-5 table | ~320,000 |
| Per-market band needed | yes, price-range choice | no | only as §0.3 overflow guard | no |
| Per-market parameters | `tick_size`, `lot_size`, band | `lot_size` | `lot_size` | none |
| Global constants | none | `step`, `t₀` | `S` | none |
| Changes in PageBook | none | `p(t)` in fixed point, rounding policy, claim-sum proof, dust rule, tests | `p(t)` only, plus §0.3 uses `p(tick_max)` | not viable with padding |
| Precedent | Serum, OpenBook, Phoenix, Manifest, dYdX v4, Injective; US equities, CME, crypto CEXs | Trader Joe Liquidity Book | Hyperliquid; MiFID II 1-2-5 tables on every EU/UK venue; KRX and TSE 1-5 tables | Deepstate |

## 4. Assessment

Linear is the right v1: it is exact, it is what every other on-chain CLOB does, and it
is one multiplication. Its cost is operational, not algorithmic: a market whose price
moves an order of magnitude either becomes unquotable or unpaddable and needs a
migration.

Geometric fixes the drift completely but spends the property the whole design leans
on. Exactness by quantization is what lets three counters be a fill proof and what
keeps rounding out of the maker claim path. Buying constant pad cost with a
rounding policy and its proof obligations is a poor trade for a system whose
correctness argument is "there is no rounding".

The significant-figure grid gets most of geometric's benefit at none of its cost. It
is exact for the same reason linear is, needs no fixed-point exponentiation, removes
the band as a price-range decision, and holds relative tick width inside a fixed
window. Its one defect against geometric is the sawtooth: in the pure form pad cost
and quoting granularity vary by 10× within a decade. The 1-2-5 table of §2.3.1 cuts
that to 2.5× while keeping round prices, which is why traditional venues settled on it
and why makers are already used to it. If a v2 market type is ever built to replace
the band, a 1-2-5 significant-figure grid is the better candidate than §20's geometric
one, and §20 should be updated to say so.

None of this changes v1. Quantization is frozen per market, and the current markets
are linear.

## 5. Freezing the grid is the concession

`07-classic-dex-comparison.md` §3.7 and the explainer list quantization as a concession
against SDEX. Against SDEX it is, but SDEX is the outlier. Every traditional venue in
§2.3.1 quantizes price, with a flat tick, a per-contract tick or a price-dependent
table, and every one quantizes size as well: board lots of 100 shares in Tokyo and
Hong Kong, whole shares in the US, contract multiples in futures, millions in
interbank FX. Fractional shares exist only inside brokers, which fill them from
inventory rather than posting them to the exchange book. SDEX quantizes amounts at the
stroop but accepts any ratio of two 32-bit integers as a price, a set dense enough to
behave as continuous, which is why core needs rounding in the crossing computation and
why §3.7 talks about dust. The only other venues with that property are AMMs and
Deepstate-style logarithmic grids, none of them traditional.

What traditional venues do not do is freeze the grid. ESMA reassigns liquidity bands
yearly, HKEX cut its spreads in phases from 2024, SGX and JPX retune their tables, and
the SEC has been revising Rule 612. When a tick changes, resting orders at now-invalid
prices are handled by rule and liquidity stays where it is. A PageBook market cannot
retune without a new market and a migration of resting orders. The frozen grid is the
concession, and it is the gap the significant-figure and 1-2-5 grids close: they make
the per-market choice one that never needs revisiting.

## Sources

[MiFID II RTS 11 tick size table (Vienna Stock Exchange)](https://www.wienerborse.at/en/trading/trading-information/tick-size/),
[ESMA final report on the tick size regime](https://www.esma.europa.eu/press-news/esma-news/esma-publishes-final-report-tick-size-regime),
[Nasdaq Nordic MiFID II tick size regime notice](https://view.news.eu.nasdaq.com/view?id=b342eaa0fdc828c42823694e47fec1b57&lang=en),
[SIX price step overview](https://www.six-group.com/dam/download/the-swiss-stock-exchange/trading/trading-provisions/regulation/trading-guides/price-step-equity.pdf),
[HKEX Second Schedule spread table](https://www.hkex.com.hk/-/media/HKEX-Market/Services/Rules-and-Forms-and-Fees/Rules/SEHK/Securities/Rules/Sch_2_eng.pdf),
[HKEX minimum spread reduction FAQ](https://www.hkex.com.hk/-/media/HKEX-Market/Services/Trading/Securities/Overview/Trading-Mechanism/Reduction-of-Minimum-Spreads/Reduction-of-Minimum-Spreads-FAQP2_E.pdf),
[JPX sub-yen tick sizes for TOPIX100](https://www.jpx.co.jp/files/tse/news/20/b7gje6000004ndt2-att/leaflet_english2.pdf),
[KRX tick sizes](https://realtrading.com/trading-markets/krx/),
[SGX tick size cut](https://www.thetradenews.com/sgx-aims-to-boost-liquidity-with-tick-size-cut/),
[Hyperliquid API: tick and lot size](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size).
