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
`https://blob.tomerweller.com/pagebook/dashboard/?market=1` (the dashboard
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

## Status

Maker started 2026-08-19 09:34 local, trader 10:19; both run detached, their
behaviour over time is tracked by the monitor and recorded in `tools/mm/mm.log`
and `tools/mm/trader.log` (git-ignored). Findings from the longer run go in a
follow-up note.
