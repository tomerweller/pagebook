# 039: Shared transaction preparation

Date: 2026-09-09. Browser and bots share one preparation function between
intent and signature.

## Boundary

`prepareInvocation` takes a typed intent (`place`, `placePostOnly`,
`settle`, `replace`, `replaceBatch`, or `invoke`) and an optional
`PadPolicy`. `invoke` is the crank escape hatch: a function name and ScVal
args, used by keepalive. `levelCap` is a field on the request, not on the
policy. The function returns a prepared unsigned transaction with declared
resources, footprint, restore marks, dropped-key count, and observed
ledger; a restore preamble; or a typed engine error. Callers supply trade
intent and padding policy. They do not assemble `quoted`, `padOut`, and
`sizes` as independent inputs.

`submitInvocation` is prepare, sign, send. A restore preamble runs
`submitRestorePreamble` (at most two times) and then prepare runs again.
If a restore preamble is still present after two restores, the result is
`{ kind: "rpc", message: "restore preamble persisted" }`.

## Caps check

After padding, the client checks the final declaration against the
per-transaction caps in docs/03: 400 footprint entries, 200 read-write
entries, 132,096 write bytes, 400,000,000 instructions, and 132,096
transaction bytes (unsigned envelope plus 256 bytes of signature headroom).
An oversize request returns `{ kind: "resourceLimit", at: "prepare" }`. The
message names the resource, the declared value, the cap, and, for a place,
the band shape (level count and how many of those levels exist). The intent
is never modified. The client does not narrow `padEnd` or `limitTick`.
The sweep counts only the read-write keys `applyPad` would add, not
`Config`, `Market`, token instances, or keys already in the simulation
read-write list. It stops while chunks remain once that count exceeds a
cap, and it refuses before fetching when more than 1,600 uncovered keys
would be read (`MAX_SWEEP_KEYS`). Those early results name the count so
far and, for a place, `(band N levels, unswept)`; they have no `declared`
field because padding did not run.

## Cover and extra keys

The normal path is `cover: "sized"` (pad v2, ADR-028): write-byte cover
comes from the liveness sweep, with per-type creation estimates for absent
keys. `cover: "flat"` is a named research mode that applies the pad v1
per-key rate. `extraKeys` is a named research mode for explicit extra pad
keys (the stress bot's `--extra-pad`). Liveness classification and archived
key dropping run in every mode. Only the write-byte cover differs.

The maker may pass a cached universe sweep as `policy.sweep`. Prepare
sweeps only the keys the cache does not already cover.

## Restore marks

Marks come from liveness (`exists` and `liveUntilLedgerSeq` before the
observed ledger), not from absence. A key that does not exist is never
archived. That closes issue #28: a new `Order` is not restore-marked.

`applyPad` keeps an archived planned key that is in `restoreMarks`: the key
is added read-write and marked. Archived planned keys outside the marks are
dropped.

## Residual races

Preparation does not close sim-to-apply races. Those races now have one
implementation:

- Pad v2 create race: a key absent at sweep, created before apply, covered
  at the creation estimate.
- Restore-and-rest onto a dropped archived tick that the walk then reaches.
- Level growth past `DEFAULT_GROWTH` between sweep and apply.
- The book moving past `pad_end` (architecture §15 trap).
