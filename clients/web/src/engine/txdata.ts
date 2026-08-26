import * as StellarSdk from "@stellar/stellar-sdk";

export const WRITE_ENTRY_FEE = 2500;
export const WRITE_BYTES_PER = 600;
export const DISK_READ_PER = 400;
// Instruction headroom mirrors tools/soak apply_pad: a walk can do more work
// at apply than simulation saw (levels appear in flight during a trend);
// 1.2x + 1M fell short by measured margins during fast rallies (ADR-026,
// ADR-028 era logs), so the flat part must not depend on the simulated amount.
export const INSTR_MULT = 1.25;
export const INSTR_PER = 120_000;
export const INSTR_FIXED = 3_000_000;
export const FEE_ONCE = Math.floor((INSTR_FIXED * 7) / 10_000);

export const PER_ADDED =
  WRITE_ENTRY_FEE +
  Math.floor((WRITE_BYTES_PER * 875) / 1024) +
  Math.floor((DISK_READ_PER * 447) / 1024) +
  1_563 +
  120 * 7 +
  100;

function keyB64(k: StellarSdk.xdr.LedgerKey): string {
  return k.toXDR("base64");
}

function writeBytesFor(added: number, addedKeys: StellarSdk.xdr.LedgerKey[], sizes?: ApplyPadSizes): number {
  if (!sizes || sizes.coverBytes === false) return WRITE_BYTES_PER * added;
  const growth = sizes.growth ?? DEFAULT_GROWTH;
  let extra = sizes.slack ?? 0;
  for (const k of addedKeys) {
    const info = sizes.sizeOf(k);
    if (info?.exists) extra += info.actualSize + growth;
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
};

export type ApplyPadSizes = {
  sizeOf(key: StellarSdk.xdr.LedgerKey): PadKeySize | undefined;
  growth?: number;
  slack?: number;
  coverBytes?: boolean;
  latestLedger?: number;
};

export const DEFAULT_GROWTH = 32;

export function applyPad(
  data: StellarSdk.xdr.SorobanTransactionData,
  extraKeys: StellarSdk.xdr.LedgerKey[],
  archivedIndexes: number[] = [],
  sizes?: ApplyPadSizes,
): ApplyPadResult {
  const builder = new StellarSdk.SorobanDataBuilder(data);
  const ro = [...builder.getReadOnly()];
  const rw = [...builder.getReadWrite()];
  const rwSet = new Set(rw.map(keyB64));
  const roMap = new Map(ro.map((k) => [keyB64(k), k]));

  let added = 0;
  let dropped = 0;
  const addedKeys: StellarSdk.xdr.LedgerKey[] = [];
  const nextRo = [...ro];
  const nextRw = [...rw];
  for (const k of extraKeys) {
    const s = keyB64(k);
    if (rwSet.has(s)) continue;
    if (sizes?.sizeOf(k)?.liveness === "archived") {
      dropped += 1;
      continue;
    }
    if (roMap.has(s)) {
      const idx = nextRo.findIndex((x) => keyB64(x) === s);
      if (idx >= 0) nextRo.splice(idx, 1);
      roMap.delete(s);
    }
    nextRw.push(k);
    rwSet.add(s);
    added += 1;
    addedKeys.push(k);
  }

  builder.setReadOnly(nextRo);
  builder.setReadWrite(nextRw);

  const res = data.resources();
  const instructions = Math.floor(Number(res.instructions()) * INSTR_MULT) + INSTR_PER * added + INSTR_FIXED;
  const writeBytes = Number(res.writeBytes()) + writeBytesFor(added, addedKeys, sizes);
  const diskReadBytes = Number(res.diskReadBytes()) + DISK_READ_PER * added;
  builder.setResources(instructions, diskReadBytes, writeBytes);

  const rf0 = BigInt(data.resourceFee().toString());
  const rf = (rf0 * 13n) / 10n + BigInt(PER_ADDED * added) + BigInt(FEE_ONCE);
  builder.setResourceFee(rf.toString());

  let out = builder.build();
  if (archivedIndexes.length) {
    out = new StellarSdk.xdr.SorobanTransactionData({
      ext: new StellarSdk.xdr.SorobanTransactionDataExt(
        1,
        new StellarSdk.xdr.SorobanResourcesExtV0({ archivedSorobanEntries: archivedIndexes }),
      ),
      resources: out.resources(),
      resourceFee: out.resourceFee(),
    });
  }
  return { data: out, added, dropped, resourceFee: BigInt(out.resourceFee().toString()) };
}

export function footprintIndexes(
  data: StellarSdk.xdr.SorobanTransactionData,
  keys: StellarSdk.xdr.LedgerKey[],
): number[] {
  const builder = new StellarSdk.SorobanDataBuilder(data);
  const all = [...builder.getReadWrite(), ...builder.getReadOnly()];
  const want = new Set(keys.map(keyB64));
  const idxs: number[] = [];
  all.forEach((k, i) => {
    if (want.has(keyB64(k))) idxs.push(i);
  });
  return idxs;
}

export function classicFee(resourceFee: bigint): string {
  return (resourceFee + 1000n).toString();
}

export function estimatePaddedFee(addedKeys: number, simResourceFee = 0n): bigint {
  const rf = (simResourceFee * 13n) / 10n + BigInt(PER_ADDED * addedKeys) + BigInt(FEE_ONCE);
  return rf + 1000n;
}
