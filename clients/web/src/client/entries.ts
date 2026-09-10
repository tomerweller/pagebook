import * as StellarSdk from "@stellar/stellar-sdk";
import { type LedgerKeyWrap } from "../keys";
import { entryKeyB64, type RpcLedgerEntry } from "./rpc";

export class RpcShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcShapeError";
  }
}

export function entryData(entry: RpcLedgerEntry): StellarSdk.xdr.LedgerEntryData {
  const key = entryKeyB64(entry) ?? "unknown";
  if (typeof entry.xdr !== "string") {
    throw new RpcShapeError(`malformed ledger entry ${key}: missing xdr`);
  }
  try {
    return StellarSdk.xdr.LedgerEntryData.fromXDR(entry.xdr, "base64");
  } catch {
    throw new RpcShapeError(`malformed ledger entry ${key}: not LedgerEntryData`);
  }
}

export function entryDataSize(entry: RpcLedgerEntry): number {
  return entryData(entry).toXDR().length;
}

export function contractScVal(entry: RpcLedgerEntry): StellarSdk.xdr.ScVal | null {
  const data = entryData(entry);
  try {
    return data.contractData().val();
  } catch {
    return null;
  }
}

function scBytes(scv: StellarSdk.xdr.ScVal | null): Uint8Array | null {
  if (!scv) return null;
  try {
    if (scv.switch().name === "scvBytes") {
      const b = scv.bytes();
      return b instanceof Uint8Array ? b : new Uint8Array(b);
    }
  } catch {
    return null;
  }
  return null;
}

export function indexByKey(entries: RpcLedgerEntry[]): Map<string, RpcLedgerEntry> {
  const map = new Map<string, RpcLedgerEntry>();
  for (const e of entries) {
    const k = entryKeyB64(e);
    if (k) map.set(k, e);
  }
  return map;
}

export function readNative(map: Map<string, RpcLedgerEntry>, keyObj: LedgerKeyWrap): unknown {
  const e = map.get(keyObj.base64);
  if (!e) return null;
  const scv = contractScVal(e);
  if (!scv) return null;
  const bytes = scBytes(scv);
  if (bytes) return { _bytes: bytes };
  try {
    return StellarSdk.scValToNative(scv) as unknown;
  } catch {
    return null;
  }
}
