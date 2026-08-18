# 015 — Plan review before handoff to a non-interactive builder

Date: 2026-08-17. Docs only. A final adversarial pass over
`05-implementation-plan.md` (Kimi K3 via `opencode`, read-only) asked one question:
can an autonomous coding agent execute the plan with nobody to answer questions? Its
verdict was yes for M0–M3, with the build most likely to go wrong where the plan
assumed environment capabilities without a procedure. Every finding is applied below.

## Findings and what changed

1. **No testnet procedure.** M0 now states one (`stellar keys generate`, Friendbot,
   RPC URL and alias in the git-ignored `.stellar/`) and the fallback if the sandbox
   has no network: deploy skipped, every testnet-only gate marked *blocked* in a
   decision note, in-repo fee gates still run from counted writes and bytes.
2. **Footprint fallback would have gutted the padding suite.** M0's spike now has a
   fallback ladder: (1) recorded footprint as a key set; (2) writes from a ledger
   snapshot diff + XDR sizes, reads from a `Mode::Trace` variant of the shared walk;
   (3) counts and byte bounds only — and rung 3 marks the M2 padding suite *partial*,
   never done.
3. **`BadStartTick` undefined.** Architecture §8 defines it: `start_tick` outside
   `[tick_min, tick_max)`; every in-band value is legal (better than best → clamped;
   worse than limit → pure rest; past the book → no bit). The same paragraph pins the
   empty-flag case (`worse_of(empty, s) = s`; `quote_place` returns `limit_tick` and a
   one-key band) and defines "the book still crosses `limit_tick`" as a check on the
   recorded `BestTick(opposite)` after the walk's own updates — the mechanism by which
   an in-flight better-priced rest, invisible to the walk, still prevents a crossing
   rest. That last sentence was implied by §8's pseudocode and never stated; a builder
   could plausibly have re-read levels for it.
4. **Interface comment dropped `route` from pause.** Fixed; M3 tests paused `route`.
5. **Reference model unspecified.** Testing strategy now says: the reference models
   observable outcomes only (fills, payouts, priority, replace ≡ settle+place); runs use
   non-binding caps and inline queues; truncation is covered by targeted shapes;
   internals are checked by invariant assertions against the real book; proptest lives
   in the `std` test target. M2's race list gains the in-flight `LevelFull` case.
6. **Queue geometry provenance.** Architecture §1: `INLINE_SLOTS`/`PAGE_SLOTS` are
   contract-wide compile-time constants copied into `Market` for introspection;
   `MAX_PAGES` starts at the constant and is retunable per market. `create_market`
   takes no geometry parameters.
7. **Test-env archival assumed.** Folded into the M0 spike; fallback moves the two
   archival tests into the M4 soak, TTL-value assertions stay in-repo.
8. **Small type and encoding gaps.** A new "Encoding decisions" block in 05 fixes
   `MarketId`, the `DataKey` variants, packed layouts and bit order, `page(seq)` for
   inline seqs, event topic/data split, `keepalive` semantics, the `authorized(vault)`
   call and its error `TokenNotAuthorized`, empty-result returns, and the
   empty-flag `quote_place` case. `ReplaceItem` is defined; the bitmap module takes a
   direction (bids descend); `BadWindow` and `BatchTooLarge` are added; error codes
   are declaration order from 1, append-only.
9. **Done criteria at the edges.** M3 asserts writes and zero rent-bearing creates
   in-repo (XLM figure measured in M4); M4 has a completion criterion (gates pass or
   are marked blocked; three restore transactions behave; ≥ 2,000 soak ledgers with
   spammer and rest storm, no trap other than past `pad_end`); M5 names its crate,
   API, and tests.
10. **`MAX_REPLACE_BATCH` sized by events.** Architecture §0.3 notes the footprint
    cap binds first for dispersed batches (~5–6 entries per item); the constant is a
    ceiling, clients batch to fit.

## Not changed

The reviewer's "found adequate" list: ADR-012's fixes are all present in the
milestone tests; ADR-014's decisions are concrete; starting caps check out against
§17/§0.3/§13; every §19 invariant has a test hook; the auth table matches the sketch.
