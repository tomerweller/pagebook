# 028: Where declared write bytes go: the coverage model, measured

Date: 2026-08-20. The padded transactions of section 14 declare more write
bytes than the host meters, and ledger admission runs on declared resources,
so every unneeded declared byte is ledger throughput lost (ADR-027 measured
write bytes as the binding per-ledger cap). This note measures, on testnet,
exactly what the protocol requires a declaration to cover, decomposes the
client pad's declaration into its parts, and demonstrates an existence-aware
pad that recovers the client-side share. Tools: `tools/research/decompose.py`
(bisection, size sweep, pad v2 demo) and `tools/research/analyze.py`
(decomposition); raw attempts in `tools/research/decompose.log` (local).

## Method

Three shapes on market 0 (PBA/PBB), driven through the standard pipeline
(build, simulate, union the section 14 pad, sign, send), with the declared
`write_bytes` and `instructions` edited between encode and sign:

- **a. place, post-only rest**: `pb-stress1`, fresh nonce, fresh far ask
  tick (62000 to 65000), quantity 1. Creates a Level and an Order.
- **b. replace, one quote**: `pb-stress2` re-quoting one of its resting
  stress fixtures (nonce 777001000, tick 217) in place. Creates nothing.
- **c. replace_batch, 40 word-dispersed quotes**: `pb-stress3` re-quoting
  all 40 of its fixtures across all 32 tick words, padded to 191 read-write
  entries exactly as `tools/stress/stress.py` does. The heaviest legal
  PageBook transaction (ADR-027).

For each shape and each dimension, bisection over resubmitted copies (every
attempt rebuilt for a fresh sequence number) finds the minimal accepted
declaration, then single probes pin the exact boundary. A declaration one
byte short fails at apply, `InvokeHostFunction(ResourceLimitExceeded)`, and
the fee is charged; no shortfall was ever rejected at send, because the
declared resource fee (computed for the full pad) always exceeded the
minimum for the reduced declaration. The probe cost is therefore real:
a failed batch attempt charged 797,618 to 814,176 stroops, about 90 percent
of a successful batch's 911,307. About 55 transactions total, all on the
stress accounts; the 14 far-tick research orders were settled afterwards.

On-ledger sizes of every footprint entry came from RPC `getLedgerEntries`;
an entry's reported XDR is its `LedgerEntryData`.

## Minimal accepted declarations

Write bytes (exact boundaries: the value shown is accepted, one byte less is
rejected):

| shape | simulated | pad declares | minimal accepted | metered | declared over minimal |
|---|---:|---:|---:|---:|---:|
| a. place, post-only rest | 1,400 | 8,000 | 3,736 | 3,736 | 2.14x |
| b. replace, one quote | 1,024 | 8,224 | 3,736 | 3,736 | 2.20x |
| c. batch40, word-dispersed | 27,700 | 93,100 | 53,380 | 53,380 | 1.74x |

Instructions (boundaries bracketed by probes):

| shape | simulated | pad declares | minimal accepted | metered cpu_insn | declared over metered |
|---|---:|---:|---:|---:|---:|
| a | 2,884,655 | 5,781,586 | 3,065,713 to 3,077,029 | 3,067,565 | 1.88x |
| b | 3,256,140 | 6,347,368 | 3,390,000 to 3,395,000 | 3,394,186 | 1.87x |
| c | 77,661,408 | 107,273,689 | 82,440,000 to 82,460,000 | 82,450,807 | 1.30x |

In both dimensions the minimal accepted declaration equals the metered value
(exactly for write bytes, within probe resolution of 0.02 to 0.4 percent for
instructions). The host meters the requirement, not the touch: metered
`ledger_write_byte` and `write_entry` count every existing read-write
footprint entry at its full size whether or not the invocation writes it
(shape c meters 151 written entries; 151 is exactly the count of its
read-write keys that exist, out of 191 declared). The declared-versus-
metered gap is therefore entirely client-side; the protocol floor is the
metered number itself.

## The coverage model

Fetching the actual size of all 191 read-write entries of shape c: 151
exist, and their `LedgerEntryData` XDR sums to 52,172 bytes. The measured
minimal is 53,380, which is 52,172 plus exactly 151 x 8. The same holds on
the light shapes to the byte (shape b: 14 existing entries, data sum 3,624,
plus 14 x 8 is 3,736; shape a: 12 existing entries at 2,956 plus 12 x 8,
plus a created Level at 396 + 8 and a created Order at 272 + 8, is 3,736).

So the model, verified with zero residual on all three shapes:

> A transaction's declared `write_bytes` must cover, for every read-write
> footprint key, the entry's size at apply time: its `LedgerEntryData` XDR
> plus 8 bytes of `LedgerEntry` framing (`lastModifiedLedgerSeq` and the
> `ext` discriminant). A key whose entry does not exist and is not created
> costs zero; a created entry is covered at its post-creation size. The
> `LedgerKey` XDR is not counted.

This answers the framing question: 8 bytes per entry, not 100 to 200, and
keys are free. The simulator follows the same model: on every shape the
simulated `write_bytes` equals the coverage of the simulated footprint under
this formula, with zero slack. Entries here were rewritten at unchanged
size; an entry rewritten larger must be covered at the larger size (creation
is the extreme case, coverage from zero to full size), and shrinking writes
were not probed separately.

