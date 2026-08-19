# Market status dashboard: plan

A read-only, single-file web page that shows the live state of one PageBook
market and refreshes itself every ledger. No server, no build step, no wallet.

## Decisions (already made)

| Question | Answer |
|---|---|
| Stack | One static file, `tools/dashboard/index.html`: vanilla ES-module JS, `@stellar/stellar-sdk` from a CDN for XDR/ScVal/StrKey and the RPC client. Same shape and palette as `docs/index.html` (bid green, ask red, paper background). |
| Content | Top of book (best bid/ask, spread, mid), depth ladder (N levels per side), trades tape (`filled` events), activity feed (`rested`/`settled`/`swept`/`top_changed`), market facts (Market config, vault balances, accrued fees, paused flag). |
| Data path | Book state from ledger entries via `getLedgerEntries` (BestTick, TickSummary, TickWord, Level, Market, Config, SAC balances). Events via `getEvents`. JS port of the packed `Level` / `TickBitmap` decoders. |
| Target | Defaults to testnet, contract `CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO`, market 0, RPC `https://soroban-testnet.stellar.org`. Overridable with `?contract=&market=&rpc=&depth=`. |

## What the page shows

```
┌ PBA / PBB · market 0 · testnet · CDX3…U2RO         ledger 4,215,102 · 3 s ago ● ┐
│ best bid 99   best ask 101   spread 2 (2.0%)   mid 100.0   last 100 × 3 lots     │
├──────────────────────────── depth ────────────────────────────────────────────────┤
│  bids (tick · lots · queue · cum)     │  asks (tick · lots · queue · cum)         │
│  99   40  3  ▮▮▮▮▮▮▮▮ 40              │  101  12  1  ▮▮▮ 12                       │
│  98   25  1  ▮▮▮▮▮ 65                 │  102  30  2  ▮▮▮▮▮▮▮ 42                   │
│  …                                    │  …                                        │
├──────────── trades (filled) ──────────┼──────────── activity ─────────────────────┤
│ 12:04:31  buy  100 × 3   300 PBB  tx… │ 12:04:31 rested  pb-maker#17 bid 99 g4 s2 │
│ 12:04:26  sell  99 × 5   495 PBB  tx… │ 12:04:26 top_changed asks 101→102          │
├──────────── market ───────────────────┴───────────────────────────────────────────┤
│ lot 1 · tick 1 · band [1, 65536) · fee 10 bps · min/max 1 / 1,000,000 lots        │
│ caps: 32 levels · 64 slots · 32 inline + 1×32 page     paused: no                  │
│ vault: 1,234 PBA · 56,789 PBB      fees accrued: 7 PBA · 0 PBB                     │
└───────────────────────────────────────────────────────────────────────────────────┘
```

Prices are shown as ticks and, when `tick_size`/`lot_size`/token decimals are
known, as human quote-per-base. Every number that comes from an i128/u64 goes
through `BigInt` and is formatted at display time; no float math on amounts.

## How it reads the chain

All keys are computable offline (architecture §14); the page never needs a
signer or a source account.

**Ledger keys.** `DataKey` is a `#[contracttype]` enum, so a key is
`ScVal::Vec([Symbol(variant), fields…])` in `contract_data` with `persistent`
durability, exactly what `tools/soak/soak.py::ck()` builds. Port `ck` and
`order_key` to JS with `xdr.LedgerKey.contractData(...)`. Config lives in
instance storage: read the contract instance entry and pull `Config` out of the
instance storage map. Vault balances: `Balance(vault)` on each SAC (also
persistent contract data). Token metadata (symbol, decimals): the SAC instance
entry's `METADATA` value; fall back to `?base_sym=&quote_sym=&decimals=` if the
layout differs from what I expect.

**Decoders (JS port of `crates/pagebook-types/src/packed.rs`).**

- `Level`: 285 B, `[version u8][generation u32][head_seq u32][tail_seq u32][head_consumed u64][open_lots u64][32 × slot u64]`, little-endian. Only the header matters for the ladder; queue length is `tail_seq − head_seq`.
- `TickBitmap` (`TickSummary` and `TickWord`): 257 B, `[version u8][256 B bits]`, bit `i` at `bits[i >> 3] & (1 << (i & 7))`. Word `w` covers ticks `[w·2048, (w+1)·2048)`; summary bit `w` means word `w` has any bit.
- `BestTick`, `Market`, `Config`, `Order`, `FeeAccrual`: plain contracttype structs, decode with `scValToNative`.

**Depth walk (per side, per refresh).**

