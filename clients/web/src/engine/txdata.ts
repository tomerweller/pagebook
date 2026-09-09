import * as StellarSdk from "@stellar/stellar-sdk";
import type { PlannedLedgerKey } from "./clientKeys";

export const WRITE_ENTRY_FEE = 2500;
// Flat per-key write-byte cover (pad v1, and the creation estimate under
// pad v2). A `Level` is one entry holding the whole queue (ADR-037): 124 B of
// payload empty, 12 B more per resting order, 1,000 B on the ledger at the
// default level_cap of 64. The flat rate must clear a full one plus growth —
// and level_cap is raise-only up to 128, so the rate is per market, not a
// constant: `flatWriteBytesPer` adds 12 B per slot above the default cap.
export const WRITE_BYTES_PER = 1100;
export const DEFAULT_LEVEL_CAP = 64;
export const LEVEL_SLOT_BYTES = 12;

/** The flat per-key rate for a market at `levelCap` (default-cap rate plus
 *  the raisable slots). Callers that know the market's `level_cap` must pass
 *  it; a raised market under the default-cap rate re-creates the one-entry
 *  write-byte shortfall of 2026-08-26. */
export function flatWriteBytesPer(levelCap?: number): number {
  const cap = levelCap ?? DEFAULT_LEVEL_CAP;
  if (cap <= DEFAULT_LEVEL_CAP) return WRITE_BYTES_PER;
  return WRITE_BYTES_PER + (cap - DEFAULT_LEVEL_CAP) * LEVEL_SLOT_BYTES;
}
export const DISK_READ_PER = 400;
// Instruction headroom: a walk can do more work at apply than simulation
// saw (levels appear in flight during a trend). 1.2x + 1M fell short by
// measured margins during fast rallies (ADR-026, ADR-028 era logs), so the
// flat part must not depend on the simulated amount. The TypeScript engine
// counts added + addedRo; tools/soak apply_pad still promotes every planned
// key to read-write and is the outlier (ADR-038).
export const INSTR_MULT = 1.25;
export const INSTR_PER = 120_000;
export const INSTR_FIXED = 3_000_000;
export const FEE_ONCE = Math.floor((INSTR_FIXED * 7) / 10_000);

/** Resource-fee cover per added pad key. Scales with the flat write-byte
 *  rate, so a raised-cap market's fee matches its declared bytes. */
export function perAddedFee(levelCap?: number): number {
  return (
    WRITE_ENTRY_FEE +
    Math.floor((flatWriteBytesPer(levelCap) * 875) / 1024) +
    perAddedRoFee()
  );
}

export function perAddedRoFee(): number {
  return Math.floor((DISK_READ_PER * 447) / 1024) + 1_563 + 120 * 7 + 100;
}
export const PER_ADDED = perAddedFee();

function keyB64(k: StellarSdk.xdr.LedgerKey): string {
  return k.toXDR("base64");
}

function writeBytesFor(
  added: number,
  addedKeys: StellarSdk.xdr.LedgerKey[],
  sizes?: ApplyPadSizes,
  levelCap?: number,
): number {
  if (!sizes || sizes.coverBytes === false) return flatWriteBytesPer(levelCap) * added;
  const growth = sizes.growth ?? DEFAULT_GROWTH;
  let extra = sizes.slack ?? 0;
  for (const k of addedKeys) {
    const info = sizes.sizeOf(k);
    if (info?.exists) {
      extra += info.actualSize + growth;
    } else {
      // A key that does not exist yet is free ONLY if nothing writes it. The
      // operation itself may create it (a fresh level, the order),
      // and a created entry must be covered at its post-creation size:
      // measured shortfalls of exactly one entry (204 to 300 bytes) took the
      // maker down on 2026-08-26. Cover at the per-type budget estimate.
      extra += info?.createSize ?? flatWriteBytesPer(levelCap);
    }
  }
  return extra;
}

export type DeclaredResources = {
  rw: number;
  ro: number;
  instr: number;
  wb: number;
  fee: number;
};

export type ApplyPadResult = {
  data: StellarSdk.xdr.SorobanTransactionData;
  added: number;
  addedRo: number;
  dropped: number;
  resourceFee: bigint;
};

export function declaredFromSoroban(data: StellarSdk.xdr.SorobanTransactionData): DeclaredResources {
  const res = data.resources();
  const fp = res.footprint();
  return {
    rw: fp.readWrite().length,
    ro: fp.readOnly().length,
    instr: Number(res.instructions()),
    wb: Number(res.writeBytes()),
    fee: Number(data.resourceFee().toString()),
  };
}

export type KeyLiveness = "live" | "archived" | "nonexistent";

export type PadKeySize = {
  exists: boolean;
  actualSize: number;
  liveUntil?: number;
  liveness?: KeyLiveness;
  /** Coverage for a key the operation may create (per-type budget estimate).
   *  Defaults to the flat per-key rate when absent. */
  createSize?: number;
};

export type ApplyPadSizes = {
  sizeOf(key: StellarSdk.xdr.LedgerKey): PadKeySize | undefined;
  growth?: number;
  slack?: number;
  coverBytes?: boolean;
  latestLedger?: number;
};

