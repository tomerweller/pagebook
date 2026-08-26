import * as StellarSdk from "@stellar/stellar-sdk";
import type { Rpc } from "../../src/book";
import { addrToHex, toLedgerKey, type ClientKey, type Hex32 } from "../../src/engine/clientKeys";
import { tokenExtraKeys, type ClassicToken } from "../../src/engine/submit";
import { DEFAULT_GROWTH, type ApplyPadSizes, type KeyLiveness, type PadKeySize } from "../../src/engine/txdata";
import { wordOf } from "../../src/decode";

export const PAD_SWEEP_CHUNK = 100;

export function restKeys(market: number, isBid: boolean, tick: number): ClientKey[] {
  return [
    { t: "Level", market, isBid, tick },
    { t: "TickWord", market, isBid, word: wordOf(tick) },
    { t: "TickSummary", market, isBid },
    { t: "BestTick", market, isBid },
    { t: "BestTick", market, isBid: !isBid },
    { t: "LevelPage", market, isBid, tick, page: 0 },
    { t: "LevelPage", market, isBid, tick, page: 1 },
  ];
}

export function feeKeys(market: number, base: Hex32, quote: Hex32): ClientKey[] {
  return [
    { t: "FeeAccrual", market, token: base },
    { t: "FeeAccrual", market, token: quote },
  ];
}

export function settlePageKeys(market: number, isBid: boolean, tick: number): ClientKey[] {
  return [
    { t: "LevelPage", market, isBid, tick, page: 0 },
    { t: "LevelPage", market, isBid, tick, page: 1 },
  ];
}

export function orderClientKey(market: number, owner: Hex32, nonce: bigint): ClientKey {
  return { t: "Order", market, owner, nonce };
}

export function classicPairTokens(baseSac: string, quoteSac: string, issuer: string, codes: string): ClassicToken[] {
  const [baseCode, quoteCode] = codes.split(",");
  return classicTokens({
    baseSac,
    quoteSac,
    usdcCode: quoteCode ?? "",
    usdcIssuer: issuer,
    baseCode: baseCode ?? "",
    baseIssuer: issuer,
  });
}

export function classicTokens(opts: {
  baseSac: string;
  quoteSac: string;
  usdcCode: string;
  usdcIssuer: string;
  baseCode?: string;
  baseIssuer?: string;
}): ClassicToken[] {
  // Base defaults to native XLM (caller's balance entry is the account itself);
  // a classic base (a test-asset market) passes its trustline coordinates.
  const base: ClassicToken =
    opts.baseCode && opts.baseIssuer
      ? { sac: opts.baseSac, code: opts.baseCode, issuer: opts.baseIssuer }
      : { sac: opts.baseSac };
  return [base, { sac: opts.quoteSac, code: opts.usdcCode, issuer: opts.usdcIssuer }];
}

export function tokenXdrKeys(pagebook: string, caller: string, tokens: ClassicToken[]): StellarSdk.xdr.LedgerKey[] {
  return tokenExtraKeys(pagebook, caller, tokens);
}

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

export async function sweepPadSizes(
  rpc: Rpc,
  keys: StellarSdk.xdr.LedgerKey[],
  opts?: { growth?: number; chunk?: number; coverBytes?: boolean },
): Promise<ApplyPadSizes> {
  const growth = opts?.growth ?? DEFAULT_GROWTH;
  const chunk = opts?.chunk ?? PAD_SWEEP_CHUNK;
  const byKey = new Map<string, PadKeySize>();
  let latestLedger = 0;
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
        byKey.set(b64, { exists: false, actualSize: 0 });
      }
    }
  }
  for (const info of byKey.values()) {
    info.liveness = classifyLiveness(info.liveUntil, latestLedger, info.exists);
  }
  return {
    sizeOf(key) {
      return byKey.get(key.toXDR("base64"));
    },
    growth,
    coverBytes: opts?.coverBytes,
    latestLedger,
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
  for (const k of tokenXdrKeys(opts.contract, opts.caller, opts.tokens)) push(k);
  return out;
}

export function tokenHex(baseSac: string, quoteSac: string): { base: Hex32; quote: Hex32 } {
  return { base: addrToHex(baseSac), quote: addrToHex(quoteSac) };
}
