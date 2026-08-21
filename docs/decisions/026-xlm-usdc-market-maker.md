# 026: XLM/USDC testnet market and a price-fed market maker

Date: 2026-08-19. The first market on the testnet deployment with real-world
assets and a real price: native XLM against Circle's testnet USDC, quoted by a
bot off the spot XLM-USD price. The point is to watch the design carry a
living two-sided book over time, not to test a single path.

## The market

Market 1 on `CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO`:

- base: native XLM, SAC `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`
- quote: `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` (Circle's
  testnet issuer, not auth-required), SAC
  `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` (already deployed)
- `lot_size` 100,000,000 stroops (10 XLM); `tick_size` 1,000 quote atoms per
  lot, so one tick is 0.00001 USDC per XLM (about 0.6 bps at 0.158); band
  [1, 4,194,304), the whole tick index, up to 41.9 USDC per XLM; taker fee 5
  bps; 1 to 1,000,000 lots per order.

Why this geometry: the bot wants to quote a 5 to 10 bps spread and ladder at
5 bps steps, which needs sub-bps ticks; 10-XLM lots keep the minimum order
at about 1.6 USDC. The cost is band padding for takers, 1 Level key per tick:
a taker sweeping 1% of depth declares about 160 keys (under the 400-entry
cap, about 0.045 XLM of padded write-entry fees).

## Funding without a faucet

The maker `pb-mm` (`GAV6TNH2DIK4MDH2RZRXH6N2KF24VT4WIZNRQJYZKJSIEGGG2RCQV3QT`)
holds friendbot XLM from itself and three helpers (39,970 XLM) and USDC bought
on the testnet classic DEX by four helpers with `path-payment-strict-send`
(native to USDC, into `pb-mm` directly): 39,600 XLM became 70,435 USDC, path
finding having found a far better route than the direct order book showed.
Test money; the number only says the inventory is ample. Stellar CLI 27.1
builds, signs and submits all of these classic operations (`stellar tx new
change-trust | path-payment-strict-send | payment`).

## The bot (`tools/mm/mm.py`)

Reuses the soak's CLI pipeline (build, simulate, pad, sign, send) and pads.
Every 30 s: fetch spot XLM-USD (Coinbase, Kraken fallback); compute a
20-level ladder per side, slot i at 4 + 5i bps from the mid, 25 + 12i lots
(250 XLM at the touch, 2,530 XLM at 1%; about 27,800 XLM per side); lean the
mid up to 3 bps against inventory accumulated since start; check the touch
slots (all slots every 8th cycle) through the `order` view for fills;
`replace` (batches of 8, atomic, falling back to singles) slots whose target
moved by 4 ticks (8 deeper) or that filled, `place` missing slots (6 per
cycle), post-only throughout. With a stale feed (4 min) it pulls the book
rather than quote blind; `--cancel-all` settles everything; state
(`tools/mm/state.json`) survives restarts. `tools/mm/check.py` audits from
outside: bot alive, its mid within 50 bps of an independent fetch, own quotes
straddling the mid within 40 bps, recorded bests consistent (a crossed pair of
recorded bests is checked against the levels' `open_lots` to tell a phantom
from a real cross), no footprint / unknown-trap / tool errors in the last
hour, fee reserve. A session monitor runs it every 30 minutes.

Two things worth recording from the first hour:

1. **A post-only never walks.** With `start_tick` at the worst tick of the
   band the walk's loop condition is false on entry, so a post-only place
   declares only own-side keys, the `Order`, both fee accruals and both
   tokens' entries: no band, no `quote_place` call. The bot's places and
   replaces are cheap and book-independent.
2. **Re-quoting manufactures phantom bests, and the maker heals them.** Each
   `replace` empties the old level and leaves its bit set (§9 never clears on
   settle). When the old tick was the recorded best, `BestTick` now points at
   an empty level, and the maker's own post-only on the other side fails
   `Crossed` against it. The bot answers with the documented healing path: a
   1-lot no-rest take at the phantom tick, whose walk clears the bit and
   advances `BestTick` (one level per heal, then the post-only lands). About
   one heal per trending cycle, 0.02 XLM each. It is the design working as
   written, and a measurable cost of the lazy index for a re-quoting maker;
   a future `replace` could clear the bit it just emptied when it knows the
   level is empty (its own order was the last), which would remove this class
   of heal. Not changed here.

The live book is at
`https://blob.tomerweller.com/pagebook/client/?market=1` (the dashboard
labels a phantom recorded best "stale best").

## The trader (`tools/mm/trader.py`)

