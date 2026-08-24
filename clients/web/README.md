# pagebook-web

A one-page trading client for the PageBook testnet experiment. The main pane
is the market view: KPIs, depth, trades, activity, facts. The side pane is an
embedded wallet: a keypair the page generates and stores in the browser, plus
balances, a place ticket, and open-order settle/replace.

This is a testnet experiment. Keys are disposable. Do not use it with real
funds.

Published at [tomerweller.com/pagebook/client](https://tomerweller.com/pagebook/client/).

## Quickstart

From this directory:

```
npm ci
npm run dev
```

Then open the printed localhost URL. Other commands:

```
npm test
npm run build
npm run e2e
```

`make web-test` and `make web-build` from the repo root wrap the test and
build steps. Node tooling stays in this directory.

## Testing with `?seed=`

`?seed=foo` derives a keypair from SHA-256 of the UTF-8 seed string. The
identity appears as `(seed)` and is not written to localStorage unless you
save it. Playwright and other headless runs use this so they do not depend
on a stored secret.

## URL parameters

| param | default | what it does |
|---|---|---|
| `contract` | `CDX3…U2RO` | PageBook contract id |
| `market` | XLM/USDC if present, else `0` | market id; the header selector changes it |
| `rpc` | `https://soroban-testnet.stellar.org` | Soroban RPC URL |
| `depth` | `12` | levels kept per side after empty levels are dropped |
| `mock` | off | `?mock=1` renders a canned book and does not walk the chain |
| `seed` | off | derive and activate a disposable identity |
| `base_sym`, `quote_sym` | from SAC `METADATA`, else a short address | token labels |
| `base_dec`, `quote_dec` | from SAC `METADATA`, else `7` | decimal places for amounts |

Example: `/?market=1&seed=demo`.

## How a write is built

Every write goes simulate, then pad, then submit. `quote_place` (or a view)
returns the levels and pages the walk touched. The pad adds the opposite-side
band, consume/append windows, both tokens, and promotes read-only keys the
book might write in flight. Architecture §14 is the spec.

## Wallet caveats

The page holds its own ed25519 keypair. Secrets live in localStorage under
`pagebook.wallet.v1`. The pane only activates when RPC reports the testnet
passphrase (`Test SDF Network ; September 2015`). Treat every key as
throwaway.

## Known limits

- `route` is not in the UI.
- Archived-entry restore is implemented and unit-tested; it has not been
  checked against a live archived order on testnet.
- Public testnet RPC keeps a short event window and may throttle.
