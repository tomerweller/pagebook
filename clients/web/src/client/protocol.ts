import * as StellarSdk from "@stellar/stellar-sdk";
import { ck } from "../keys";
import { contractScVal, indexByKey, readNative } from "./entries";
import { fetchEntries, type Rpc, type RpcLedgerEntry } from "./rpc";

export type BestTick = {
  empty: boolean;
  tick: number;
};

export type MarketInfo = {
  base: string;
  quote: string;
  lot_size: bigint;
  tick_size: bigint;
  tick_min: number;
  tick_max: number;
  taker_fee_bps: number;
  min_order_lots: bigint;
  max_order_lots: bigint;
  max_levels_crossed: number;
  level_cap: number;
};

export type TokenMeta = {
  symbol: string | null;
  decimals: number | null;
  name: string | null;
};

type StoragePair = { key: unknown; val: unknown };

function scValToNative(scv: StellarSdk.xdr.ScVal): unknown {
  return StellarSdk.scValToNative(scv) as unknown;
}

function asBig(n: unknown): bigint {
  if (typeof n === "bigint") return n;
  if (n == null) return 0n;
  return BigInt(n as string | number | bigint | boolean);
}

function pick(obj: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    if (obj[n] !== undefined) return obj[n];
  }
  return undefined;
}

export function parseBest(native: unknown): { empty: boolean; tick: number } {
  if (!native || typeof native !== "object") return { empty: true, tick: 0 };
  const rec = native as Record<string, unknown>;
  return { empty: !!rec.empty, tick: Number(rec.tick ?? 0) };
}

export function parseMarket(native: unknown): MarketInfo | null {
  if (!native || typeof native !== "object") return null;
  const rec = native as Record<string, unknown>;
  return {
    base: String(rec.base),
    quote: String(rec.quote),
    lot_size: asBig(rec.lot_size),
    tick_size: asBig(rec.tick_size),
    tick_min: Number(rec.tick_min),
    tick_max: Number(rec.tick_max),
    taker_fee_bps: Number(rec.taker_fee_bps),
    min_order_lots: asBig(rec.min_order_lots),
    max_order_lots: asBig(rec.max_order_lots),
    max_levels_crossed: Number(rec.max_levels_crossed),
    level_cap: Number(rec.level_cap),
  };
}

export function parseBalance(native: unknown): bigint | null {
  if (native == null) return null;
  if (typeof native === "bigint" || typeof native === "number" || typeof native === "string") {
    return asBig(native);
  }
  if (typeof native === "object") {
    const amt = pick(native as Record<string, unknown>, "amount", "Amount");
    if (amt != null) return asBig(amt);
  }
  return null;
}

export function parseFee(native: unknown): bigint {
  if (native == null) return 0n;
  if (typeof native === "object" && native !== null && "accrued" in native) {
    return asBig((native as { accrued: unknown }).accrued);
  }
  try {
    return asBig(native);
  } catch {
    return 0n;
  }
}

export function instanceStorage(entry: RpcLedgerEntry): StoragePair[] {
  const scv = contractScVal(entry);
  if (!scv) return [];
  try {
    const inst = scv.instance();
    const storage = inst.storage();
    if (!storage) return [];
    return [...storage].map((pair) => ({
      key: scValToNative(pair.key()),
      val: scValToNative(pair.val()),
    }));
  } catch {
    return [];
  }
}

export function findStorage(pairs: StoragePair[], name: string): unknown {
  for (const p of pairs) {
    const k = p.key;
    if (k === name) return p.val;
    if (Array.isArray(k) && k[0] === name) return p.val;
  }
  return undefined;
}

export function parseTokenMeta(pairs: StoragePair[]): TokenMeta | null {
  const meta = findStorage(pairs, "METADATA") ?? findStorage(pairs, "Metadata");
  if (!meta || typeof meta !== "object") return null;
  const rec = meta as Record<string, unknown>;
  const symbol = pick(rec, "symbol", "Symbol");
  const decimals = pick(rec, "decimal", "decimals", "Decimal", "Decimals");
  const tokenName = pick(rec, "name", "Name");
  if (symbol == null && decimals == null) return null;
  return {
    symbol: symbol != null ? displaySymbol(String(symbol)) : null,
    decimals: decimals != null ? Number(decimals) : null,
    name: tokenName != null ? String(tokenName) : null,
  };
}

export function displaySymbol(symbol: string): string {
  return symbol === "native" ? "XLM" : symbol;
}

/** The market's `level_cap`, read from its `Market` entry; undefined when the
 *  entry is unreadable. Callers pass it to the submit layer so the flat
 *  write-byte cover tracks a raised cap (ADR-037). */
export async function fetchLevelCap(rpc: Rpc, contract: string, market: number): Promise<number | undefined> {
  try {
    const k = ck(contract, "Market", market);
    const res = await fetchEntries(rpc, [k]);
    const m = parseMarket(readNative(indexByKey(res.entries), k));
    return m?.level_cap;
  } catch {
    return undefined;
  }
}
