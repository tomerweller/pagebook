# Web client UI scenarios

A catalogue of what the one-page client is supposed to do, written so a person
or an agent can walk it end to end. Each scenario names the setup, the steps,
and what counts as a pass. The **how** column says where the behaviour is
pinned down: `unit` is vitest under `clients/web/src/**`, `e2e` is Playwright
under `clients/web/e2e/`, `manual` means it takes a browser and a live testnet
identity.

Two setups cover almost everything:

- `?mock=1` renders a canned book (PBA/PBB, ticks 97 to 104) and never walks the
  chain. Deterministic, instant, and the wallet still talks to testnet.
- `?seed=<string>` derives a disposable identity from SHA-256 of the seed and
  auto-provisions it (friendbot, then the quote trustline). Use a fresh seed
  per run; the identity is not written to localStorage unless you save it.

## A. Market view

| # | scenario | pass | how |
|---|---|---|---|
| A1 | Cold load with `?mock=1` | KPI row shows best bid 99, best ask 101, spread 2 (2.00%), mid 100, last | e2e, unit |
| A2 | Depth ladder at ≥ 960 px | bids left, asks right, cumulative bars, `tick N` on price hover, `·N` on a queue over one | manual, unit |
| A3 | Trades tape | newest first, `price × amount · quote`, tx link per row, `history from ledger N` under it | unit |
| A4 | Activity tape | `rested` / `settled` / `swept` / `top_changed` rows, each with its own colour and a short owner+nonce | unit |
| A5 | Market facts | contract, base, quote as explorer links; lot_size, tick_size, tick band, fee bps, order lots, max_levels_crossed, level_cap, paused, vault, fees | unit |
| A6 | Freshness pill | `ledger N · S s ago`; amber past 15 s; RPC text in red when a poll fails | unit |
| A7 | A side with no live levels | `— no bids in window` in place of rows, KPI still shows the contract's pointer with a `stale best` badge | manual |
| A8 | Live level past a long stale-bit trail | the level renders; it is not hidden behind phantom bits (ADR-046) | unit, manual |
| A9 | Scan gives up before the candidates run out | `more levels beyond the read window` under that side | unit |
| A10 | Narrow layout at 375 px and 320 px | one stacked book, spread row between the sides, activity and market folded, no horizontal scroll | e2e, manual |
| A11 | Pair title is the market selector | the closed control shows `BASE / QUOTE`, the open list shows `pair · id`, picking one swaps the market and rewrites `?market=` | manual |
| A12 | `?base_sym`, `?quote_sym`, `?base_dec`, `?quote_dec` | titles, column units and every amount follow the override | manual |
| A13 | `?market=` naming a market the contract does not have | `? / ?`, `no Market entry`, empty panes, no error spew | manual |
| A14 | `?market=abc`, `?depth=abc`, `?base_dec=-1` | the parameter reads as absent and the default is used | unit |
| A15 | Unreachable `?rpc=` | `RPC host: Failed to fetch` in the pill, wallet disabled with the same reason | manual |
| A16 | Non-testnet `?rpc=` | book still renders, wallet shows `wallet disabled: not testnet` | manual |
| A17 | Contract id that is not an address | the error names the problem in the pill; the page stays up | manual |

## B. Identity

| # | scenario | pass | how |
|---|---|---|---|
| B1 | No identity | intro copy, `generate`, `import`, and `use seed` when `?seed=` is present | unit |
| B2 | `generate` | a `key N` identity appears, secret revealed once, friendbot funds it, the quote trustline is added, both land in the log with tx links | manual |
| B3 | `generate` from the keys panel with an identity already active | a second identity is created and selected; the switcher lists both | unit, manual |
| B4 | `import` a valid `S…` secret | identity added and selected, no provisioning (an imported key is assumed funded) | unit |
| B5 | `import` something that is not a secret | `that is not a secret key — paste the 56-character S… string` | unit |
| B6 | Identity switcher | balances, orders, ticket preview and own-order marks all reset to the new identity | unit |
| B7 | `reveal secret` / `hide` / `copy` | secret shown only on request; copy writes the clipboard | manual |
| B8 | `delete` | asks first; `cancel` keeps the key, `delete` drops it and falls back to the next identity | unit, manual |
| B9 | Reload | a saved identity comes back from localStorage without `?seed=`; the intro pane does not flash | unit |
| B10 | `?seed=` identity | shows as `(seed)`, is not persisted, and `save` promotes it to `key N` | unit |
| B11 | Unfunded account | `friendbot` button, then balances after it lands | manual |
| B12 | Missing quote trustline | `add trustline` with a confirm step naming the 0.5 XLM reserve | manual |

## C. Place ticket

