# 011 — Adversarial design review, round 3 (Kimi K3)

Date: 2026-08-17. Produced by Moonshot Kimi K3 (`opencode-go/kimi-k3` via `opencode run --agent plan`, read-only) against the docs at commit e1c57b5. Findings are unedited model output; each needs human triage before it becomes a resolution (see ADR-003 for the round-2 pattern). Resolutions: ADR-012.

Target: `docs/04-architecture.md` (normative), read against `docs/03-soroban-constraints.md`, `docs/05-implementation-plan.md`, and ADRs 001-010. Findings already resolved in ADRs 001-003 are not re-reported except where the resolution itself is defective (one case: ADR-002 finding 3).

## 1. Executive summary

The design holds up well at the structural level. The settlement state machine, the generation-on-sweep finality story, the empty-level reset, the stale-slot decode rule, and the `start_tick` scoping of the padding race all survive attack, and I found no Critical (funds-loss-as-written) flaw. I did find two High defects in the flagship footprint guarantee: the §14 pad enumeration omits the taker's own-side rest keys, so a resting `place` traps as written (contradicting invariant 6 and §15's "exhaustive" failure-mode list), and §9's re-liquification sentence ("set `TickWord`/`TickSummary` bits if new") under-specifies the exact transition that re-arms the hard direction of invariant 3 after a sweep or lazy clear. Four Mediums follow: the §0.3 overflow proof's "4× headroom for fee math" is arithmetically insufficient by the `FEE_BPS_MAX` factor (the ADR-002/003 resolution is flawed); mandatory band padding over archived dead entries shifts restore rent onto takers indefinitely, falsifying §15's "declared-but-untouched entries are free"; §7's `s == H` settlement row omits the `open_lots` decrement, a conservation break if implemented literally; and `create_market`'s normative check list omits the bitmap-coverage and sorted-pair MUSTs stated elsewhere. Lows cover an unconditional post-sweep bitmap scan that can trap completed takes, RetryRest griefing economics (attacker-unfavorable), non-standard SAC asset behavior, and keepalive incentives. No reentrancy or callback surface exists; the fee ceil has no zero-dodge; auth and pause semantics are complete.

## 2. Findings

### Critical

None found.

---

### High

#### H1. §14's pad enumeration omits the taker's own-side rest keys; resting places trap as written, falsifying invariant 6's exhaustiveness claim

**Severity:** High. **Sections:** §14 ("Pad"), §15 (invariant 6), §8-§9, §12 place row. **Invariants:** 6.

**The sentences under attack.** §14: "declare RW: **every `Level` key in the contiguous tick band `[t1, pad_end]`** ... plus the `TickWord` entries covering the band, `TickSummary`, `BestTick`, both vault balances, `FeeAccrual`, and the slot windows: ... for the taker's own possible rest, `Order(taker, nonce)`, the rest level's bitmap words, and append pages `{page(tail_sim), +1, 0}`." And §15: "A place **traps** (footprint violation) only if the walk must pass `pad_end`."

**The defect.** The band `[t1, pad_end]` is built from the walk side: `t1` is "the client's simulated best opposite tick" (§8). A place that rests its remainder writes `Level(market, own_side, limit_tick)`, and per §9 also writes that level's `TickWord`/`TickSummary` bits and moves `BestTick(own_side)` when the rest improves the top. §14's enumeration lists, for the rest, only the `Order` key, "the rest level's bitmap words", and append pages. It never lists the rest tick's **`Level` entry itself**, and its singular "`TickSummary`, `BestTick`" sit in a sentence about the walk-side band, so a literal reading declares them for the opposite side only. An SDK that pads exactly per §14 produces a take-plus-rest place that touches an undeclared `Level(own_side, limit_tick)` and traps on every resting execution. The trap is not past `pad_end`; it is at the client's own limit tick. §15's claim that the failure modes are "exhaustive" is therefore false as written, and §15's residual-risk paragraph ("only walking past `pad_end` traps ... do not claim otherwise") claims precisely otherwise.

**Attack / failure sequence (no adversary needed; the honest path fails):**
1. Client simulates a bid `place` that crosses 2 ask levels and rests a remainder at tick 200 (bid side).
2. Client pads per §14: ask-side `Level` keys `[t1, pad_end]`, ask-side `TickWord`s + `TickSummary` + `BestTick`, both vault balances, `FeeAccrual`, consume windows, `Order(taker, nonce)`, bid-side bitmap words for tick 200, append pages.
3. Execution: walk consumes the two levels (writes `Level(asks, ...)`, clears bits), then §9 rest writes `Level(bids, 200)`. That key is not in the footprint. Transaction traps. All walk progress reverts.

