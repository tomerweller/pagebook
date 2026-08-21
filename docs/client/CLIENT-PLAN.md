# From dashboard to DEX client: plan

Turn the dashboard into a trading client for PageBook on testnet: one page,
the market view as the main pane and a built-in wallet as a side pane. Take,
rest, settle, replace, and manage open orders — while keeping the property
that every number on screen is read straight from ledger entries.

Not started; this document is the proposal.

## Shape (decided)

- **One page.** Main pane: the market view as it exists today (KPIs, ladder,
  tape, activity, facts, market selector). Side pane: the wallet — identity,
  balances, order ticket, open orders, submission log. No separate app, no
  separate URL; the read-only experience is this page with no key loaded.
- **Embedded wallet, no extension.** The page generates and holds its own
  ed25519 keypair. This is a testnet experiment: convenience and
  machine-testability outrank custody. No external wallet dependency, no XDR
  fidelity risk, and a Playwright run (or an agent) can drive the full trade
  loop headlessly.
- **TypeScript from the ground up.** The current `.mjs` modules are the
  reference implementation for the rewrite: `keys`, `decode`, `book` become
  typed modules with the same fixtures; the page becomes a Vite + TS app.
  Everything that exists today (selector, stale-best badge, freshness pill,
  hidden-tab behavior, URL params, mock mode) survives the rewrite — the
  fixture tests and a side-by-side smoke against the old page gate it.
- **Still on GitHub Pages.** Vite outputs static files; nothing about Pages
  changes except how the site is assembled (below).

## The client protocol (why this is more than UI)

Every write goes through **simulate → pad → submit** (architecture §14): pad
the opposite-side `Level` band and its `TickWord`s/summary/bests, page
windows, own-side rest keys, `Order(taker, nonce)`, both tokens' SAC
instance + vault balance + caller balance/trustline, both `FeeAccrual`s;
promote read-only keys to read-write; add resource headroom; mark exactly the
archived entries execution touches for restore. This pipeline exists twice in
the repo — Rust (`crates/pagebook-client`) and Python (`tools/soak/soak.py`) —
and the client ports it to TypeScript once, with golden-fixture parity
against the Rust crate (the same trick as `decode.mjs` ↔ `js_fixtures`).

## The embedded wallet

- **Keys.** Generate (`Keypair.random()`) or import a secret; secret lives in
  localStorage, shown once on creation with a copy control. A `?seed=` URL
  param derives a deterministic keypair for tests and demos. Multiple named
  identities, one active.
- **Funding.** One-click friendbot for a fresh account; balance refresh reads
  the account entry through the same RPC the book uses.
- **Trustlines.** Because the wallet signs classic operations too, the client
  can offer "add USDC trustline" when a market's quote asset needs one —
  shown as an explicit step with the asset issuer displayed, never implicit.
- **Signing.** All local: build invocation → simulate → apply pad → set fee →
  sign with the in-page keypair → send. No prompts beyond a single in-page
  confirm that shows the real numbers (fill preview, fee including padding,
  restore rent if any).
- **Guardrails.** Testnet network passphrase hardcoded; contract allowlist;
  a persistent banner naming the page an experiment; refuse to run against
  a mainnet RPC even if asked via URL param. The wallet pane carries a plain
  warning that keys are browser-local and disposable.

## Repo and hosting layout

- The app replaces `docs/client/` as source: code moves to
  `clients/web/` (Vite + TS + the fixtures), and Pages switches from the
  legacy `main:/docs` build to a **GitHub Actions Pages workflow** that
  assembles the artifact: `docs/` as-is (explainer at `/pagebook/`, docs) +
  `vite build` output at `/pagebook/client/`. URLs do not change; the
  explainer keeps its links. The workflow extends the existing `ci.yml`
  Pages-deploy job runs only on `main` pushes.
- `docs/client/` keeps only a README pointer at the new source location.
- Node tooling (npm, lockfile) lives in `clients/web/` only; the Rust
  workspace and `make` targets are untouched except `make web` conveniences.

## Screens (one page, two panes)

**Main pane** — today's market view unchanged, plus: click a ladder row to
prefill the ticket; own orders highlighted in the ladder and tape.

