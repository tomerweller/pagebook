# 013 — Dust orders: rent bounds holding, not churn

Date: 2026-08-17. Docs only; no design change.

## Question

Is the design vulnerable to mass creation of dust orders?

## Answer recorded in the docs

Not to fund loss, and not to unbounded degradation: `min_order_lots`, non-refundable
`Order` rent, `LEVEL_CAP`, `MAX_SLOTS_SCANNED` with persisted head advance,
`MAX_LEVELS_CROSSED`, sweep-without-slot-reads, and the empty-level reset bound every
dust vector (tombstone poisoning, `LevelFull` at a price, fragmentation across ticks,
stale-bit and stale-`BestTick` stuffing) to one cap's worth of damage for one taker,
healed by the next take.

What the docs overstated was the *cost* of re-arming those vectors. §5, §9, §14 and
§17 priced a stale bit or a tombstone at a fresh rest plus cancel (~0.03–0.09 XLM),
and §17 called rent "anti-spam economics". Rent is a holding cost: `replace` — designed
so a market maker's nonce is a rent-free quote slot — equally lets an attacker who has
paid rent on K nonces move them for ~0.001 XLM each, and every move tombstones a slot,
can leave a stale bit at the old tick, and can leave `BestTick` pointing at an emptied
level. The per-instance re-arm cost is therefore ~30× lower than stated. The one
concrete effect worth naming is the phantom best: dust rested inside the spread and
replaced away leaves `BestTick(opposite)` at an empty inside price, and post-only rests
on the other side fail `Crossed` until a taker walks through.

## Changes

- §17 gains "Rent bounds holding, not churn": what `replace` makes cheap, why it stays
  bounded and self-healing, and that the churn deterrent is `min_order_lots × price`
  (dust inside the spread is filled at that price by the first taker; dust at the best
  price is swept for its notional), retunable via `set_market_caps`.
- §9 prices the phantom-best griefing and states that v1 accepts it rather than read
  the recorded best's `Level` on every post-only rest.
- §5, §10, §14 re-state seeding costs at both the fresh and the churn price and point
  at §17; §14 notes a stale bit over an archived level is one-shot per bit and 120
  days per level even at the churn price.
- Explainer: the "doubles as anti-spam" line is scoped to holding.

## Considered, not adopted (would change the design)

- A small fixed `replace` fee to `FeeAccrual`, so churn is priced.
- Post-only reading `open_lots` of the recorded best's `Level` (its key is known at
  simulation) and ignoring a stale best.

Both are cheap; neither is needed for v1 given the bounds above. Revisit if phantom
bests are observed to lock quoters out on real markets.
