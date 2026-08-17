# 009 — Architecture doc restructured around data structures and processes

Date: 2026-08-17. The design content is unchanged apart from three small additions
noted below; this note maps section numbers so ADRs 001–008, which cite the old
numbering, stay readable.

## Decision

`04-architecture.md` is reorganized from concern-ordered sections (storage, level
accounting, matching, footprints, TTL, admin) into: foundations (§0); one section per
**data structure** (Part I, §1–§6: purpose, key, layout, capacity, owned invariants,
lifecycle in one place); Part II with three kinds of section — **mechanisms** (§7
settlement, §8 the walk, §9 rest, §10 replace: algorithm, degradation, invariants,
budget line), **entry points** (§11 views, §12 the state-changing surface with an
auth/composition/footprint table), and the **client's half** (§13 events, §14 the
padding protocol); and emergent **system properties** (Part III, §15–§20). Every
normative statement, number, and table survives; per-op budget lines also appear in
the owning mechanism section, with the comparative tables and design readings kept
whole in §17. The reconstructibility rule is the second organizing principle of Part
I's intro rather than its own section. Invariant numbers 1–9 are unchanged; §19 is the
canonical index and each invariant is also stated in the section that owns it.

An adversarial structural review after the first draft drove: the honest three-kind
framing of Part II (the mechanism sections cannot carry auth/footprint — the entry
point does); `replace` promoted to its own mechanism; `route` folded into the walk as
multi-leg composition; the bounded tombstone scan moved from settlement to the walk
and "tombstone" defined with the slot states in §2; views (§11) and events (§13) given
sections; the vault (§6) filled to the structure template and added to the TTL table;
"failure modes, exhaustively" and invariant 6 moved from the client section to the
footprint-surface section (§15); duplicated passages (fee formula, replace economics,
route footprint split, padding cost, instance-write rule) reduced to one owner plus
pointers.

## Additions relative to the previous version

Three gaps the templates exposed, filled rather than left:

- `place` flags now list `no_rest` (already in 05's `PlaceFlags`); §8's pseudocode
  handles it.
- §9 rest now states what was implied: fail `OrderExists` on a live nonce, and move
  `BestTick` + emit `top_changed` when the rest improves the top. Both were previously
  derivable only from invariant 3 and the events list.
- §7 settlement names its typed errors (`UnknownOrder`, `NotOwner`, from 05's
  taxonomy); §12's auth list includes `set_market_caps` (ADR-007).

## Section mapping (old → new)

| Old | Content | New |
|---|---|---|
| §0 Model | model, vocabulary | §0.1 |
| §0 Quantization | quantization | §0.2 |
| §0 Bounds | creation-time proofs | §0.3 |
| — | actors | §0.4 (new) |
| §1 Storage schema | key discipline, DataKey pattern, reconstructibility rule | Part I intro |
| §1 | `Config`, `Market` | §1 |
| §1 + §2 | `Level`, `LevelPage`, slot states, counters, resets, stale-slot rule | §2 |
| §1 | `Order` identity | §3 |
| §1 | `FeeAccrual` | §4 |
| §1 | tick index tiers | §5 |
| §1 | vault | §6 |
| §2 Settlement logic | claim table | §7 |
| §2 Bounded tombstone scan | scan cap | §8 |
| §3 Matching | place pseudocode | §8 |
| §3 route | multi-leg composition | §8 |
| §3 Resting / post-only | rest, append window, post-only | §9 |
| §3 Replace | replace / replace_batch | §10 |
| — | views (`best`, `level`, `order`, `quote_place`) | §11 (new) |
| §6 | auth, constructor, trust model, pause, `set_market_caps`, upgrade, `create_market`, cranks | §12 |
| §3 Events | events | §13 |
| §4 Padding rule | the client's protocol | §14 |
| §4 thesis + failure modes | footprints as product | §15 |
| §4 Concurrency + §5 instance rule | serialization clusters | §16 |
| §4 Budgets + fee tables | comparative tables, readings | §17 |
| §5 TTL/archival | policy summary (details now in Part I lifecycles) | §18 |
| §8 Invariants | numbered index (1–9 unchanged) | §19 |
| §7 Non-goals | non-goals / deferred | §20 |

Cross-references in `05-implementation-plan.md`, `06-slp-sensitivity.md`,
`01-prior-art.md`, and `CLAUDE.md` are updated to the new numbering. ADRs 001–008 are
not rewritten; read their section citations against the left column above.
