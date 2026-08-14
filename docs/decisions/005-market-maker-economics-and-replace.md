# 005 — Market-maker economics: why `replace` exists

Date: 2026-08-14. Prompted by the question "what does it cost a market maker to update
their entire order book?", answered with the ADR-004 fee model and the classic Stellar
DEX as the behavioral baseline.

## The baseline: how makers behave on classic SDEX

Classic market makers run a cancel/replace loop with `manageBuyOffer` /
`manageSellOffer`, modifying offers **in place** and re-centering the whole book every
ledger or two. The economics that permit this: ~100 stroops base fee per operation, a
0.5 XLM per-offer reserve that is fully refundable, and no state rent. Refreshing a
40-offer book costs ~0.0004 XLM per pass; even at every-ledger cadence that is ~7
XLM/day. Churn is effectively free, and maker behavior reflects it.

## The problem: PageBook priced holding cheap and churn ruinous

A quote update on the pre-005 design is cancel (~0.002 XLM) + rest (~0.029 XLM) ≈
**0.031 XLM per order**, 87% of which is `OrderRef` rent: every rest creates a fresh
persistent entry and prepays ~0.027 XLM for the 120-day minimum TTL, unrefunded when
the cancel deletes it seconds later. For a 40-order book (20 levels per side):

| Refresh cadence | Cost per day (cancel+rest path) |
|---|---|
| every ledger (~5 s) | ~21,000 XLM |
| every minute | ~1,800 XLM |
| every hour | ~30 XLM |
| once a day | ~1.2 XLM |

Meanwhile passive holding is ~0.000225 XLM per order per day. The design accidentally
selected for stale books — backwards from what a CLOB needs.

## The decision: `replace` / `replace_batch`

The rent cliff exists only because cancel deletes the entry and re-rest creates one.
Rewriting an existing entry of unchanged size pays no rent, and the ADR-003
`(owner, nonce)` key makes in-place reuse natural. So:

- `replace(owner, nonce, side, tick, qty)` settles the old order exactly per the §2
  claim table, rewrites the same `OrderRef` in place with the new coordinates, and
  appends at the new tick under normal rest rules (bounds, append window, `LevelFull`,
  empty-reset). Escrow moves as a netted delta.
- `replace_batch` bounds a list of these at `MAX_REPLACE_BATCH` with one netted
  transfer per token: a full book refresh is one transaction.
- **`OrderRef` must be fixed-size by layout** — that is now a stated §1 requirement,
  since a size increase on rewrite would charge top-up rent and break the model.
- Replace never takes liquidity: it applies the conservative post-only check against
  recorded `Best` and fails `Crossed` instead. Takers use `fill`.
- Replace is atomic — the maker is never unquoted between settle and re-rest, which a
  cancel-then-rest pair cannot guarantee.
- Pause blocks replace (it contains a rest); cancel remains available, so funds exit
  is still never gated.

## New economics

- Rent: a maker's nonce is a durable quote slot. 40 slots cost ~1.07 XLM per 120 days
  (~0.009 XLM/day) regardless of update frequency.
- One batched 40-quote refresh: ~90 writes, ~24 KB ⇒ **~0.03 XLM** (write entries
  dominate; zero rent). Single replace: ~0.003 XLM.
- Cadence costs for the 40-order book: every minute ≈ 45 XLM/day; every ledger ≈ 540
  XLM/day; hourly ≈ 0.7 XLM/day.

## Honest limits

- Even with `replace`, PageBook stays ~60–75× more expensive per refresh than SDEX —
  Soroban prices state churn and classic does not. That gap is the platform.
- Capacity binds before fees: at ~24 KB per full refresh, the network's 286,720
  write-byte ledger budget fits **~12 full-book refreshes per ledger across all
  users**. Realistic makers quote wider and re-center on threshold moves, not every
  ledger. The deferred batch-auction and oracle-pegged market types (§7) are the
  long-term answer for assets needing per-ledger repricing.
- Rent-dominated numbers scale with the state-size-dependent rate (floor today,
  up to 10× at the 3 GB target); the execution-dominated replace numbers do not.

## Plan changes

`replace`/`replace_batch` added to the 05 interface; M1 gains the replace-equivalence
property (replace ≡ cancel+rest with the entry reused — asserted via the write set)
and escrow-delta settlement tests; M3 gains `replace_batch` netting + the batch bound;
M4 fee gates include the ~0.03 XLM refresh row with rent isolated at zero.