1. Batch 1: `BestTick(bid)`, `BestTick(ask)`, `TickSummary(bid)`, `TickSummary(ask)`, `Market`, contract instance, both `Balance(vault)`, both `FeeAccrual`. One `getLedgerEntries` call (max 200 keys per call, this is ~10).
2. Batch 2: from each side's summary, list set words starting at `word(best)` and moving away from the book (bids descend, asks ascend); read the first K words per side (K = 4 covers 8,192 ticks; more than enough for the soak's ±3-tick action).
3. Batch 3: enumerate set ticks in book order from `best` outward, take the first `2·depth` candidates per side (some bits are stale-better over empty levels, architecture §5), read their `Level`s, keep `open_lots > 0`, show the first `depth` (default 12).
4. `BestTick.empty` on a side ⇒ that side renders empty; a best whose level reads `open_lots == 0` is shown as "stale best" in a small badge, which is exactly the state the soak's spam thread manufactures.

Three round trips per refresh, ~1 KB each. `latestLedger` from the response
drives the freshness pill; a mismatch between batches (ledger advanced mid-read)
just triggers one more pass.

**Events.** `getEvents` with `filters: [{type: "contract", contractIds: [C], topics: [["*", {u32: market}]]}]`, `startLedger = latest − 2,000` on first load (bounded by RPC retention; show "history from ledger N"), then `cursor` paging every poll. Topic 0 is the event name symbol, topic 1 the market id; data is a `Vec` decoded with `scValToNative`. `filled.side` is the makers' side (§13), so the tape prints the taker side flipped ("buy" when asks were consumed).

**Cadence.** Soroban RPC has no push channel. Poll `getLatestLedger` every 2 s; when the sequence advances, run the depth walk and the events poll. Back off to 10 s after an RPC error, show the error inline, keep the last good state on screen. Pause polling when the tab is hidden (`visibilitychange`).

## File layout

```
tools/dashboard/
  index.html        the page: markup, CSS, and one <script type="module">
  keys.mjs          DataKey → LedgerKey builders (ck, orderKey, sacBalanceKey, instanceKey)
  decode.mjs        Level / TickBitmap decoders, ScVal→native wrappers, formatting
  book.mjs          the depth walk and event polling (pure functions over an RPC client)
  fixtures.json     hex fixtures produced from the Rust encoders (see Testing)
  decode.test.mjs   node --test: JS decoders reproduce the Rust fixtures
  README.md         how to open it, URL params, what each panel means
```

`index.html` imports the three `.mjs` files with relative paths, so the folder
works from `file://` after a `python -m http.server` (module scripts need
http), from GitHub Pages, or wherever `docs/index.html` is published today.
The CDN import is the only network dependency besides RPC; pin the version.

## Steps

1. **Plumbing and mock mode.** Key builders, decoders, RPC wrapper, `?mock=1`
   that feeds a canned snapshot so the UI can be built without testnet. Ship
   `decode.test.mjs` green against `fixtures.json`.
2. **Top of book + depth ladder** from live entries. Verify by hand against
   `stellar contract invoke … best/level` on market 0 while the soak runs.
3. **Trades tape + activity feed** from `getEvents`, cursor paging, dedupe by
   `(txHash, event index)`.
4. **Market facts panel**: Market, Config.paused, vault balances, fee accruals,
   token symbols/decimals.
5. **Polish**: freshness/error states, hidden-tab pause, URL params, README,
   dark mode via `prefers-color-scheme` (the explainer's palette already has
   the tokens). Run copy through the humanizer skill before publishing (repo
   rule; the skill is not loaded in this session, so I will flag it at the end
   if it is still missing).

Roughly a day of work; steps 1 and 2 are the bulk.

## Testing

- **Decoder parity.** Add a `#[test]` in `pagebook-types` (or a tiny example
  binary) that encodes a handful of `Level` and `TickBitmap` values at
  interesting occupancies and prints them as hex; check that output in as
  `fixtures.json`. `node --test tools/dashboard/decode.test.mjs` decodes them
  and asserts field-by-field. This is the one place a silent mismatch would
  make the dashboard confidently wrong.
- **Key parity.** Same idea for keys: `soak.py::ck` and the JS `ck` must
  produce identical base64 `LedgerKey` XDR for a few sample keys; assert
  against strings captured from `stellar contract read --key`.
- **Live check.** Open the page against market 0 during a soak run and eyeball
  the ladder against `best`/`level` invocations; place one rest from `pb-maker`
  and watch it appear within one ledger.

## Out of scope for v1

Order lookup by owner/nonce, per-owner positions, historical charts, multiple
markets side by side, any write path. Trivial to add later since the keys are
computable, but not "simple read-only status".

## Risks and open points

- **RPC retention and rate limits.** Public testnet RPC keeps a limited event
  window and may throttle; the page tolerates both (bounded history, backoff)
  but a long-running tab may see gaps. A self-hosted RPC fixes it.
- **SAC metadata layout.** If `METADATA` in the SAC instance is not where I
  expect, the fallback is URL params; no blocker.
- **Stale bits.** The ladder must never trust a set bit alone; always read the
  Level and check `open_lots`. Baked into the walk above.
- **Contract address churn.** Every redeploy is a new address (ADR-023). URL
  params cover it; the README notes the current default.
