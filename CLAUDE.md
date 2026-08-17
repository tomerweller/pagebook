# CLAUDE.md — instructions for the implementing agent

You are implementing **PageBook**, a Soroban-native CLOB. The design is complete enough
to build a first milestone; it is not sacred. Where reality (SDK APIs, measured fees,
entry-size behavior) contradicts the docs, follow reality and record the deviation in
`docs/decisions/NNN-title.md` (one short file per decision).

## Read first

1. `docs/04-architecture.md` — the design you are building (normative).
2. `docs/05-implementation-plan.md` — module layout, interface, milestones (proposal).
3. `docs/03-soroban-constraints.md` — the limits and storage semantics you must respect.
4. `docs/01-prior-art.md`, `docs/02-deepstate-evaluation.md` — background/rationale.
5. `docs/06-slp-sensitivity.md` — which variables track network limits and how.

## Ground rules

- Rust + `soroban-sdk` (latest stable). Target the current mainnet protocol. Build with
  `stellar contract build`; test with `cargo test` against the SDK's test environment.
- Every storage entry type in the architecture doc has a target byte size. Treat entry
  size as a budgeted resource: add a test that XDR-serializes each entry type at max
  occupancy and asserts it stays under budget (`docs/04-architecture.md` §Storage).
- Footprint discipline is the product. For each public function, write an integration
  test that asserts the number of entries read/written (the SDK test env exposes
  resource/footprint info via budget & snapshot APIs; if exact counts are awkward,
  assert upper bounds).
- No panics in reachable paths; use typed `contracterror` codes. No unbounded loops:
  every loop bounds on a config constant (`MAX_LEVELS_CROSSED`, page capacity, etc.).
- Operation vocabulary is normative (architecture §0): entry points are `place`,
  `replace`, `settle`, `route`, and the cranks; behaviors are take/rest/sweep; "fill"
  is only an order state. Use these names in code, tests, events, and docs.
- No synchronous calls out to untrusted contracts. Token movement is SAC `transfer`
  only, to/from the contract's own vault. Top-of-book changes are events, not hooks.
- Amount math in i128 (lots × tick × tick_size); checked arithmetic everywhere.
  Matching math is exact by quantization (no rounding); the only rounding is the
  taker fee, which rounds up (`ceil`); dust accrues to fees.
- Persistent entries: never `del` a `Level` (generation counters must survive; archival
  handles cold ones). `OrderRef` is deleted on settle and reused in place by replace.
  Extend TTLs per the policy table in the architecture doc.

## Definition of done per milestone

See `docs/05-implementation-plan.md` §Milestones. Each milestone lands with: unit +
property tests green, footprint-budget tests green, entry-size tests green, and a short
`docs/decisions/` note for anything that diverged from the plan.

## Artifacts

- Any artifact produced from this repo (the explainer page, published HTML, reports)
  MUST be run through the `humanizer` skill before publishing.
- Artifacts are standalone documents describing the current state of the design. No
  references to prior iterations, review rounds, or "what changed" — that history
  lives in `docs/decisions/`.

## Repo conventions

- Contract crate in `contracts/pagebook/`; shared types in `crates/pagebook-types/` if
  a client SDK needs them; keep the workspace root `Cargo.toml` minimal.
- `make build|test|fmt|lint` wrappers once the workspace exists.
- Do not commit `target/`, `.stellar/`, or test snapshots that aren't asserted against.
