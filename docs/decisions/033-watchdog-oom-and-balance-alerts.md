# 033: Watchdog reads log tails; balance-error and nothing-landed alerts; log rotation

Date: 2026-09-08. Findings from eleven days of silent maker downtime on the fly
deployment (2026-08-28 to 2026-09-08), and the ops fixes.

## What happened

The XLM rally (mid 0.158 to 0.188 over the deployment's life) drained the
maker's XLM: the trader bought XLM from the ask ladder faster than the 3 bps
inventory skew could pull it back, until the account sat at its reserve floor
(1.52 XLM against a 27,800 XLM ask ladder). From 2026-08-28 16:26 UTC every
ask-side `replace` failed at simulation on the escrow pay-in; `replace_batch`
is atomic, so mixed batches failed whole, and the singles fallback failed the
ask half. The book went one-sided, then empty on the bid side as bids filled,
and the trader (correctly) stopped taking. 684,544 consecutive rejections.

Three tooling gaps kept it invisible:

1. **The watchdog OOMed before it could look.** `check.ts` read the whole
   maker log with `readFileSync`; at 229 MB that is a ~460 MB V8 string, over
   the default heap on the 1 GB machine. Every hourly run died in `JSON.parse`,
   its stack trace matched no restart pattern, and the entrypoint logged
   "requires observation" to a log nobody was reading.
2. **The failure was labeled benign.** The SAC's `BalanceError` is contract
   error #10, the same code as PageBook's `Unfilled`; the client decodes codes
   through PageBook's table only, so the outcome read `sim:typed:Unfilled` —
   and simulation-time typed rejections are (deliberately) not in the check's
   bad set, because a re-quoting maker collects benign `sim:typed:Crossed` all
   day.
3. **Nothing watched the success rate.** Zero landed transactions across
   thousands of attempts alerted nothing so long as each attempt failed
   politely.

## Changes (ops only; no contract or engine change)

- `check.ts` reads only the tail of both bot logs (`readTailSync`, default
  8 MB, `--log-tail-bytes`), dropping the partial first line. The state file
  stays a full read.
- `typed:Unfilled`, simulation included, is now a bad outcome for both bots:
  neither ever sends `fill_or_kill`, so a genuine PageBook `Unfilled` is
  impossible for them and #10 in practice is the SAC's `BalanceError` — a
  funding problem, not a moving book. The right general fix — attributing a
  contract error to the contract that raised it, from the diagnostic events —
  is noted but not done here.
- New alert: `okN == 0` with ≥ 50 rejections in the window ("nothing landed"),
  catching any future politely-failing-forever class regardless of label.
- `opslog` rotates at 64 MB (one `.1` generation kept), bounding both the logs
  on the 1 GB volume and anything that reads them.

Recovery itself was funding, not code: six friendbot throwaways account-merged
into the fly maker (~60,000 XLM, test money). The bot healed the book on its
own within two cycles of the first merge landing — replaces settle the stale
orders and re-rest at the current mid, and the walk-to-target heals cleared
the phantom trail (ADR-026's mechanism, working as designed).

## Open question

The drain itself is untreated: a one-directional market will empty one side of
any maker whose skew is capped at 3 bps. Options (not decided here): rebalance
inventory via the classic DEX when a side crosses a floor, widen the skew cap,
or alert-and-stop at a reserve threshold so the operator refunds deliberately.
The check's existing `XLM reserve low` alert (2,000 XLM floor) now actually
fires, which covers the observability half.
