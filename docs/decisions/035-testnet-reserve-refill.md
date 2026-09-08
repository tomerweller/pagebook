# 035: Automatic testnet reserve refill via friendbot

Date: 2026-09-08. Resolves the open question in ADR-033: what to do about a
one-directional market draining one side of the maker's inventory.

## Decision

For the testnet deployment, refill rather than rebalance. A new daily crank,
`ops/refill.ts`, reads both bots' balances from Horizon and, when one is under
its floor, tops it up with friendbot money:

- **Maker XLM** (floor 30,000, target 50,000): generate throwaway keypairs,
  fund each at friendbot (10,000 XLM), `account_merge` each into the maker.
  The 30,000 floor is on the free account balance, so even in the worst case —
  every order settled back to the account and the full 20-level ask ladder
  (~27,800 XLM) re-resting at once — escrow pay-ins clear.
- **Trader USDC** (floor 5,000, target 20,000): fund a throwaway, then one
  transaction sends `path_payment_strict_send` XLM→USDC into the trader and
  `account_merge`s the residue after it — the same route ADR-026 used to fund
  the accounts originally. The testnet DEX rate is arbitrary, so the crank
  swaps one throwaway at a time and re-reads the balance until the target or
  the per-run account cap (default 8) is hit.

The crank signs only with the locally generated throwaway keys; it needs no
bot identity or secret. It runs daily from the fly entrypoint next to the
keepalive, logging to `/data/logs/refill.log`, and refuses to act when Horizon
returns no balance (a blind read must not trigger funding). Floors, targets,
endpoints, and the account cap are flags; `--dry-run` plans without funding.

## Why refill, not the other options

ADR-033 listed three candidates: rebalance via the classic DEX, widen the
3 bps skew cap, or alert-and-stop for a deliberate operator refund.

- Rebalancing sells the maker's USDC for XLM at the testnet DEX's arbitrary
  price. On a network where money is free, that is complexity with no fidelity
  gain — the interesting economics (skew, spread, adverse selection) are
  already mis-priced by the venue we'd rebalance on.
- Widening the skew cap changes the maker's quoting behavior to solve an
  operations problem, and any finite cap still drains eventually in a long
  enough one-way market.
- Alert-and-stop is what ADR-033 already built (the `XLM reserve low` alert
  now fires); leaving the fix manual is how we got eleven days of downtime.

A mainnet deployment cannot refill and will need real inventory management;
that decision is deferred until a mainnet deployment is on the table.

## Notes

- Floors are checked against Horizon account balances, which exclude vault
  escrow — consistent with `check.ts`'s existing 2,000 XLM alert floor. The
  refill floor sits well above it so the top-up lands before the alert would.
- Failures (friendbot, submission) log an `err` outcome and stop that side's
  loop for the run; the watchdog's log-based alerts remain the safety net.
