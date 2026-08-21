# 029: web client, embedded wallet, Pages workflow

Date: 2026-08-21. The read-only dashboard is now “client”: a one-page TypeScript client with an
in-page testnet wallet. This note records the choices that are not already
in `docs/client/CLIENT-PLAN.md`.

## One page, wallet in the side pane

The market view stays the main pane. The wallet is a side pane on the same
URL. A visitor with no key loaded still gets the read-only book. Putting
the keypair in the page (generate or `?seed=`) was a testnet choice:
Playwright and a soak can drive the full loop without an extension or a
custody model. The pane refuses to sign unless RPC reports the testnet
passphrase. This is not a wallet for real funds.

## TypeScript ports with fixture parity

`keys`, `decode`, and `pad` were rewritten from the `.mjs` / Rust
references. Decode fixtures match `pagebook-types`. Ledger-key XDR matches
the old `keys.mjs`. Pad / settle / replace / restore_marks strings match
`pagebook-client` `js_fixtures`. The padding editor copies `soak.py`
`apply_pad` (promote, write-entry fee, instruction headroom).

## Pages

The page moved from `/pagebook/dashboard/` to `/pagebook/client/` (renamed with the trading release; no redirect, the old URL had no users). Source moved from
`docs/client/` to `clients/web/` (Vite). `.github/workflows/pages.yml`
assembles `docs/` plus the Vite output. The reviewer flips the GitHub
Pages source to Actions.

## Engine soak

`clients/web/soak/engine-soak.ts` drove the same TS engine against market 0
(PBA/PBB) with `pb-maker` and `pb-taker`: 217 submissions over ledgers
4,264,541 to 4,264,699. Tally: 153 ok, 32 `LevelFull` at simulation, 31
`UnknownOrder` at simulation (settle of `no_rest` fills that never rested),
1 `Crossed` at simulation, 0 footprint failures.

## Not verified

- Live restore of an archived `Order` / `Level` (unit-tested only; ADR-025
  runbook still applies).
- `route` in the client.