Measured entry coverages on market 0 (data plus 8): Level 404, TickWord 376,
Order 280, TickSummary 372, BestTick 156, FeeAccrual 184, SAC balance 224,
SAC instance 472, trustline 116. The pad's flat 600 overestimates every one
of them.

For instructions, the minimal accepted declaration is the metered
`cpu_insn`, which already includes the host's footprint processing. The
processing cost of an added key is far below the pad's 120,000 allowance:
the batch shape meters 4.79M instructions above simulation for 109 added
keys (about 44,000 each), the light shapes 12,000 to 17,000 each.
Instructions do not bind the ledger for this workload (ADR-027), so the pad
keeps its allowance.

## Decomposition of the pad's declared write bytes

The pad declares simulation plus a flat 600 bytes per added key. Splitting
that against the model (`tools/research/analyze.py`):

| slice | a. place | b. replace | c. batch40 |
|---|---:|---:|---:|
| (i) protocol floor (coverage owed) | 3,736 (46.7%) | 3,736 (45.4%) | 53,380 (57.3%) |
| (ii) flat-600 excess on existing added keys | 3,064 (38.3%) | 3,288 (40.0%) | 15,720 (16.9%) |
| (iii) 600 each for nonexistent keys | 1,200 (15.0%) | 1,200 (14.6%) | 24,000 (25.8%) |
| (iv) simulation-side slack | 0 | 0 | 0 |
| declared total | 8,000 | 8,224 | 93,100 |
| recoverable (declared minus floor) | 4,264 (53.3%) | 4,488 (54.6%) | 39,720 (42.7%) |

The two recoverable slices are the flat rate's excess over true entry sizes
on keys that exist, and the full 600 on keys that do not exist at all (for
the batch, the 40 page-0 keys of levels whose queues are inline). Nothing in
the gap is protocol-mandated beyond the floor.

## Pad v2: existence-aware coverage

`tools/soak/soak.py` `apply_pad` now takes an optional `sizes` argument
(default None keeps the flat behavior; the running bots are unaffected).
With it, each added key is covered at its actual on-ledger size plus 8
(supplied by a `getLedgerEntries` sweep over the pad keys before declaring,
one RPC round trip per 100 keys) plus a per-key growth margin, and
nonexistent keys are covered at zero. Instruction and fee headroom per key
are unchanged.

Demonstrated on shape c with a growth margin of 16 bytes per existing key:

- declared write bytes **54,484** against the flat pad's 93,100 (a 41.5
  percent reduction), landed `SUCCESS`, metered 53,380, so the safety margin
  above the floor was 1,104 bytes (the pooled growth margin).
- ledger fit at saturation: floor(286,720 / 54,484) = **5 batches per
  ledger** at 95.0 percent of the ledger write-byte cap, against 3 at
  93,100 declared (ADR-027). Five is also the metered-exact bound
  (286,720 / 53,380 = 5.37), so pad v2 reaches the ceiling that
  metered-exact footprints would; the remaining declared excess (about 2
  percent) buys the growth margin.

### The race, quantified

The declaration is computed from a snapshot; coverage is owed at apply. Two
things can invalidate it in flight:

1. A key declared at zero coverage comes to exist. Any read-write key that
   exists at apply owes its size, written or not, so another account
   creating that entry after the sweep makes the declaration short. For the
   batch shape the zero-covered set is the 40 page-0 keys, each created only
   when that level's inline queue (32 slots) overflows, which needs on the
   order of 30 other rests on that exact tick in flight; on dispersed
   far-from-touch ticks this is rare by construction. Shapes that pad empty
   band levels carry more such keys (a level is created by a single rest),
   so their exposure is larger.
2. An existing entry grows past its margin (a level gaining queue entries,
   an order rewritten larger). The margin is pooled across the transaction,
   so 16 bytes per key absorbed any single-entry growth up to about 1 KB in
   the demo.

The exposure window runs from the `getLedgerEntries` sweep to apply: about 1
second of sweep, 3 to 6 seconds of build, simulate, sign and send, plus
inclusion at 1 to 2 ledgers nominally and up to 6 under saturation
(ADR-027), so roughly 10 seconds nominal and 40 seconds at the congested
tail. A lost race fails at apply as `ResourceLimitExceeded` and charges the
fee: 0.08 XLM for the batch shape, about 90 percent of a successful batch's
fee. The recovery is to resimulate and resubmit, one more window. At that
price the pad v1 flat rate remains the right default for casual traffic; the
existence-aware pad pays for itself where declared write bytes are the
binding throughput constraint and the client already tracks the book (a
re-quoting maker can reuse one sweep across cycles, its footprint barely
changes).

## Recommendation

1. Keep the flat 600-byte pad as the default client behavior; it is simple,
   raceless with respect to entry creation, and its cost is capacity, not
   money.
2. Where batch throughput at the ledger cap matters (the market maker's
   re-quote cycle, any fleet that saturates), use `apply_pad` with `sizes`:
   an existence sweep over the pad keys, coverage at actual size plus 8,
   growth 16 to 32 bytes per key, and accept the quantified race. This is
   worth 3 to 5 batches per ledger on the heaviest shape.
3. Anything that estimates entry coverage should use the measured per-type
   sizes above, not 600, and should treat the metered `ledger_write_byte`
   of a landed transaction as the exact minimal declaration for that
   execution (useful for regression tests and capacity math).
4. Section 17's capacity arithmetic can treat declared write bytes as fully
   decomposable: floor plus client estimate error; there is no hidden
   protocol overhead beyond data plus 8 per entry.
