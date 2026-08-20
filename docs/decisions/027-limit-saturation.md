# 027: Saturating the ledger limits on purpose

Date: 2026-08-21. The utilization tables in docs/09 ranked the network limits
by extrapolation. This note records the direct test: a fleet built to
oversubscribe the per-ledger caps, run against testnet, to see which limit
actually rations inclusion and how the network behaves at the edge.

## Setup (`tools/stress/stress.py`)

Eight accounts (`pb-stress1..8`) on market 0, each holding 40 resting quotes
dispersed across all 32 tick words, each re-quoting all 40 in a single
`replace_batch` about once per ledger. With the section 14 pad trimmed to
page 0 per level and topped up with a neighbor's existing levels, one batch
declares:

- 191 read-write entries (95.5 percent of the 200 per-transaction cap)
- 93,100 write bytes (70 percent of the 132,096 per-transaction cap)
- 107M instructions (27 percent of 400M; metered 82M, the word dispersal is
  compute-heavy)
- resource fee about 1.33M stroops declared, 0.091 XLM charged

Eight of those per ledger demands about 1,530 read-write entries and 745 KB
of write bytes against ledger caps of 1,000 and 286,720: oversubscription by
1.5x and 2.6x. The run: 253 ledgers (4,248,443 to 4,248,693), 708 attempted
batches, 578 landed. Seeding left 320 small resting orders on market 0; they
stay as reusable stress fixtures.

## What the network did

**Write bytes ration the ledger, and nothing else comes close.** The chain
admitted at most **3 batches per ledger**: 3 x 93,100 = 279,300 declared
write bytes, **97.4 percent of the 286,720 cap** (a fourth batch would
overflow it). At that same saturation point the other dimensions sat at 57
percent (read-write entries, 573 of 1,000) and 55 percent (instructions,
322M of 580M). Per-ledger totals of our own batches, whole run: median 2,
p95 3, never 4. This is the docs/09 ranking measured instead of
extrapolated: the write-byte cap binds first with a wide margin.

**The excess queues, then gets priced out.** Inclusion delay for landed
batches: median 2 ledgers, p95 4, max 6 (submit-to-inclusion wall time
median 10.8 s, max 44.8 s). 84 attempts were rejected `TxInsufficientFee`,
surge pricing on the soroban lane at the default inclusion fee, and 45 timed
out at submission. The charged resource fee itself stayed flat (911k
stroops); congestion shows up as inclusion-fee competition, not as a higher
resource price.

**Small transactions kept flowing.** The market 1 maker and trader ran
through the whole window and stayed healthy (their check stayed `MM OK`,
fills continued): their ~10 to 20 KB transactions fit in the write-byte gaps
the 93 KB batches could not use. The lane degrades by squeezing out the
biggest declarers first.

## What it means for limits, and for us

1. **`ledgerMaxWriteBytes` (286,720) is the cap to raise.** It saturated at
   97 percent while write entries and instructions sat near half. Doubling
   it roughly doubles admitted book-update throughput; nothing else needs to
   move with it for this workload until about 2x (at ~5 batches per ledger,
   write entries at 955 and instructions at 536M start to bind, so a 2x+
   write-byte raise should bring `ledgerMaxWriteLedgerEntries` along).
2. **The declared-vs-metered gap is ours to close, but measure the right
   shape first.** The dispersed batch meters 151 written entries, 53,380
   write bytes and 82M instructions (a same-tick batch meters ~12 KB: word
   dispersal is what makes this the heaviest legal transaction). Against
   93,100 declared, the pad costs 1.74x on bytes for this shape; with
   metered-exact footprints the ledger would fit ~5 such batches instead of
   3. Where the remaining declared bytes go, how much of the gap is
   protocol-mandated (an existing read-write entry must be covered at its
   full size even if never written, ADR-025) versus client flat-rate
   over-estimation, is an open question tracked in the repo issue on the
   declared/metered gap.
3. **The per-transaction caps are adequate.** The biggest legal PageBook
   transaction fits with room (95 percent of RW entries only because we
   padded it there deliberately; 70 percent of write bytes). Raising per-tx
   caps without raising the ledger caps would just let one transaction eat a
   bigger fraction of an unchanged ledger.

docs/09 carries the summary tables; this note is the method and the raw
shape of the result.
