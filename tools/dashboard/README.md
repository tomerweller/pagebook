# Market status dashboard

A static page that reads one PageBook market from Soroban RPC and redraws when the ledger advances. There is no server, wallet, or build step.

## Open it

From the repository root:

```
python3 -m http.server 8765
```

Then open `/tools/dashboard/`. Module scripts do not load from `file://`.

Defaults point at the current testnet deployment, contract `CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO`, market 0.

## URL parameters

| param | default | what it does |
|---|---|---|
| `contract` | `CDX3…U2RO` | PageBook contract id |
| `market` | `0` | market id |
| `rpc` | `https://soroban-testnet.stellar.org` | Soroban RPC URL |
| `depth` | `12` | levels kept per side after empty levels are dropped |
| `mock` | off | `?mock=1` renders a canned snapshot and does not touch the network |
| `base_sym`, `quote_sym` | from SAC `METADATA`, else a short address | token labels |
| `base_dec`, `quote_dec` | from SAC `METADATA`, else `7` | decimal places for amounts |

Example: `/tools/dashboard/?market=0&depth=8&base_sym=PBA&quote_sym=PBB`.

## What the panels are

**Header.** Token pair, market id, contract short form, and the ledger sequence with how many seconds ago the last good read landed. The pill is green while that read is under 15 seconds old, amber after that, red on an RPC error. An error keeps the last good book on screen.

**KPIs.** Best bid, best ask, spread in ticks and as a percent of mid, mid tick, and the newest `filled` event as price × lots. A "stale best" badge means `BestTick` points at a level whose `open_lots` is 0.

**Depth.** Bids on the left (best first, descending), asks on the right (best first, ascending). Each row is tick, human price, open lots, queue length (`tail_seq - head_seq`), and cumulative lots with a bar.

**Trades.** `filled` events, newest first. Time is `ledgerClosedAt`. The printed side is the taker's: the event's `side` is the makers' side, so consumed asks are a buy and consumed bids are a sell. Quote atoms, ledger, and a short tx hash link out to stellar.expert on testnet.

**Activity.** `rested` (owner, nonce, side, tick, generation, seq), `settled` (owner, nonce, filled_lots, refunded_lots), `swept` (side, tick, generation), `top_changed` (side, old → new).

**Market.** Fields from the `Market` entry, `Config.paused` from instance storage, vault SAC balances, and `FeeAccrual` per token.

## How it reads the book

Every two seconds the page calls `getLatestLedger`. When the sequence changes it walks depth (three `getLedgerEntries` batches: bests/summaries/market/instance and, when known, vault balances and fee accruals; then `TickWord`s outward from best; then candidate `Level`s) and pages `getEvents` with a cursor. The first event load starts at `latest - 2000`, or later if the RPC rejects that ledger as outside retention.

A hidden tab still calls `getLatestLedger` every 5 seconds and only walks when the sequence moves. RPC errors back off exponentially up to 10 seconds.

u64 and i128 values stay `BigInt` until they are formatted. Packed `Level` and `TickBitmap` bytes are decoded in `decode.mjs`; those fixtures are asserted in both `decode.test.mjs` and `crates/pagebook-types` (`js_fixtures`).

## Known limits

- Public testnet RPC keeps a short event window and may throttle. A long-lived tab can miss events between polls.
- A redeploy is a new contract address. Pass `?contract=`.
- If a SAC's instance `METADATA` is not the usual `{symbol, decimal, name}` map, set `base_sym` / `quote_sym` / `base_dec` / `quote_dec`.
- No order lookup, no charts, no writes. The page never needs a signer.

## Check the decoders

```
node --test tools/dashboard/decode.test.mjs
cargo test -p pagebook-types js_fixtures
```