| # | scenario | pass | how |
|---|---|---|---|
| C1 | Side toggle | `BUY`/`SELL` swap classes, CTA text, and the price label's token order | unit |
| C2 | Price and quantity steppers | ± one tick and ± one lot, snapped to the market's quantization | unit |
| C3 | Tap a ladder row | the ticket takes the opposite side, the price fills in, quantity takes focus, and the sheet opens at 375 px | e2e |
| C4 | Snapping | an off-tick price shows `= tick N · <snapped price>` and places at the snapped tick | manual |
| C5 | Preview | `takes N lots · M levels`, average, taker fee, remainder disposition, padded fee estimate | unit, e2e |
| C6 | `post-only` that would take | preview says crossed, and the contract's own rejection reads `crossed the book: a post-only order would have taken` | unit |
| C7 | `fill-or-kill` short of a full fill | remainder line says `unfilled` | unit |
| C8 | `no-rest` | remainder line says `refunds`, nothing rests | e2e |
| C9 | Quantity below the market minimum, or above the maximum | place disabled with `min 1 lot = …` / `lots outside …` | manual |
| C10 | Price outside the tick band | place disabled with `tick outside the band [min, max)` | manual |
| C11 | Bid larger than the quote balance | place disabled with `need X USDC for this bid`, plus `you hold XLM only — try sell` when the balance is zero | manual |
| C12 | Ask larger than the base balance | place disabled with `need X XLM for this ask`; a native base keeps the fee headroom back | unit |
| C13 | Under 0.2 XLM spendable | place disabled with the padded-fee reason | unit |
| C14 | Garbage, negative or empty quantity | lots read as zero, place disabled, no crash | manual |
| C15 | Confirmed take | strip reads `confirmed · took N lots · <quote amount> · fee <XLM>` with a tx link; balances move | unit, e2e |
| C16 | Confirmed rest | strip adds `· rests`, the order shows up in open orders and as an own row in the ladder | e2e |
| C17 | Acknowledge | tapping the strip returns the place button | unit |
| C18 | SAC failure | reads as a sentence (`not enough token balance for this order`), not `BalanceError` | unit |

## D. Open orders

| # | scenario | pass | how |
|---|---|---|---|
| D1 | No orders | `— no open orders` | unit |
| D2 | Order row | side, tick, human price, lots, filled, refund, age in ledgers, and `archived` when the entry is cold | unit |
| D3 | Swept queue | the row warns that settle returns filled + refund | unit |
| D4 | Settle | confirm step shows `claim +A · +B`, then a confirmed strip with a tx link, then the row is gone | e2e |
| D5 | Replace | price and quantity steppers, `bid` and `post-only` toggles, net delta, padded fee | e2e |
| D6 | Replace that would cross with post-only on | replace disabled, reason shown | manual |
| D7 | Replace the wallet cannot escrow | replace disabled with `need X USDC for this replace` | unit |
| D8 | Batch replace | select two or more, `± ticks` requote around mid, one transaction for all of them | manual |
| D9 | One of the selected orders settles | it stops counting: the panel falls back to `select 2 or more to batch` | unit |
| D10 | Over the batch cap | the checkbox refuses and unticks itself | unit |
| D11 | Own-order marks | own ladder rows carry a dot, own tape rows are marked, and an order outside the read window gets an `▲ N asks above` chip that opens the sheet at that order | unit, e2e |
| D12 | Fill awareness | a fill that lands while the page is open adds `· N fills` and a dot to the wallet strip; opening the sheet to orders clears it. Fills that predate the session are not badged | unit |

## E. Shell

| # | scenario | pass | how |
|---|---|---|---|
| E1 | Wallet strip and sheet under 960 px | strip is sticky at the bottom, shows bests and the order count; tapping it opens the sheet; confirmations stay inside the viewport | e2e |
| E2 | Desktop rail at 1440 px | wallet is a right rail, no instrument strip, no horizontal overflow | e2e |
| E3 | Polling | one walk per new ledger, 5 s while the tab is hidden, immediate on return, exponential backoff on RPC failure | manual |
| E4 | Console | no errors or unhandled rejections through any of the above | e2e |
| E5 | Brand link | `PAGEBOOK` goes to the explainer (`explainer/`, published beside the client, so it 404s under `vite dev`) | manual |

## Run of 2026-09-10

Executed against the live testnet deployment (`CAMH…56F4`, market 0 XLM/USDC)
plus `?mock=1`, at 1440, 776, 375 and 320 px. Eight scenarios failed; all eight
are fixed, and each fix landed with the test named above.

| scenario | what happened | fix |
|---|---|---|
| A8, A9 | One live ask sat behind 137 phantom bits. The walk read 76 candidates, found none live, and rendered `— no asks in window`, with `more levels` staying quiet because every *word* had been read | round-based level scan, and the note now also fires on unscanned candidates (ADR-046) |
| A14 | `?market=abc` put NaN in a ledger key: `RPC …: unsupported ck field: NaN` and a dead page. `?depth=abc` was worse: the KPIs showed a book while both ladder sides read `— no … in window` | `src/params.ts`: a numeric parameter that is not a plain integer in range reads as absent |
| C15 | `confirmed · took 1 lots · 17852000 quote atoms · fee 74152 stroops charged`, so a wrong plural plus raw atoms in the one line a trader reads after paying | `countLabel` and `formatAtoms`, atoms kept in the title |
| C18, D7 | A replace the wallet could not escrow was offered, submitted, and came back as `BalanceError` | `validateReplace` disables the button with the reason; SAC error names now carry sentences |
| D9 | A settled order kept its tick in the batch selection, so the panel showed `replace selected` over a single live order and the button submitted nothing | the panel counts live rows, and a refresh prunes settled nonces |
| B5 | A bad secret surfaced the SDK's `invalid version byte. expected 144, got 147` | `that is not a secret key — paste the 56-character S… string` |
| B3 | `generate` disappeared once an identity existed, so the switcher could only ever grow by import | the keys panel offers `generate` too |

Two behaviours look like bugs and are not:

- With a stale `best_ask` pointer, the KPI keeps showing the pointer's price
  with a `stale best` badge while the ladder shows the live levels above it.
  The pointer is what a taker's sweep starts from, so the KPI reports it.
- The trades tape marks a row as yours when your own transaction was the
  taker. A fill against your resting order is someone else's transaction, so
  it is not marked; the order row's `filled` is what moves.
