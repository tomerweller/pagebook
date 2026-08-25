# 031: The ops tooling runs on the TypeScript engine

Date: 2026-08-25. Issue #7, executed. The Python bots that ran the testnet
markets (maker, trader, watchdog, soak, stress, resource sampler) are
replaced by TypeScript ports under `clients/web/ops/` that import the web
client's engine source directly. The padding logic now has two
implementations instead of three: `crates/pagebook-client` (canonical Rust)
and `clients/web/src/engine/` (TypeScript), held together by a checked-in
conformance fixture asserted by both test suites. Every transaction the bots
send now exercises the exact code path the web client ships.

## Decisions

1. **Bots live in `clients/web/ops/`, importing engine source.** No shared
   package: a published artifact would be a third copy of the pad logic,
   the drift class this migration exists to remove.
2. **Runtime: Node 22+, `tsx`, one process per bot**, npm scripts
   (`ops:mm`, `ops:trader`, `ops:check`, `ops:soak`, `ops:stress`,
   `ops:resources`). Log lines and the maker state file keep the Python
   field names, so the watchdog audits either stack and the cutover was a
   file copy.
3. **Secrets stay in the CLI keychain.** At startup a bot resolves its
   identity with `stellar keys secret` (config dir found by walking up from
   cwd) and holds the key in memory; `PB_SECRET_<NAME>` overrides for hosts
   without the keychain. Nothing lands on disk.
4. **Pad v2 ships behind `--pad-v2`, default off** (existence-aware
   write-byte coverage per ADR-028, maker paths only). It stays off until a
   day of clean single-stack operation, then gets flipped and watched.
5. **Cutover was criteria-based but operator-shortened.** The plan called
   for 24 hours of parallel running; the operator called it at two clean
   hours. In that window the stacks matched: TS 497 to 540 ok per hour
   against Python 443 to 501, heals 30 to 39 against 19 to 30, traders at
   62 to 65 takes per hour each, zero footprint or unexplained-trap
   outcomes on either side.

## What the port preserved

The measured operational lore moved over item by item and is asserted by
unit tests where it is arithmetic: banker's rounding in `tick_of` (Python
`round` is half-even; `Math.round` is not), the ladder and inventory-skew
formulas, the ADR-026 instruction headroom (1.25x + 120k per key + 3M flat,
flat part independent of the simulated amount), read-only-to-read-write
promotion, `pagesForEmpty` on heal walks (now also in the Rust client, with
conformance cases), heal-to-target with band chunking and the
six-per-cycle loop, LevelFull tick bans with step-away, the trader's
band-width skip guard, the watchdog's phantom-versus-real crossed-best
distinction and through-mid tolerance, and the state-file resume contract.

## What review and verification caught

The Claude review of the port (eight finder angles, ten verified findings)
caught one blinding defect: apply-time failures were classified by pattern
matching over raw base64 XDR, so a landed transaction that trapped would
have logged as benign noise. FAILED transactions are now classified from
decoded XDR, with `trapped:unknown` as the floor for anything unexplained.
The other correctness findings: simulation failures losing their `sim:`
prefix (which would have corrupted the cross-stack comparison), a silent
state reset on file corruption, a null level view reading as an empty level
(spurious heals), double log lines on engine throws, and a config-dir
default that broke identity loading under npm's working directory. Scratch
runs on market 0 caught two more: the post-only worst-tick start and the
token pad both assumed market 1's geometry; both are now market-relative
flags.

## Cutover record

pb-mm2/pb-trader2 (the parallel identities) were settled off the book;
the Python trader settled its rests on SIGTERM and exited; the Python maker
exited leaving its 40 quotes live and its state current; the state file was
copied to `clients/web/ops/state/mm.json`; the TS maker started on the
production identity and adopted all 40 quotes with counters intact (fills
5,290 carried over, zero OrderExists), and the TS trader took over traffic.
The watchdog now runs `ops/check.ts` every 30 minutes.

## What was deleted, what is frozen

`tools/mm/*.py` deleted. `tools/soak/soak.py` and `tools/stress/stress.py`
are frozen in place: the frozen measurement instruments in `tools/research/`
import both via hardcoded paths, and their logs are the provenance of
ADR-025 through ADR-028. README notes mark all three directories.