Traffic against the maker from a second identity, `pb-trader`
(`GCLDONZH4JYF2OF7LXZDM3YANP6SG2SUDPHDOEYRZLVX6NSSG2LSWTEF`, 29,980 XLM and
17,594 USDC, funded the same way). Every 20 to 75 s, at random: an
immediate take (`no_rest`) at the touch (1 to 12 lots, 60%), through about
two levels (20 to 80 lots, 30%), or a deeper sweep of four to six levels (100
to 260 lots, 10%); or, 15% of the time, a small resting order inside the
spread that it settles two to six minutes later. Each take goes through
`quote_place` and the full §14 band pad (`tools/soak` `pad_keys`), so the
taker side of the padding protocol now runs continuously against a moving,
re-quoting book. Fills are read from the transaction's `return_value` in
`TransactionMeta` (`tx send` and RPC 23's `getTransaction` do not surface
it). `check.py` reports the trader's last-hour traffic next to the maker's and
alerts on any footprint, unknown-trap or tool error on either side.

A take that lands on a phantom recorded best fills nothing and heals it (the
walk clears the bit and advances `BestTick`), so the organic flow now does
some of the index housekeeping the maker was doing with its 1-lot heals.

## Findings from the first hours

**A trend turns the phantom cost from a nuisance into a lag.** With the price
up 40 bps in a few minutes the maker's bid ladder fell 100 bps behind the
mid. Every re-quoted ask leaves its old level empty with the bit set; in a
trend the old ask ladder is a trail of up to 20 phantom levels between the
bids' new targets and the recorded best ask, and the one-level-per-take heal
could not clear it as fast as the quotes needed to move (189 heals and 241
`Crossed` simulation rejections in the hour). Two changes to the bot:

- heal with **one walk to the target tick**: a 1-lot no-rest take whose limit
  is the tick the post-only wants; the walk clears every phantom level up to
  it (at most `MAX_LEVELS_CROSSED` = 32 per take, chunked at 150 ticks of band)
  and advances `BestTick` past them in one transaction (the first such heal
  cleared 30 levels at once);
- heal **proactively**, before the re-quotes of a cycle, whenever a side's
  target touch crosses the recorded opposite best.

One such heal was rejected `TxSorobanInvalid`: its pad had ~120 band `Level`
keys plus three page keys for each of 31 phantom levels, over the 200
read-write-entries per-transaction cap. The pad now skips page keys for
crossed levels simulation saw empty (§14 already says fresh or empty queues
are inline), which also tightens the soak's `pad_keys` when asked to.

**Declared instructions must budget the footprint itself.** A heal with 171
read-write keys and a small simulated walk failed `ResourceLimitExceeded` by
169 instructions: 24,794,729 used against 24,794,560 declared. The pad had
declared simulation x1.2 plus 100k per padded key plus 300k, so the host's
per-footprint-entry cost is right at 100k instructions whether or not the
entry exists, and the margin must not scale with the simulated walk (which
was a tenth of the total). The pad now declares 120k per padded key plus 1M
flat (under 0.001 XLM per transaction at 7 stroops per 10k). §17's "per
padded key" line should count instructions as well as the write-entry fee.

A second rally (2% in ~20 min) showed one heal per cycle is not enough
either: each walk clears at most 32 phantom levels while a fast trend
manufactures more than that per 30 s cycle, and the bid ladder pinned until
the trail cleared. The proactive heal now loops (up to 6 walks per cycle,
each from the new recorded best) before the cycle's re-quotes; the pinned
ladder caught up 190 ticks in two cycles when deployed mid-rally.

The design-level observation stands: a maker that re-quotes a ladder
manufactures phantom bests at the rate it moves, and under the lazy index
someone has to walk them. A `replace` that clears the bit of the level it has
just emptied (it knows: its own order was the last, `open_lots` hit zero)
would remove the whole class for the common case at the cost of one word
write per such replace. Worth a decision note before any mainnet thought;
not changed here.

## Status

Maker started 2026-08-19 09:34 local, trader 10:19; both run detached, their
behaviour over time is tracked by the monitor and recorded in `tools/mm/mm.log`
and `tools/mm/trader.log` (git-ignored).

Steady state after ten hours (through two 2%-range trends and the fixes
above): 40 quotes always live, touch 5 to 12 bps around the spot mid; 547
maker fills for 13,586 lots (about 136,000 XLM traded); heals settled at 30
to 55 per hour, about one per re-quoting cycle; trader landing 60 to 70
takes per hour with zero rejections. Since the two headroom fixes, zero
footprint failures, zero unexplained traps, zero apply-time rejections other
than in-flight `Crossed` on post-onlys, and the only tool-level failures are
isolated RPC hiccups (a submission timeout, a 502, a captive-core 404). The
maker's inventory oscillates with the trader's random flow and the 3 bps skew
pulls it back; fee accrual stays in the vault (`collect_fees` is manual).
