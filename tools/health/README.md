# Outside-in health check

`pagebook-health.py` answers "is the live venue healthy?" from public HTTP
endpoints only: Soroban RPC, Horizon, and a spot feed. No fly.io credentials,
no stellar CLI keychain, no keys, no writes. It runs on a laptop, in CI, or in
an isolated cloud session.

```
python3 tools/health/pagebook-health.py
python3 tools/health/pagebook-health.py --json
```

It reports three things and ends with a `FLAGS:` line (`none` when healthy):

- **liveness** — contract events in the last ~hour by type. A quoting maker
  emits `rested` and `top_changed`; crossing flow emits `filled` and
  `settled`. Silence means the bots are down or wedged.
- **book** — both recorded bests from their `BestTick` entries, priced through
  the market's own `lot_size` and `tick_size`, against spot. Catches an empty,
  one-sided, crossed or drifted book.
- **reserves** — both bots' balances against the ADR-035 refill floors.

The contract and market come from `clients/web/fly.toml` and the bot addresses
from `clients/web/ops/refill.ts`, so a redeploy that updates those is picked up
without touching this script. Every default is overridable; see `--help`.

This is the complement to `clients/web/ops/check.ts`, the watchdog that runs
next to the bots on the fly machine. That one reads the bots' own logs and
state file, so it can see process health, per-cycle outcomes and the maker's
own view of its quotes, and it can restart a bot. This one sees none of that
and instead reads the ledger, which is the state the bots are supposed to be
moving: it stays useful when the machine is unreachable, and it cannot be
fooled by a bot that logs happily while landing nothing on chain.

Exit status is 0 whether or not anything is flagged, so a scheduler treats a
completed check as a success and the `FLAGS:` line (or `--json`) carries the
verdict.
