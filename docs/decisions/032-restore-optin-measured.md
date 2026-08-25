# 032: Restore opt-in measured on testnet, and a padding assumption falls

Date: 2026-08-25. The three transactions ADR-025 scheduled against archived
fixtures (created 2026-08-18, archived at the ~120,960-ledger testnet TTL),
executed the day the fixtures crossed their TTL. Two behaved as designed.
One did not, and it invalidates a claim the padding protocol relied on.

## Setup

Fixtures on market 0, confirmed archived via `getLedgerEntries`
(`liveUntilLedgerSeq` in the past): `Level(asks, 60000)` (empty, stale bit),
`TickWord(29)`, `Level(asks, 61000)` and `Order(pb-maker, 900002)` (a live
1-lot ask). A bonus confirmation before the tests: `TickWord(29)` archived
on schedule even though the stress fleet wrote bits into it days after
creation. Writes do not extend TTLs; only creation and restore pay rent and
reset the clock.

## Test 1: a declared, untouched, unmarked archived key. FAILS.

A 1-lot bid with `limit_tick` 50 (crossing nothing, walking nowhere) whose
pad declared the archived `Level(asks, 60000)` read-write, unmarked. ADR-025
and section 14 predicted success with no restore charge: "an archived key
that is declared but not listed costs only its footprint slot and fails the
transaction only if execution touches it."

Measured: **the transaction fails at apply with `EntryArchived`, fee
charged** (86,749 stroops paid for nothing). The host loads every read-write
footprint entry before execution; an archived one aborts the transaction
whether or not the invocation would have touched it. The prediction in
docs/03 and the "padding archived keys is free" note in section 14 are both
wrong.

The failure was overdetermined: by test time the *organic* band around
market 0's bests had begun archiving too (ask levels 98 to 101, including
both recorded bests, hit their TTLs mid-campaign). Any band pad spanning
them fails the same way.

## Test 2: the walk lands on the archived level, marks as simulated. WORKS.

A 1-lot no-rest bid with `start_tick = limit_tick = 60000`. Simulation
touched the archived level and its word and returned
`archived_soroban_entries: [2, 3]` in the soroban data ext. Submitted as
simulated: success. The walk cleared the stale bit and healed the index
through a restore. Fee 133,093 stroops total; the restore rent component is
about 46k stroops on testnet, far below the section 17 mainnet estimate,
because testnet's state-size-dependent rent rate sits near its floor. Do
not read testnet restore costs as mainnet predictions.

## Test 3: settle an archived order. WORKS.

`settle(pb-maker, 0, 900002)`: simulation marked the archived `Order` and
`Level(61000)`; the settle landed (85,800 stroops) and the 1-lot escrow
returned exactly. The claim-by-counters path is unaffected by archival:
restore, then settle, one transaction.

## What this means for the padding protocol

The band pad is only safe over live keys. Once any level in a declared band
archives, every padded transaction spanning it fails at apply, with fees
paid, until something restores it. Entries archive on a fixed clock
(~120 days after creation or last restore on mainnet, 7 days on testnet),
so this is not an edge case: it is the guaranteed fate of every band that
outlives its neighborhood's rent.

Mitigations, in the order they should land (tracked in the repo issue):

1. **Liveness-aware pads.** Pad v2's `getLedgerEntries` sweep already
   fetches `liveUntilLedgerSeq`; drop archived keys from the pad instead of
   declaring them. The residual race (someone restores and rests on that
   tick between sweep and apply, and the walk reaches it) is the same class
   and likelihood as pad v2's existing create race: rare, costs one fee,
   retry heals it.
2. **Mark what the walk will plausibly reach.** For takes that genuinely
   sweep deep, simulation already marks the archived entries it touches;
   the client should keep those marks and pay the restore rent as part of
   the take.
3. **Keepalive discipline** (section 12) graduates from hygiene to
   requirement: a market operator must keep the active band's entries alive
   or takers' pads decay into failures. The maker's own re-quoting keeps
   its ladder ticks alive; the gaps between ladders are what archive.

Sections 14 and 15 and docs/03 are corrected alongside this note; ADR-019's
"partial" M4 status is closed by these three transactions.
