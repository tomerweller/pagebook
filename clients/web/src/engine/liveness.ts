import * as StellarSdk from "@stellar/stellar-sdk";
import type { Rpc } from "../book";
import { scValKeyName, toLedgerKey, type ClientKey } from "./clientKeys";
import { tokenExtraKeys, type ClassicToken } from "./op";
import { DEFAULT_GROWTH, type ApplyPadSizes, type KeyLiveness, type PadKeySize } from "./txdata";

export const PAD_SWEEP_CHUNK = 100;

export const CREATE_SIZES: Record<string, number> = {
  Level: 300,
  Order: 300,
  TickWord: 400,
  TickSummary: 400,
  BestTick: 200,
  FeeAccrual: 200,
};

function entryDataSize(entry: { xdr?: string; val?: string | StellarSdk.xdr.LedgerEntryData }): number {
  const raw = entry.xdr || (typeof entry.val === "string" ? entry.val : null);
  if (raw) {
    try {
      return StellarSdk.xdr.LedgerEntryData.fromXDR(raw, "base64").toXDR().length;
    } catch {
      try {
        return StellarSdk.xdr.LedgerEntry.fromXDR(raw, "base64").data().toXDR().length;
      } catch {
        return 0;
      }
    }
  }
  if (entry.val && typeof entry.val === "object" && "toXDR" in entry.val) {
    return (entry.val as StellarSdk.xdr.LedgerEntryData).toXDR().length;
  }
  return 0;
}

export function classifyLiveness(liveUntil: number | undefined, latestLedger: number, exists: boolean): KeyLiveness {
  if (!exists) return "nonexistent";
  if (liveUntil != null && liveUntil > 0 && liveUntil < latestLedger) return "archived";
  return "live";
}

function createSizeFor(key: StellarSdk.xdr.LedgerKey): number | undefined {
  try {
    const name = scValKeyName(key.contractData().key()).split("(")[0];
    return CREATE_SIZES[name];
  } catch {
    return undefined;
  }
}

export type SweepClassified = { live: number; nonexistent: number };

function classifyMap(byKey: Map<string, PadKeySize>, latestLedger: number): SweepClassified {
  let live = 0;
  let nonexistent = 0;
  for (const info of byKey.values()) {
    info.liveness = classifyLiveness(info.liveUntil, latestLedger, info.exists);
    if (info.liveness === "nonexistent") nonexistent += 1;
    else if (info.liveness === "live") live += 1;
  }
  return { live, nonexistent };
}

export async function sweepPadSizes(
  rpc: Rpc,
  keys: StellarSdk.xdr.LedgerKey[],
  opts?: {
    growth?: number;
    chunk?: number;
    coverBytes?: boolean;
    stopWhen?: (classified: SweepClassified) => boolean;
  },
): Promise<ApplyPadSizes & { stoppedEarly: boolean }> {
  const growth = opts?.growth ?? DEFAULT_GROWTH;
  const chunk = opts?.chunk ?? PAD_SWEEP_CHUNK;
  const byKey = new Map<string, PadKeySize>();
  let latestLedger = 0;
  let stoppedEarly = false;
  for (let i = 0; i < keys.length; i += chunk) {
    const group = keys.slice(i, i + chunk);
    const res = await rpc.getLedgerEntries(...group);
    latestLedger = res.latestLedger ?? latestLedger;
    const seen = new Set<string>();
    for (const e of res.entries ?? []) {
      const k = typeof e.key === "string" ? e.key : e.key && "toXDR" in e.key ? e.key.toXDR("base64") : null;
      if (!k) continue;
      seen.add(k);
      byKey.set(k, {
        exists: true,
        actualSize: entryDataSize(e) + 8,
        liveUntil: e.liveUntilLedgerSeq,
      });
    }
    for (const key of group) {
      const b64 = key.toXDR("base64");
      if (!seen.has(b64) && !byKey.has(b64)) {
        byKey.set(b64, { exists: false, actualSize: 0, createSize: createSizeFor(key) });
      }
    }
    const classified = classifyMap(byKey, latestLedger);
    if (opts?.stopWhen?.(classified)) {
      stoppedEarly = true;
      break;
    }
  }
  if (!stoppedEarly) classifyMap(byKey, latestLedger);
  return {
    sizeOf(key) {
      return byKey.get(key.toXDR("base64"));
    },
    growth,
    coverBytes: opts?.coverBytes,
    latestLedger,
    stoppedEarly,
  };
}

export function mergeSizes(cached: ApplyPadSizes | undefined, fresh: ApplyPadSizes): ApplyPadSizes {
  if (!cached) return fresh;
  const latestLedger = Math.max(cached.latestLedger ?? 0, fresh.latestLedger ?? 0);
  return {
    sizeOf(key) {
      return cached.sizeOf(key) ?? fresh.sizeOf(key);
    },
    growth: fresh.growth ?? cached.growth,
    slack: fresh.slack ?? cached.slack,
    coverBytes: fresh.coverBytes ?? cached.coverBytes,
    latestLedger: latestLedger || undefined,
  };
}

export function collectUniverseXdr(opts: {
  contract: string;
  caller: string;
  padKeys: ClientKey[];
  tokens: ClassicToken[];
}): StellarSdk.xdr.LedgerKey[] {
  const ctx = { contract: opts.contract, caller: opts.caller };
  const out: StellarSdk.xdr.LedgerKey[] = [];
  const seen = new Set<string>();
  const push = (k: StellarSdk.xdr.LedgerKey) => {
    const s = k.toXDR("base64");
    if (seen.has(s)) return;
    seen.add(s);
    out.push(k);
  };
  for (const k of opts.padKeys) push(toLedgerKey(ctx, k).xdr);
  for (const p of tokenExtraKeys(opts.contract, opts.caller, opts.tokens)) push(p.key);
  return out;
}