**Impact.** The design's central product promise ("every race degrades gracefully except the `pad_end` trap") is wrong on the most common place shape. In practice M2's sim-to-apply race tests catch this on day one, so the real cost is a mis-specified client protocol section in the document that is supposed to be the exhaustive spec of paddability.

**Mitigation.** One line in §14: the pad list must include, for the rest side, `Level(market, own_side, limit_tick)` (set or not), plus that side's `BestTick` and `TickSummary` explicitly. §12's place row ("band + windows + own rest keys") already gestures at this; §14's enumeration is the broken link. Add an M2 assertion: a resting place's simulated footprint contains the own-side `Level` key.

---

#### H2. Re-liquification bookkeeping is under-specified at the exact transition that re-arms invariant 3's hard direction

**Severity:** High. **Sections:** §9 (rest algorithm), §5 (staleness contract), §2 (lifecycle: "Re-activating a swept tick is therefore a rewrite, not a create"). **Invariants:** 3, 8 (post-only's fail-closed half depends on 3).

**The sentences under attack.** §9: "Write the qty slot (**create the level and set `TickWord`/`TickSummary` bits if new**); if the tick is better than the recorded `BestTick(side)`, move it and emit `top_changed`." §5 states the rule correctly ("Bits are set by rests that give a tick liquidity (§9)"), and invariant 3 requires the hard direction: "`open_lots > 0` ⇒ bitmap bit set."

**The defect.** "If new" scopes bit-setting to level *creation*. But the hottest transition in any CLOB is re-liquification of an *existing* level whose bit was cleared: (a) a sweep clears the bit and bumps the generation (§8), and the `Level` is never deleted (§2), so the next rest at that tick finds an existing level with a clear bit; (b) a walk lazily clears a stale bit over a cancel-emptied level (§8), same situation. If the implementer follows §9's sentence literally, the rest writes the slot, `open_lots` goes 0 → q, and the bit stays clear. That is the forbidden direction of the staleness contract: a live level invisible to matching. Two companion gaps: the `TickSummary` re-set when its word went to zero, and the `BestTick` empty flag, whose lifecycle (when it is set, when a rest clears it) is written down nowhere. §9's "if the tick is better than the recorded `BestTick(side)`, move it" does not cover a rest onto an empty-flagged side at a tick worse than the stale recorded value: the tick comparison fails, and if the empty flag is not separately cleared the side reads empty while holding liquidity.

**Attack / failure sequence:**
1. Taker sweeps the only ask level at tick 100. Writes: `Level(asks, 100)` (generation += 1, `open_lots` = 0), `TickWord` bit 100 cleared, `TickSummary` bit cleared (word emptied), `BestTick(asks)` = empty.
2. Maker rests at tick 100 (rewrite of existing `Level`, `open_lots` = q).
3. Per literal §9: no bit is set (level not new); `BestTick` not moved (empty flag unhandled).
4. All subsequent takers: `best = worse_of(BestTick(asks), start_tick)` walks the bitmap, finds no set bits at or below their limit, and never reads `Level(asks, 100)`. The liquidity is unreachable. The `level()` view (reads `Level` directly) shows `open_lots > 0` while `best()` shows empty: the views disagree. Post-only rests on the bid side at ticks that would cross 100 do not fail `Crossed`, so a crossed book can also arise (invariant 8).

**Impact.** Maker funds are safe (settle is key-based, not bitmap-based) but liquidity is stranded and the book's core guarantee inverts. As with H1, the planned M2 property tests (book vs reference) catch a literal implementation immediately; the defect is that the normative algorithm sentence contradicts the invariant and §5's rule on the single most load-bearing transition in the design.

**Mitigation.** Restate §9: a rest that raises a level's `open_lots` from zero MUST set the tick's `TickWord` bit and the corresponding `TickSummary` bit (idempotently, new level or not), and any rest on an empty-flagged side clears the flag and moves `BestTick`. Define the empty flag's set/clear conditions in §5. M2 tests: sweep → re-rest same tick; lazy-clear → re-rest; empty book → rest at a tick worse than the stale recorded `BestTick`.

---

### Medium

#### M1. §0.3's "4× headroom for fee math" under-covers the ceil fee's multiply by `fee_bps`; the ADR-002 finding 3 resolution is arithmetically flawed

**Severity:** Medium. **Sections:** §0.2 (fee formula), §0.3 (bounds). **Invariants:** 7 (checked math is the panic-avoidance story); ADR-002 finding 3 bullet "multiplication by an unbounded `fee_bps` value" is not actually closed.

**The sentences under attack.** §0.3: "`LEVEL_CAP × max_order_lots × tick_max × tick_size ≤ i128::MAX / (4 × MAX_ROUTE_LEGS)` — covers one order, one full level, one max sweep, and a max route, **with 4× headroom for fee math**." §0.2: "`fee = ceil(output × fee_bps / 10_000)`", with `taker_fee_bps ≤ FEE_BPS_MAX` (e.g. 1,000).

**The defect.** The fee intermediate is `output × fee_bps`, a factor of up to 1,000, not 4. A taker's quote-side output is bounded by `max_order_lots × tick_max × tick_size`, i.e. by the proven bound divided by `LEVEL_CAP`. Overflow is avoided iff `4 × MAX_ROUTE_LEGS × LEVEL_CAP ≥ FEE_BPS_MAX`. With the stated target geometry (`INLINE_SLOTS = 32`, `PAGE_SLOTS = 32`) and `MAX_PAGES = 0`, `LEVEL_CAP = 32`, so safety requires `MAX_ROUTE_LEGS ≥ 8` (at `MAX_PAGES = 1`, `≥ 4`). `MAX_ROUTE_LEGS`'s value and this joint constraint appear nowhere in the docs; nothing in `create_market` or `set_market_caps` re-proves it.

**Attack / failure sequence:**
1. Admin creates a market at the proven bound with `MAX_ROUTE_LEGS = 4`, `MAX_PAGES = 0`, `taker_fee_bps = 1,000`, and `max_order_lots × tick_max × tick_size = i128::MAX / (4 × 4 × 32) = i128::MAX / 512`.
2. Taker submits a max-size take at `tick_max`. Matching math is exact and fine.
3. Fee line computes `output × 1,000` ≈ `1.95 × i128::MAX`. Checked multiply overflows; the transaction fails with `Overflow`.
4. Every near-max take on this market fails permanently. Takers must split orders (more tx fees, more ledger write bytes) on exactly the markets the creation proof claims to have made safe.

**Impact.** Denial of service on large takes for maximally configured markets; no fund loss. The creation proof's coverage claim is wrong as stated.

**Mitigation.** Either restate the bound with the fee factor included (`... × FEE_BPS_MAX ≤ i128::MAX / (4 × MAX_ROUTE_LEGS)`), or compute the fee without the large intermediate: `fee = (output ÷ 10_000) × fee_bps + ceil((output mod 10_000) × fee_bps / 10_000)`. The first term is bounded by `output`, the second by `10_000 × 10^3`, so no headroom is needed and the result is identical to `ceil(output × fee_bps / 10_000)`. Add the joint constraint to the §0.3 proof and the `set_market_caps` re-proof (§12, ADR-007).

---

#### M2. Mandatory band padding over archived dead entries transfers restore rent to takers indefinitely; §15's "declared-but-untouched entries are free" is false for archived entries

**Severity:** Medium. **Sections:** §14 (band rule), §15, §17 ("Padding is negligible: ~300 stroops ... per declared-but-untouched key"), §18, 03 §Storage (P23 auto-restore). **Invariants:** 6.

**The sentences under attack.** §15: "**Declared-but-untouched entries are free apart from footprint slots.**" §14: "every `Level` key in the contiguous tick band `[t1, pad_end]` — set or not (**unset keys cost only footprint slots**)".

**The defect.** The band rule exists because a new level can appear at any tick in the walk range between simulation and inclusion, so clients must declare every `Level` key in the band whether or not a level exists there at simulation. Under P23, archived entries that appear in the declared footprint are restored in-line, and the submitter pays the 120-day minimum rent per restored entry (03 §Storage; §18 "whoever restores pays"). A `Level` costs ~0.064 XLM to restore (§17's own number), a `TickWord` ~0.043 XLM. "Free apart from footprint slots" holds only for live keys. An attacker can manufacture the archived dead entries cheaply and once; victims then pay the restore rent every 120-day cycle with no recurrence cost to the attacker.

**Attack sequence:**
1. Attacker rests one min-size order at each of 100 ticks just worse than the current ask side (writes: `Level(asks, t)` created, ~0.064 XLM rent each; `Order` created, ~0.027 XLM each; bits set in `TickWord`/`TickSummary`). One-time cost ≈ 9 XLM.
2. Attacker settles each as open (cancel). Slots zeroed, `Order`s deleted, bits remain set (O(1) cancel, §5). Result: 100 dead levels with stale bits inside every future pad band near the book.
3. Wait 120 days. The dead `Level`s and their `TickWord`s archive; nothing touches them.
4. Victim taker's SDK pads per §14: every `Level` key in `[t1, pad_end]` plus covering `TickWord`s. All 100 archived `Level`s enter the footprint. Auto-restore charges the victim ≈ 6.4 XLM of `Level` rent plus word restores for one take. §17's "~300 stroops per padded key" is void for these keys.
5. The victim's walk clears the stale bits, but §14 still mandates declaring the keys next cycle ("set or not", because a new level could appear there in flight). The dead levels re-archive 120 days after each restore. Every subsequent era's first taker through the range pays again. The attacker spends nothing further.

**Impact.** A persistent, asymmetric cost shift (attacker ~0.09 XLM per tick once; victims ~0.064+ XLM per tick per 120-day cycle, unbounded in time), worst on sparse books that already need wide bands within the 400-entry cap. Clients cannot omit the keys without re-introducing the trap the band rule exists to prevent (a concurrent rest at a dead-archived tick restores it and the victim's walk then touches a key the victim never declared). This is a griefing vector the TTL policy section does not acknowledge: §18 treats "whoever restores pays" as benign beneficiary-pays, but here the payer is neither beneficiary nor creator.

**Mitigation.** (a) Correct §14/§15/§17: padded archived keys cost restore rent; publish a per-archived-key figure next to the 300-stroop figure. (b) Make the SDK archival-aware: query `liveUntilLedger` for band entries, and where the book shape allows, choose `pad_end` to end before large archived dead zones (accepting the documented trap trade-off explicitly rather than discovering it on the fee line). (c) Verify the restore-charging granularity assumption below (open question 2); if restores are charged only for execution-touched entries, severity drops to Low. (d) Consider noting that the first walk per era clears the stale bits, so repeat victims within an era pay the declaration restore only after re-archival.

---

#### M3. §7's `s == H` settlement row omits the `open_lots` decrement, and invariant 2's formula is not stated net of `head_consumed_lots`

**Severity:** Medium (obvious intent, conservation-critical misreading). **Sections:** §7 (settlement table), §2 (counters, slot storage), §19 invariant 2. **Invariants:** 1, 2.

**The sentences under attack.** §7 row 3: "`g == G`, `s == H` | partially filled `C` | **pay `C` at tick price; refund `q − C`; advance `H` (eagerly, past consecutive tombstones in declared entries), reset `C`**". Compare row 4, which does name its slot effect: "refund `q`; **zero its queue slot (tombstone)**". §19 invariant 2: "`open_lots` == Σ live queue qtys (inline + pages, tombstones excluded, stale slots excluded per invariant 9)" — while §2 specifies that slots store the original qty and fills never rewrite slots ("Slots behind `head_seq` are history: fully filled, never read again") and partial consumption is tracked in `head_consumed_lots`.

**The defect.** Two related gaps. (a) Row 3 pays out the head order's remaining `q − C` as a refund and retires the order, but never says "decrement `open_lots` by `q − C`". (b) Invariant 2's formula, read literally against the slot-storage rule, is wrong even for correct behavior: a partially consumed head's slot still stores the full `q`, so Σ live slot qtys exceeds `open_lots` by exactly `C`. The formula must be "Σ live slot qtys − `head_consumed_lots`" (equivalently: Σ fillable lots). §8's partial branch does say "update `head_seq`/`head_consumed_lots`/`open_lots`", so the take-side decrement is specified; the settle-side one is not, and it is the one that breaks conservation.

**Attack / failure sequence (literal implementation):**
1. Maker rests a 100-lot bid at tick 50. `open_lots` = 100. Escrow 100 × 50 × `tick_size` quote in the vault.
2. Taker sells 40 lots: `C` = 40, `open_lots` = 60 (§8 decrements correctly).
3. Maker settles (`s == H` row, as literally written): paid 40 lots of base, refunded 60 lots of quote, `H` advances, `C` = 0. `open_lots` stays 60 because no sentence decremented it. The queue now holds zero fillable lots; `open_lots` says 60.
4. Attacker sells 60 lots. §8: `open_lots (60) ≤ qty` → sweep with no slot reads: `quote += 60 × 50 × tick_size`, paid to the attacker from the vault. But the escrow backing those 60 lots was refunded in step 3. The payout drains other makers' quote escrows; invariant 1 breaks; the last claimants on the token eat the shortfall.

**Impact.** Direct conservation break (invariant 1) and fund theft, contingent on an implementer following §7's table literally. The design intent is unmistakable (sweep-without-reading-slots depends on it), hence Medium rather than Critical; but the table is the normative settlement spec and this is exactly the kind of row-level omission that survives into code when the doc is the only reference.

**Mitigation.** Add to row 3: "decrement `open_lots` by `q − C`" (row 4 should likewise say "by `q`" next to the tombstone, for symmetry). Reword invariant 2: "`open_lots` == Σ live slot qtys − `head_consumed_lots`". The M1 differential-settlement test (Σ payouts + fees == Σ deposits) catches any miss; call this case out in the test list explicitly.

---

#### M4. `create_market`'s normative check list omits the bitmap-coverage MUST and the sorted-pair requirement

**Severity:** Medium. **Sections:** §12 (`create_market`), §5 (coverage MUST), §0.1 (sorted pair), 05 interface sketch.

**The sentences under attack.** §5: "the market's tick band **MUST** fit inside one TickSummary entry". §0.1: "A market is a **sorted token pair** (SAC addresses) plus quantization params." §12: "`create_market` ... Enforces `tick_min ≥ 1` (§0.2), the §0.3 creation bounds, and `taker_fee_bps ≤ FEE_BPS_MAX`" — the full normative list, and it includes neither the §5 MUST nor sortedness/distinctness.

**Attack / failure sequence.** Admin (fat-finger or compromised key; admin-gated, so foot-gun rather than external attack) creates a market with `tick_max = 10^7 > 2^22 = 4,194,304`. A maker rests at tick 5,000,000: the bit index is `word = 5,000,000 ÷ 2048 = 2441`, which is out of range for the 2,048-bit `TickSummary`. The implementation must either panic (a reachable panic on a public path, which CLAUDE.md forbids and which makes high-tick rests permanently fail) or silently skip the bit set, which breaks invariant 3's hard direction (live level, clear bit, liquidity invisible to the bitmap walk). The `BestTick` path partially masks the damage: a rest that improves the recorded best moves `BestTick` directly, so one such level is findable; but after it is swept, `next_set_tick` can never return a tick ≥ 2^22, so any further liquidity above the coverage boundary is unreachable. Separately, without a sortedness/distinctness check, an admin can create a market with `base == quote`: accounting stays self-consistent (escrow and payout are the same token, the fee still skims), but the market is economically degenerate and the error taxonomy's `MarketExists` implies a duplicate-pair check that is impossible without a pair index (see I3).

**Impact.** Self-bricking markets: maker funds remain recoverable through `settle` (settlement keys do not depend on the bitmap), but liquidity above tick 2^22 is unreachable and every rest attempt there either traps or silently corrupts the index invariant. Bounded by admin gating; this is a foot-gun, not an external attack.

**Mitigation.** Add to §12's `create_market` list: `tick_max ≤ 2^22` (the §5 coverage MUST, enforced where it can actually be checked) and `base < quote` (sorted, distinct). One M1 test each.

---

### Low

#### L1. The post-sweep `next_set_tick` is unconditional in §8's pseudocode, so a completed take can still trap past `pad_end`

**Severity:** Low. **Sections:** §8 (pseudocode), §15 ("A place traps only if the walk must pass `pad_end`"). **Invariants:** 6, 3.

**The sentence under attack.** §8, in the sweep branch: "`best = next_set_tick(TickWord/TickSummary)`" runs unconditionally after each sweep, and §5/§8 use that result for `BestTick` maintenance ("update `BestTick(opposite)` if moved").

**The defect.** A take that consumes exactly its full `qty_lots` on the final sweep still executes the bitmap scan for the next set tick. If the next set tick lies past `pad_end` (or past the declared `TickWord`s), the read is undeclared and the transaction traps, even though the walk was finished and no further `Level` would ever be read. §15's exhaustive failure list does not contemplate a trap after the walk has terminated. An attacker can amplify this cheaply: resting one min-size ask at a far tick (~0.09 XLM, new level) forces every exact-size taker to pad all the way to that tick or trap, because the scan must locate it to update `BestTick`. The escape hatch exists inside the design's own rules: after the final sweep, leaving `BestTick` pointing at the just-swept tick is stale-*better* than the true best, which invariant 3 explicitly tolerates ("`BestTick` is never *worse* than the true best").

**Attack sequence:**
1. Attacker rests a min-size ask at tick 900 (book otherwise: one ask level at tick 100).
2. Victim simulates buying exactly the quantity at 100 and pads `[100, 150]`.
3. Execution sweeps 100, `qty_lots` = 0, then `next_set_tick` scans for the next set bit, finds it at 900, reads a `TickWord` outside the declared band. Trap. The victim's completed take reverts.

**Mitigation.** Reorder the pseudocode: skip the scan when `qty_lots == 0` and leave `BestTick` stale-better (legal per invariant 3), or document in §14 that the band must extend to the first set tick past the deepest expected sweep even when the take is expected to complete. The first option costs nothing and removes the trap class entirely.

---

#### L2. Forced `RetryRest` griefing burns the victim's full take-plus-rest fee and rolls back §8's persisted cleanup; economics favor the victim

**Severity:** Low. **Sections:** §9 (append window, `RetryRest`), §8 ("head advancement is always persisted"), §15. **Invariants:** 6, 7.

**The defect.** `RetryRest` is a typed error, so the whole place reverts, including the walk's completed takes and its persisted head-advance cleanup. An attacker who can order a transaction before the victim's within a ledger (validator collusion or ingress timing) can stuff same-level rests to push `tail_seq` past the victim's declared append window `{page(tail_sim), +1, page 0}` and force the revert.

**Attack sequence and cost accounting.** The victim's append fails only if the tail moves more than the window covers. Worst case for the attacker: `tail_sim` at the start of a page, requiring more than `2 × PAGE_SLOTS` = 64 rests (~1.9 XLM at ~0.029 XLM per rest). Best case: `tail_sim` at the last slot of a page, requiring ~33 rests (~0.96 XLM). The victim loses a failed-tx fee (~0.037 XLM for take-plus-rest) and the tombstone cleanup work reverts, so §8's "cleanup cost amortizes across takers" claim fails precisely on the failing path. Cost ratio is roughly 25-50:1 against the attacker, per attempt, and requires winning intra-ledger ordering.

**Impact.** Bounded fee griefing plus delayed head cleanup. Not economically attractive as written, but the docs should say so explicitly, because the current text presents `RetryRest` as purely benign.

**Mitigation.** None needed beyond documentation: state the attacker's cost (a page or two of same-level rests, same ledger, won ordering) against the victim's loss (one failed-tx fee). If desired later: on append-window miss, keep the take and refund the remainder instead of erroring (the `no_rest` outcome), at the price of silently dropping maker intent. The current all-or-nothing choice is defensible; it is just unpriced in the docs.

---

#### L3. Non-standard SAC asset behavior can block `settle` payouts or break conservation externally; asset eligibility is undocumented

**Severity:** Low. **Sections:** §6 (vault), §12 (`create_market`, pause/trust model), §19 invariant 1.

**The defect.** The design's cross-contract surface is correctly minimal (SAC `transfer` to and from the vault only, no reentrancy per 03), but the docs never discuss asset eligibility:

1. **Frozen or auth-required maker trustline.** `settle` pays proceeds and refunds to the maker. If the maker's trustline for the payout asset is frozen (or the asset is auth-required and authorization lapses) between rest and settle, the SAC transfer fails and `settle` reverts. Funds stay in the vault (conservation intact), but the maker's exit is blocked until the freeze lifts. "Funds exit is never gated" (§12) is then true at the PageBook layer and false at the asset layer; the doc should say this.
2. **Clawback against the vault.** A clawback-enabled issuer can claw the vault's own balance, breaking invariant 1 externally with no contract involvement. No on-chain mitigation exists; eligibility is the admin's call at `create_market`, and the docs are silent.
3. **Taker-side variants.** A taker whose output-asset trustline is frozen fails the final transfer after the walk; the tx reverts (makers unharmed, taker burns the fee). Fine, but worth one sentence.
4. **Vault trustline setup.** Nothing says who creates and reserves the vault's SAC trustlines per token (presumably `create_market` or the first transfer). This is both an implementation gap and a small unpriced cost.

**Mitigation.** Add an asset-eligibility note to §12 (`create_market` SHOULD reject or flag clawback-enabled and auth-required assets; deployments custodying value should document the residual issuer trust). Document that `settle` liveness inherits the payout asset's freeze state, and specify vault trustline creation.

---

#### L4. `keepalive` has an incentive vacuum; a lapsed crank puts a ~2.3 XLM restore on the next unsuspecting market op

**Severity:** Low. **Sections:** §12 (cranks), §17 (keepalive row), §18.

**The defect.** The crank is permissionless and pays the cranker (~2.3 XLM per 120 days, mostly wasm code rent) with no reward. If nobody cranks (most plausibly on a burn-address "trustless" deployment, §12), the instance and code entries archive, and the next market operation auto-restores them at that caller's expense. Simulation surfaces the fee, so the charge is consented to, not stolen; but a ~2.3 XLM surprise on a ~0.03 XLM operation will read as a venue outage to users, and the docs present the crank as a solved problem ("anyone may crank it") without pricing the failure mode.

**Mitigation.** Document the lapse path explicitly (first op after archival pays the restore; the venue self-heals). Optionally let `keepalive` reimburse the cranker from `FeeAccrual` up to the measured restore cost; the crank's effects remain config-defined, and the incentive becomes exact. Not required for v1 correctness.

---

### Informational

#### I1. §17's fee table assumes all-hot state and omits page/word creation rent

The rest rows cover `Order` rent and (on first touch) `Level` rent, but no row includes `LevelPage` creation (~0.05 XLM for 320 B) for a rest that crosses a page boundary, or `TickWord` creation (~0.043 XLM for 256 B) for the first rest in a word; the "first touch / restore" row's arithmetic (`0.029 + 0.064 ≈ 0.094`) shows the `TickWord` rent is not in it. The settle row's "~0.002 XLM, no rent" also conflicts with §3's statement that settling an archived `Order` auto-restores it at the settler's expense. And ADR-005's headline claim that a nonce's rent "amortizes across every update" ends at the 120-day TTL boundary: a `replace` after archival pays restore rent. All honest rows need an "assumes live entries" footnote plus a worst-case column. None of this is exploitable; it is the difference between the budget table being a bound and being a typical case.

#### I2. `generation` u32 wraparound is unanalyzed

A wrap needs 2^32 resets at one tick; each reset costs at least a rest-plus-take or rest-plus-cancel cycle (~0.06 XLM and several transactions), so wrap is centuries and ~10^8 XLM away. If it ever happened, a long-dead order whose stored `g` collided with the wrapped `G` and whose `s > H` would settle as "open" and be *refunded* from the vault, breaking invariant 1. One sentence in §2 justifying the u32 width (cost and time to wrap) closes this; no code change needed.

#### I3. `MarketExists` implies a pair-to-id index that the storage schema does not contain

The error taxonomy (05) includes `MarketExists`, but Part I's schema has only `Market(market_id)`, with ids assigned from `Config`'s counter. Detecting a duplicate `(base, quote)` pair requires a pair-keyed index entry that is nowhere specified. Either add the entry (and its rent line) or drop the error and accept duplicate-pair markets (liquidity fragmentation, no fund risk).

#### I4. Settle's one-page advance budget can strand `head_seq` at a multi-page tombstone run

§7 budgets "at most one `LevelPage`" for the `s == H` advance. A tombstone run spanning a page boundary stops the advance at the edge, leaving `head_seq` on a tombstone. I traced the consequences and they are safe: subsequent orders at the level settle under the `s > H` (open) row, which is correct because a take always advances `H` through genuinely consumed slots before partial-filling anything behind them, and the next take whose window covers the run re-cleans the head. But the stranded state and its recovery path are undocumented, and an implementer could reasonably (and unnecessarily) try to make settle declare more pages, blowing the §7 footprint budget. One paragraph in §7 suffices.

---

## 3. Checked and found sound

- **Settlement state machine (§7) against interleavings.** Sweep-after-partial, cancel-then-sweep, multi-generation claims (`g < G`), and same-ledger take/settle races all pay exactly; `Order` deletion at settle makes replay return `UnknownOrder`; counters are a complete fill proof given single-price levels (invariant 4). The only gap found is the missing `open_lots` sentence (M3).
- **Conservation flows (invariant 1).** Traced rest escrow (both sides), sweep payment (`open_lots × tick × tick_size`, exact), partial consumption, all four settle rows, replace escrow deltas, `replace_batch` netting, and fee skimming from taker output. Everything nets to vault == escrows + unclaimed proceeds + accrued fees, assuming M3's fix.
- **Empty-level reset (§2, ADR-003).** At `open_lots == 0`, no live seqs exist in `[H, tail)` (a partially consumed head contributes `q − C > 0`), every tombstone's `Order` is already deleted, and unclaimed fills are paid identically under `g < G`. The safety argument is airtight.
- **Stale-slot rule (invariant 9).** `seq < tail_seq` of the current generation is sufficient for dirty-page and dirty-inline reuse; gapless sequential appends make the decode unambiguous; generation reset over dirty pages is safe.
- **Tombstone poisoning (ADR-001 finding 2).** `MAX_SLOTS_SCANNED` plus persisted advancement plus `min_order_lots` plus ~0.027 XLM rent per dust order makes the attack expensive, bounded, and self-cleaning on succeeding paths.
- **`start_tick` scoping (invariant 5).** Late better-priced rests cannot fail or be consumed by the transaction; the `worse_of` clamp keeps the first read inside the declared band on the worse side; walk-side `Level` reads are always at-or-worse than `limit_tick` by the loop guard, so the only trap source on that side is a band narrower than the limit (the documented sparse-book residual).
- **Post-only fail-closed (ADR-003 finding 9).** Because recorded `BestTick` is never worse than the true best, the one-read check can false-reject but can never rest a truly crossing order, even against adversarially constructed stale state. Verified by case analysis on both sides.
- **Stale-bit stuffing.** Each stale bit costs the attacker a rest-plus-cancel (~0.03-0.09 XLM), burns one `MAX_LEVELS_CROSSED` slot for exactly one taker, and is cleared by that taker. Single-use, self-healing, attacker-unfavorable beyond cheap one-shot DoS.
- **Fee ceil (§0.2).** Nonzero output with nonzero bps always pays at least 1 atom; there is no zero-fee dodge via small outputs; dust accrues only to `FeeAccrual`; the base-side and quote-side fee bounds are symmetric. The only defect is the headroom arithmetic (M1).
- **Auth surface (§12).** Every state-changing entry point has an explicit `require_auth`; the constructor eliminates the init race; pause blocks entry-side ops only, never `settle` or `collect_fees`; cranks' effects are config-defined; the upgrade trust model is disclosed honestly.
- **Reentrancy and callbacks.** The host forbids reentrancy (03), token movement is SAC `transfer` to and from the vault only, and hooks are replaced by events. No callback surface exists to attack.
- **Route (§8).** Shared caps across legs make the route worst case a maximal place plus per-leg constants; per-token netting is covered by the §0.3 `MAX_ROUTE_LEGS` headroom; leg failure fails the route atomically.
- **`TickSummary` emptiness proofs.** The two-tier bitmap proves book emptiness without scanning words, so book-emptying takes need not trap (given L1's fix).
- **Width of counters.** `head_consumed_lots`/`open_lots` u64, seqs bounded by `LEVEL_CAP` far below u32, intermediates in checked i128, `tick_min ≥ 1` blocking zero-price zero-escrow orders. Generation width is the only unanalyzed one (I2).

## 4. Open questions

1. **Rest-side key set.** What is the exact, exhaustive key list for a place's own rest (`Level(own_side, limit_tick)`, own-side `BestTick`/`TickSummary`, bitmap words, append pages, `Order`)? §14 must enumerate it; H1 depends on this.
2. **Restore charging granularity.** Does P23 auto-restore charge for every archived entry in the declared footprint, or only for entries execution actually touches? 03 says "entries a transaction touches" while describing a footprint-driven mechanism. M2's severity (permanent per-cycle victim cost vs one-time) turns on this; verify against the live host before M4.
3. **Untyped constants and their joint constraints.** Values for `MAX_ROUTE_LEGS` and `MAX_REPLACE_BATCH` are never stated. `MAX_ROUTE_LEGS` must satisfy `4 × MAX_ROUTE_LEGS × LEVEL_CAP ≥ FEE_BPS_MAX` (M1), and `MAX_REPLACE_BATCH` must satisfy the event-byte bound (~2 events per item against 16,384 bytes, so roughly ≤ 80) and the 200-write cap when batched settles touch distinct pages.
4. **`BestTick` empty-flag lifecycle.** When exactly is it set (sweep to empty, lazy walk to empty?) and cleared (any rest?), and how does the "move if better" rule interact with a set flag (H2)?
5. **Band depth for `BestTick` maintenance.** Must the band extend to the first set tick past the deepest expected sweep when `qty_lots` may reach zero mid-band, or will the implementation skip the post-sweep scan (L1)? The two choices imply different §14 guidance.
6. **Settle payout destination.** Is the payout always to the owner in the `Order` key, or may a caller-specified recipient differ? Relevant for contract-owned orders and smart-wallet custody.
7. **Vault trustline provisioning.** Who creates and reserves the vault's SAC trustlines per token, and in which entry point (L3)?
8. **`quote_place` fidelity.** Must the read-only view replicate the walk's lazy clears, caps, and window edges bit-for-bit so that simulation and application cannot diverge, and what is the specified behavior when stale-bit state makes the quoted fee or fill approximate?
9. **Stranded-head policy.** Is leaving `head_seq` on a tombstone at a page boundary (I4) the intended settle behavior, with re-cleaning delegated to the next take, or should settle's window protocol allow declaring extra pages for deeper advance?
10. **`keepalive` funding.** Is the crank expected to be altruistic, admin-run, or reimbursed from `FeeAccrual` (L4)? On burn-address deployments, who is expected to pay the ~2.3 XLM?
