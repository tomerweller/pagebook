# 034: Decode contract errors by raising contract (client only)

Date: 2026-09-08. The general fix ADR-033 deferred: `Error(Contract, #N)` is
per-table, and the client decoded every code through PageBook's table. The
SAC's `BalanceError` (#10) read as `Unfilled`, and — worse, never yet seen —
the SAC's `AllowanceError` (#9) would read as `Crossed`, which the watchdog
deliberately treats as benign. The deployed contract is immutable (ADR-023),
so this is a pure client change; the error codes themselves are untouched.

## Change

- `classifyFailedTx` now reads the raising contract from the diagnostic
  events' `contractId` (simulation error `events` and `getTransaction`
  diagnostics both carry it). Errors abort execution, so the first
  error-carrying event is the deepest frame — the raiser; later events are
  parent frames escalating the same error.
- The engine knows the invoked PageBook address. An error raised by it (or
  with no attribution — no diagnostics, text-only send failures) decodes
  through PageBook's table exactly as before. An error raised by any other
  contract is a token (PageBook calls nothing else), so it decodes through
  the SAC's table (`SAC_ERROR_NAMES` in `src/engine/errors.ts`, from
  rs-soroban-env's native asset contract) and the engine result carries
  `foreign: true` plus the raiser's address.
- Ops outcome strings prefix foreign errors `sac:` instead of `typed:`
  (`sim:sac:BalanceError`), and the watchdog treats every `sac:*` outcome as
  bad, simulation included — a token-layer failure is never a moving-book
  rejection. `sac:*` at apply also counts toward the nothing-landed rejection
  total.
- ADR-033's `typed:Unfilled`-is-bad special case stays, as defense in depth
  for logs written before this change and for attribution-less paths.

## Not changed

- Simulation errors whose response carries no decodable diagnostic events
  still classify from the error text through PageBook's table.
- The web UI ticket path still parses error text; a foreign error surfaces
  there under its SAC name via the engine result.