// Headroom over an existing entry's size for growth between pad and apply:
// a rest by someone else into a padded `Level` adds 12 B per order (ADR-036),
// so 48 B rides out three in-flight appends.
export const DEFAULT_GROWTH = 48;

function simRestoreKeys(data: StellarSdk.xdr.SorobanTransactionData, rw: StellarSdk.xdr.LedgerKey[]): StellarSdk.xdr.LedgerKey[] {
  if (data.ext().switch() !== 1) return [];
  const idxs = data.ext().resourceExt().archivedSorobanEntries();
  const out: StellarSdk.xdr.LedgerKey[] = [];
  for (const raw of idxs) {
    const i = Number(raw);
    if (Number.isInteger(i) && i >= 0 && i < rw.length) out.push(rw[i]);
  }
  return out;
}

function unionLedgerKeys(a: StellarSdk.xdr.LedgerKey[], b: StellarSdk.xdr.LedgerKey[]): StellarSdk.xdr.LedgerKey[] {
  const seen = new Set<string>();
  const out: StellarSdk.xdr.LedgerKey[] = [];
  for (const k of [...a, ...b]) {
    const s = keyB64(k);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(k);
  }
  return out;
}

export function applyPad(
  data: StellarSdk.xdr.SorobanTransactionData,
  extra: PlannedLedgerKey[],
  restoreMarks: StellarSdk.xdr.LedgerKey[] = [],
  sizes?: ApplyPadSizes,
  levelCap?: number,
): ApplyPadResult {
  const builder = new StellarSdk.SorobanDataBuilder(data);
  const ro = [...builder.getReadOnly()];
  const rw = [...builder.getReadWrite()];
  const rwSet = new Set(rw.map(keyB64));
  const roMap = new Map(ro.map((k) => [keyB64(k), k]));

  let added = 0;
  let addedRo = 0;
  let dropped = 0;
  const addedKeys: StellarSdk.xdr.LedgerKey[] = [];
  const nextRo = [...ro];
  const nextRw = [...rw];
  for (const planned of extra) {
    const k = planned.key;
    const s = keyB64(k);
    if (rwSet.has(s)) continue;
    if (sizes?.sizeOf(k)?.liveness === "archived") {
      dropped += 1;
      continue;
    }
    if (planned.access === "rw") {
      if (roMap.has(s)) {
        const idx = nextRo.findIndex((x) => keyB64(x) === s);
        if (idx >= 0) nextRo.splice(idx, 1);
        roMap.delete(s);
      }
      nextRw.push(k);
      rwSet.add(s);
      added += 1;
      addedKeys.push(k);
      continue;
    }
    if (roMap.has(s)) continue;
    nextRo.push(k);
    roMap.set(s, k);
    addedRo += 1;
  }

  builder.setReadOnly(nextRo);
  builder.setReadWrite(nextRw);

  const res = data.resources();
  const paddedKeys = added + addedRo;
  const instructions = Math.floor(Number(res.instructions()) * INSTR_MULT) + INSTR_PER * paddedKeys + INSTR_FIXED;
  const writeBytes = Number(res.writeBytes()) + writeBytesFor(added, addedKeys, sizes, levelCap);
  const diskReadBytes = Number(res.diskReadBytes()) + DISK_READ_PER * paddedKeys;
  builder.setResources(instructions, diskReadBytes, writeBytes);

  const rf0 = BigInt(data.resourceFee().toString());
  const rf =
    (rf0 * 13n) / 10n +
    BigInt(perAddedFee(levelCap) * added) +
    BigInt(perAddedRoFee() * addedRo) +
    BigInt(FEE_ONCE);
  builder.setResourceFee(rf.toString());

  const marked = unionLedgerKeys(simRestoreKeys(data, rw), restoreMarks);
  const want = new Set(marked.map(keyB64));
  const archivedIndexes: number[] = [];
  nextRw.forEach((k, i) => {
    if (want.has(keyB64(k))) archivedIndexes.push(i);
  });

  let out = builder.build();
  out = new StellarSdk.xdr.SorobanTransactionData({
    ext: archivedIndexes.length
      ? new StellarSdk.xdr.SorobanTransactionDataExt(
          1,
          new StellarSdk.xdr.SorobanResourcesExtV0({ archivedSorobanEntries: archivedIndexes }),
        )
      : new StellarSdk.xdr.SorobanTransactionDataExt(0),
    resources: out.resources(),
    resourceFee: out.resourceFee(),
  });
  return { data: out, added, addedRo, dropped, resourceFee: BigInt(out.resourceFee().toString()) };
}

export function classicFee(resourceFee: bigint): string {
  return (resourceFee + 1000n).toString();
}

export function estimatePaddedFee(counts: { rw: number; ro: number }, simResourceFee = 0n, levelCap?: number): bigint {
  const rf =
    (simResourceFee * 13n) / 10n +
    BigInt(perAddedFee(levelCap) * counts.rw) +
    BigInt(perAddedRoFee() * counts.ro) +
    BigInt(FEE_ONCE);
  return rf + 1000n;
}