**Side pane** —
- *Identity*: active key, XLM balance, per-market token balances, friendbot,
  trustline status/add, identity switcher.
- *Ticket*: side, price (tick-snapped), size (lot-snapped), flags (post-only,
  fill-or-kill, no-rest), live `quote_place` preview (expected fill, average
  price, taker fee, remainder that would rest, real fee including padding),
  submit → state machine (simulating / signing / sending / applied with
  per-level fills, or the typed error in plain words).
- *Open orders*: derived, never trusted from storage — localStorage nonces ∪
  `rested` events for the active key, each verified against the
  `Order(owner, nonce)` entry and previewed via the `order` view. Actions:
  settle (claim/cancel), replace (new tick/size), multi-select
  `replace_batch` with netted-transfer preview.
- *Log*: past submissions with hash links, outcome classification, fees paid.

## Milestones

**M1 — TS rewrite of the read page.** Scaffold `clients/web`; port
`keys`/`decode`/`book` to typed modules with the existing fixtures; rebuild
the market view in TS with feature parity; Pages workflow deploys it; old
`docs/client` retired the same commit. Exit: published page is
indistinguishable from today's (side-by-side smoke), fixtures green in CI.

**M2 — wallet pane.** Keypair lifecycle, `?seed=`, friendbot, balances,
trustlines, the pane UI. Exit: fresh browser → funded account with a USDC
trustline in under a minute, all in-page; Playwright does the same headless.

**M3 — the padding engine.** TS port of `pagebook-client` (`pad`,
`keys_for_settle`, `keys_for_replace`, `append_range`, `restore_marks`,
nonce allocator), `apply_pad`-equivalent editing of `SorobanTransactionData`
(footprint union, RO→RW promotion, resource headroom), outcome classifier.
Golden-fixture parity with the Rust crate. Exit: a Node soak (reusing the
soak's behaviors and identities) places, settles, replaces on testnet through
the TS engine with no footprint failure other than walk-past-`pad_end`
(ADR-025 criterion) — proven before any UI uses it.

**M4 — taker flow.** Ticket → preview → place; submission state machine;
`Crossed`/`LevelFull`/`RetryRest` presented as normal outcomes with a retry
path; own fills highlighted. Exit: manual browser trades on XLM/USDC verified
against the book and an independent reader.

**M5 — maker flow.** Settle, replace, `replace_batch`; stale-order warnings
(level generation moved); archived-order restore with rent shown pre-sign.
Exit: a small two-sided quote run from the browser for an hour alongside the
soak, all orders settled cleanly.

**M6 — hardening + docs.** Every `contracterror` mapped to a plain-language
message; fee display audit against §17 numbers; e2e suite (Playwright with
`?seed=`) in CI; README/CLAUDE.md/ADR updates (this plan's decisions, the
Pages build change); humanizer pass on all copy.

M3 is the risk and the bulk; M1 and M2 are mostly mechanical; M4–M6 the tail.

## Testing

- Fixture parity in both directions: decode fixtures (existing) plus key-list
  and pad fixtures emitted by the Rust crate, asserted in TS.
- The M3 Node soak is the engine's acceptance gate, independent of any UI.
- Playwright e2e with `?seed=`-derived identities: fund → trustline → place →
  see fill → settle, asserted against RPC reads, run in CI on a schedule
  (testnet flakiness tolerated with retries, failures surfaced not ignored).
- No contract changes; the Rust side gains only fixture emitters.

## Risks / open questions

- **Pages build switch.** Moving from legacy `/docs` build to an Actions
  deploy is a one-way config change affecting the explainer too; do it in M1
  with a dry-run artifact check before flipping.
- **Fee UX.** Padding makes a real place cost visibly more than a naive
  estimate (~2,800 stroops per padded key); the ticket shows the true number
  before signing.
- **In-flight book movement.** Between preview and apply the book moves;
  typed errors are outcomes, not failures, and the UI language treats them so.
- **localStorage keys.** Acceptable for testnet by decision; revisit only if
  this ever grows past the experiment (out of scope).
- **route** (multi-leg) stays deferred; no current pair chain needs it.
