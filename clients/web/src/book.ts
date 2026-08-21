import * as StellarSdk from "@stellar/stellar-sdk";
import { ck, instanceKey, sacBalanceKey, scValU32Base64, type LedgerKeyWrap } from "./keys";
import { decodeLevel, decodeBitmap, wordOf, type Bitmap } from "./decode";

const WORDS_PER_SIDE = 4;
const MAX_KEYS = 200;
const EVENT_LOOKBACK = 2000;
const EVENT_PAGE = 1000;
const MAX_MARKETS_LISTED = 64;

export type BestTick = {
  empty: boolean;
  tick: number;
  stale: boolean;
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
  max_slots_scanned: number;
  inline_slots: number;
  page_slots: number;
  max_pages: number;
};

export type TokenMeta = {
  symbol: string | null;
  decimals: number | null;
  name: string | null;
};

export type LevelRow = {
  tick: number;
  open_lots: bigint;
  queue: number;
  generation: number;
  head_seq: number;
  tail_seq: number;
  head_consumed_lots: bigint;
};

export type BookSnapshot = {
  latestLedger: number;
  mismatched: boolean;
  bestBid: BestTick;
  bestAsk: BestTick;
  bids: LevelRow[];
  asks: LevelRow[];
  market: MarketInfo | null;
  paused: boolean;
  vault: { base: bigint | null; quote: bigint | null };
  fees: { base: bigint; quote: bigint };
  tokens: { base: TokenMeta | null; quote: TokenMeta | null };
  base: string | null;
  quote: string | null;
  moreBids: boolean;
  moreAsks: boolean;
};

export type EventBase = {
  id: string | undefined;
  name: string;
  ledger: number | undefined;
  ledgerClosedAt: string | undefined;
  txHash: string;
};

export type FilledEvent = EventBase & {
  name: "filled";
  is_bid: boolean;
  tick: number;
  lots: bigint;
  quote: bigint;
  taker: "buy" | "sell";
};

export type RestedEvent = EventBase & {
  name: "rested";
  owner: string;
  nonce: bigint;
  is_bid: boolean;
  tick: number;
  generation: number;
  seq: number;
};

export type SettledEvent = EventBase & {
  name: "settled";
  owner: string;
  nonce: bigint;
  filled_lots: bigint;
  refunded_lots: bigint;
};

export type SweptEvent = EventBase & {
  name: "swept";
  is_bid: boolean;
  tick: number;
  generation: number;
};

export type TopChangedEvent = EventBase & {
  name: "top_changed";
  is_bid: boolean;
  old: number;
  newTick: number;
};

export type OtherEvent = EventBase & {
  data: unknown[];
};

export type BookEvent = FilledEvent | RestedEvent | SettledEvent | SweptEvent | TopChangedEvent | OtherEvent;

export type ListedMarket = {
  id: number;
  base: string;
  quote: string;
  market: MarketInfo;
  baseMeta: TokenMeta | null;
  quoteMeta: TokenMeta | null;
  baseSym: string | null;
  quoteSym: string | null;
};

export type WalkOpts = {
  contract: string;
  market?: number;
  depth?: number;
  vault?: string;
  base?: string | null;
  quote?: string | null;
};

export type PollEventsOpts = {
  contract: string;
  market?: number;
  latestLedger: number;
  cursor?: string | null;
  seen?: Set<string>;
  historyFrom?: number | null;
  startLedger?: number;
};

export type RpcLedgerEntry = {
  key?: string | { toXDR: (fmt: string) => string };
  xdr?: string;
  val?: string | StellarSdk.xdr.LedgerEntryData;
  liveUntilLedgerSeq?: number;
};

export type RpcEvent = {
  id?: string;
  topic?: unknown[];
  topics?: unknown[];
  value?: unknown;
  ledger?: number;
  ledgerClosedAt?: string;
  txHash?: string;
  transactionHash?: string;
  pagingToken?: string;
};

export type GetEventsRequest = {
  filters?: unknown[];
  cursor?: string | null;
  limit?: number;
  startLedger?: number;
  endLedger?: number;
};

export type GetEventsResult = {
  events?: RpcEvent[];
  cursor?: string;
  oldestLedger?: number;
};

export type GetLedgerEntriesResult = {
  entries?: RpcLedgerEntry[];
  latestLedger?: number;
};

export type LedgerKeyArg = string | LedgerKeyWrap | StellarSdk.xdr.LedgerKey;

export type GetNetworkResult = {
  passphrase: string;
  friendbotUrl?: string;
  protocolVersion?: string | number;
};

export type SendTransactionResult = {
  status: string;
  hash?: string;
  errorResultXdr?: string;
  errorResult?: unknown;
  message?: string;
};

export type GetTransactionResult = {
  status: string;
  txHash?: string;
  resultXdr?: string;
  resultMetaXdr?: string;
  diagnosticEventsXdr?: string[];
  ledger?: number;
  feeCharged?: number | string;
};

export type SimulateTransactionResult = {
  transactionData?: string;
  minResourceFee?: string | number;
  results?: { xdr?: string }[];
  error?: unknown;
  restorePreamble?: { transactionData?: string; minResourceFee?: string | number };
  latestLedger?: number;
  events?: unknown[];
  stateChanges?: unknown[];
};

export type Rpc = {
  getLatestLedger(): Promise<{ sequence: number }>;
  getLedgerEntries(...keys: LedgerKeyArg[]): Promise<GetLedgerEntriesResult>;
  getEvents(request: GetEventsRequest): Promise<GetEventsResult>;
  getNetwork(): Promise<GetNetworkResult>;
  sendTransaction(transaction: string): Promise<SendTransactionResult>;
  getTransaction(hash: string): Promise<GetTransactionResult>;
  simulateTransaction(transaction: string): Promise<SimulateTransactionResult>;
};

function isKeyWrap(k: LedgerKeyWrap | StellarSdk.xdr.LedgerKey): k is LedgerKeyWrap {
  return "base64" in k && typeof (k as LedgerKeyWrap).base64 === "string";
}

function encodeKey(k: LedgerKeyArg): string {
  if (typeof k === "string") return k;
  if (isKeyWrap(k)) return k.base64;
  return k.toXDR("base64");
}

export class RpcError extends Error {
  code?: number;
  data?: unknown;
  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

type StoragePair = { key: unknown; val: unknown };

function scValToNative(scv: StellarSdk.xdr.ScVal): unknown {
  return StellarSdk.scValToNative(scv) as unknown;
}

export function createRpc(url: string): Rpc {
  let nextId = 1;
  async function call(method: string, params: unknown = null): Promise<unknown> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method,
        params: params ?? null,
      }),
    });
    const body = (await res.json()) as {
      error?: { message?: string; code?: number; data?: unknown };
      result?: unknown;
    };
    if (body.error) {
      throw new RpcError(body.error.message || JSON.stringify(body.error), body.error.code, body.error.data);
    }
    return body.result;
  }
  return {
    getLatestLedger() {
      return call("getLatestLedger") as Promise<{ sequence: number }>;
    },
    getLedgerEntries(...keys) {
      return call("getLedgerEntries", { keys: keys.map(encodeKey) }) as Promise<GetLedgerEntriesResult>;
    },
    getEvents(request) {
      return call("getEvents", {
        filters: request.filters ?? [],
        pagination: {
          ...(request.cursor ? { cursor: request.cursor } : {}),
          ...(request.limit ? { limit: request.limit } : {}),
        },
        ...(request.startLedger ? { startLedger: request.startLedger } : {}),
        ...(request.endLedger ? { endLedger: request.endLedger } : {}),
      }) as Promise<GetEventsResult>;
    },
    getNetwork() {
      return call("getNetwork") as Promise<GetNetworkResult>;
    },
    sendTransaction(transaction) {
      return call("sendTransaction", { transaction }) as Promise<SendTransactionResult>;
    },
    getTransaction(hash) {
      return call("getTransaction", { hash }) as Promise<GetTransactionResult>;
    },
    simulateTransaction(transaction) {
      return call("simulateTransaction", { transaction }) as Promise<SimulateTransactionResult>;
    },
  };
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function fetchEntries(rpc: Rpc, keys: LedgerKeyWrap[]): Promise<{ entries: RpcLedgerEntry[]; latestLedger: number }> {
  if (!keys.length) return { entries: [], latestLedger: 0 };
  const all: RpcLedgerEntry[] = [];
  let latestLedger = 0;
  for (const group of chunk(keys, MAX_KEYS)) {
    const args = group.map((k) => k.xdr);
    const res = await rpc.getLedgerEntries(...args);
    latestLedger = res.latestLedger ?? latestLedger;
    all.push(...(res.entries ?? []));
  }
  return { entries: all, latestLedger };
}

function entryKeyB64(entry: RpcLedgerEntry): string | null {
  if (typeof entry.key === "string") return entry.key;
  if (entry.key && typeof entry.key.toXDR === "function") return entry.key.toXDR("base64");
  return null;
}

function entryData(entry: RpcLedgerEntry): StellarSdk.xdr.LedgerEntryData | null {
  if (entry.val && typeof entry.val === "object" && "switch" in entry.val && typeof entry.val.switch === "function") {
    return entry.val;
  }
  const raw = entry.xdr || (typeof entry.val === "string" ? entry.val : null);
  if (!raw) return null;
  try {
    return StellarSdk.xdr.LedgerEntryData.fromXDR(raw, "base64");
  } catch {
    try {
      return StellarSdk.xdr.LedgerEntry.fromXDR(raw, "base64").data();
    } catch {
      return null;
    }
  }
}

function contractScVal(entry: RpcLedgerEntry): StellarSdk.xdr.ScVal | null {
  const data = entryData(entry);
  if (!data) return null;
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

function indexByKey(entries: RpcLedgerEntry[]): Map<string, RpcLedgerEntry> {
  const map = new Map<string, RpcLedgerEntry>();
  for (const e of entries) {
    const k = entryKeyB64(e);
    if (k) map.set(k, e);
  }
  return map;
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

function parseBest(native: unknown): { empty: boolean; tick: number } {
  if (!native || typeof native !== "object") return { empty: true, tick: 0 };
  const rec = native as Record<string, unknown>;
  return { empty: !!rec.empty, tick: Number(rec.tick ?? 0) };
}

function parseMarket(native: unknown): MarketInfo | null {
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
    max_slots_scanned: Number(rec.max_slots_scanned),
    inline_slots: Number(rec.inline_slots),
    page_slots: Number(rec.page_slots),
    max_pages: Number(rec.max_pages),
  };
}

function parseBalance(native: unknown): bigint | null {
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

function parseFee(native: unknown): bigint {
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

function instanceStorage(entry: RpcLedgerEntry): StoragePair[] {
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

function findStorage(pairs: StoragePair[], name: string): unknown {
  for (const p of pairs) {
    const k = p.key;
    if (k === name) return p.val;
    if (Array.isArray(k) && k[0] === name) return p.val;
  }
  return undefined;
}

function parseTokenMeta(pairs: StoragePair[]): TokenMeta | null {
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

function readNative(map: Map<string, RpcLedgerEntry>, keyObj: LedgerKeyWrap): unknown {
  const e = map.get(keyObj.base64);
  if (!e) return null;
  const scv = contractScVal(e);
  if (!scv) return null;
  const bytes = scBytes(scv);
  if (bytes) return { _bytes: bytes };
  try {
    return scValToNative(scv);
  } catch {
    return null;
  }
}

function listWords(summary: Bitmap | null, bestTick: number, isBid: boolean, k = WORDS_PER_SIDE): number[] {
  const start = wordOf(bestTick);
  const words: number[] = [];
  const seen = new Set<number>();
  const add = (w: number) => {
    if (w < 0 || w >= 2048 || seen.has(w)) return;
    seen.add(w);
    words.push(w);
  };
  add(start);
  if (summary) {
    if (isBid) {
      for (const w of summary.setBits(true)) {
        if (w > start) continue;
        add(w);
        if (words.length >= k) break;
      }
    } else {
      for (const w of summary.setBits(false)) {
        if (w < start) continue;
        add(w);
        if (words.length >= k) break;
      }
    }
  }
  return words.slice(0, k);
}

function unreadSetWords(summary: Bitmap | null, readWords: number[], best: { empty: boolean; tick: number }, isBid: boolean): boolean {
  if (!summary || best.empty) return false;
  const start = wordOf(best.tick);
  const read = new Set(readWords);
  if (isBid) {
    for (const w of summary.setBits(true)) {
      if (w > start) continue;
      if (!read.has(w)) return true;
    }
  } else {
    for (const w of summary.setBits(false)) {
      if (w < start) continue;
      if (!read.has(w)) return true;
    }
  }
  return false;
}

function ticksFromWords(wordMap: Map<number, Bitmap>, bestTick: number, isBid: boolean, limit: number): number[] {
  const ticks: number[] = [];
  const words = [...wordMap.keys()].sort((a, b) => (isBid ? b - a : a - b));
  for (const w of words) {
    if (isBid && w > wordOf(bestTick)) continue;
    if (!isBid && w < wordOf(bestTick)) continue;
    const bm = wordMap.get(w);
    if (!bm) continue;
    const base = w * 2048;
    for (const i of bm.setBits(isBid)) {
      const tick = base + i;
      if (isBid && tick > bestTick) continue;
      if (!isBid && tick < bestTick) continue;
      ticks.push(tick);
      if (ticks.length >= limit) return ticks;
    }
  }
  return ticks;
}

function ensureBest(cands: number[], best: { empty: boolean; tick: number }): number[] {
  if (best.empty) return cands;
  if (!cands.includes(best.tick)) return [best.tick, ...cands];
  return cands;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

async function walkDepthOnce(rpc: Rpc, opts: WalkOpts): Promise<BookSnapshot> {
  const contract = opts.contract;
  const market = Number(opts.market ?? 0);
  const depth = Number(opts.depth ?? 12);
  const vault = opts.vault || contract;

  const kBestBid = ck(contract, "BestTick", market, true);
  const kBestAsk = ck(contract, "BestTick", market, false);
  const kSumBid = ck(contract, "TickSummary", market, true);
  const kSumAsk = ck(contract, "TickSummary", market, false);
  const kMarket = ck(contract, "Market", market);
  const kInst = instanceKey(contract);

  const batch1: LedgerKeyWrap[] = [kBestBid, kBestAsk, kSumBid, kSumAsk, kMarket, kInst];
  let extraKnown: LedgerKeyWrap[] = [];
  if (opts.base && opts.quote) {
    extraKnown = [
      sacBalanceKey(opts.base, vault),
      sacBalanceKey(opts.quote, vault),
      ck(contract, "FeeAccrual", market, opts.base),
      ck(contract, "FeeAccrual", market, opts.quote),
      instanceKey(opts.base),
      instanceKey(opts.quote),
    ];
    batch1.push(...extraKnown);
  }

  const r1 = await fetchEntries(rpc, batch1);
  const map = indexByKey(r1.entries);

  const bestBid = parseBest(readNative(map, kBestBid));
  const bestAsk = parseBest(readNative(map, kBestAsk));
  const sumBidRaw = readNative(map, kSumBid) as { _bytes?: Uint8Array } | null;
  const sumAskRaw = readNative(map, kSumAsk) as { _bytes?: Uint8Array } | null;
  const summaryBid = sumBidRaw?._bytes ? decodeBitmap(sumBidRaw._bytes) : null;
  const summaryAsk = sumAskRaw?._bytes ? decodeBitmap(sumAskRaw._bytes) : null;
  const marketInfo = parseMarket(readNative(map, kMarket));

  const instEntry = map.get(kInst.base64);
  const instPairs = instEntry ? instanceStorage(instEntry) : [];
  const config = findStorage(instPairs, "Config") || {};
  const paused = !!(asRecord(config)?.paused);

  const base = marketInfo?.base || opts.base || null;
  const quote = marketInfo?.quote || opts.quote || null;

  const wordsBid = bestBid.empty ? [] : listWords(summaryBid, bestBid.tick, true);
  const wordsAsk = bestAsk.empty ? [] : listWords(summaryAsk, bestAsk.tick, false);
  const wordKeys: LedgerKeyWrap[] = [];
  const wordMeta: { side: "bid" | "ask"; word: number }[] = [];
  for (const w of wordsBid) {
    wordKeys.push(ck(contract, "TickWord", market, true, w));
    wordMeta.push({ side: "bid", word: w });
  }
  for (const w of wordsAsk) {
    wordKeys.push(ck(contract, "TickWord", market, false, w));
    wordMeta.push({ side: "ask", word: w });
  }

  const tokenKeys: LedgerKeyWrap[] = [];
  if (base && quote && extraKnown.length === 0) {
    tokenKeys.push(
      sacBalanceKey(base, vault),
      sacBalanceKey(quote, vault),
      ck(contract, "FeeAccrual", market, base),
      ck(contract, "FeeAccrual", market, quote),
      instanceKey(base),
      instanceKey(quote),
    );
  }

  const r2 = await fetchEntries(rpc, [...wordKeys, ...tokenKeys]);
  for (const e of r2.entries) {
    const k = entryKeyB64(e);
    if (k) map.set(k, e);
  }

  const wordMapBid = new Map<number, Bitmap>();
  const wordMapAsk = new Map<number, Bitmap>();
  for (let i = 0; i < wordKeys.length; i++) {
    const raw = readNative(map, wordKeys[i]) as { _bytes?: Uint8Array } | null;
    const bm = raw?._bytes ? decodeBitmap(raw._bytes) : null;
    if (!bm) continue;
    if (wordMeta[i].side === "bid") wordMapBid.set(wordMeta[i].word, bm);
    else wordMapAsk.set(wordMeta[i].word, bm);
  }

  // Candidates are bitmap bits, and a re-quoting maker leaves trails of
  // stale-set bits (emptied levels) right next to the best; with too few
  // candidates the phantoms crowd out the live levels and a side renders
  // empty. Bits are cheap to check (one batched entry fetch), so over-fetch.
  const candLimit = Math.max(6 * depth, depth + 64);
  const candBid = ensureBest(
    bestBid.empty ? [] : ticksFromWords(wordMapBid, bestBid.tick, true, candLimit),
    bestBid,
  );
  const candAsk = ensureBest(
    bestAsk.empty ? [] : ticksFromWords(wordMapAsk, bestAsk.tick, false, candLimit),
    bestAsk,
  );

  const levelKeys: LedgerKeyWrap[] = [];
  for (const t of candBid) levelKeys.push(ck(contract, "Level", market, true, t));
  for (const t of candAsk) levelKeys.push(ck(contract, "Level", market, false, t));

  const r3 = await fetchEntries(rpc, levelKeys);
  const map3 = indexByKey(r3.entries);

  function readLvl(keyObj: LedgerKeyWrap) {
    const e = map3.get(keyObj.base64);
    if (!e) return null;
    const scv = contractScVal(e);
    const bytes = scBytes(scv);
    return bytes ? decodeLevel(bytes) : null;
  }

  function collect(cands: number[], keyOffset: number, best: { empty: boolean; tick: number }) {
    const rows: LevelRow[] = [];
    let staleBest = false;
    if (!best.empty) {
      const bestLvl = readLvl(levelKeys[keyOffset + cands.indexOf(best.tick)]);
      if (!bestLvl || bestLvl.open_lots === 0n) staleBest = true;
    }
    for (let i = 0; i < cands.length && rows.length < depth; i++) {
      const lvl = readLvl(levelKeys[keyOffset + i]);
      if (!lvl || lvl.open_lots === 0n) continue;
      rows.push({
        tick: cands[i],
        open_lots: lvl.open_lots,
        queue: lvl.tail_seq - lvl.head_seq,
        generation: lvl.generation,
        head_seq: lvl.head_seq,
        tail_seq: lvl.tail_seq,
        head_consumed_lots: lvl.head_consumed_lots,
      });
    }
    return { rows, staleBest };
  }

  const bids = collect(candBid, 0, bestBid);
  const asks = collect(candAsk, candBid.length, bestAsk);

  let vaultBase: bigint | null = null;
  let vaultQuote: bigint | null = null;
  let feeBase = 0n;
  let feeQuote = 0n;
  let baseMeta: TokenMeta | null = null;
  let quoteMeta: TokenMeta | null = null;
  if (base && quote) {
    const nativeOf = (ko: LedgerKeyWrap) => {
      const e = map.get(ko.base64);
      if (!e) return null;
      const scv = contractScVal(e);
      if (!scv) return null;
      try {
        return scValToNative(scv);
      } catch {
        return null;
      }
    };
    vaultBase = parseBalance(nativeOf(sacBalanceKey(base, vault)));
    vaultQuote = parseBalance(nativeOf(sacBalanceKey(quote, vault)));
    feeBase = parseFee(nativeOf(ck(contract, "FeeAccrual", market, base)));
    feeQuote = parseFee(nativeOf(ck(contract, "FeeAccrual", market, quote)));
    const be = map.get(instanceKey(base).base64);
    const qe = map.get(instanceKey(quote).base64);
    if (be) baseMeta = parseTokenMeta(instanceStorage(be));
    if (qe) quoteMeta = parseTokenMeta(instanceStorage(qe));
  }

  const ledgers = [r1.latestLedger, r2.latestLedger, r3.latestLedger].filter(Boolean);
  const latestLedger = ledgers.length ? Math.max(...ledgers) : 0;
  const mismatched = new Set(ledgers).size > 1;

  return {
    latestLedger,
    mismatched,
    bestBid: { ...bestBid, stale: bids.staleBest },
    bestAsk: { ...bestAsk, stale: asks.staleBest },
    bids: bids.rows,
    asks: asks.rows,
    market: marketInfo,
    paused,
    vault: { base: vaultBase, quote: vaultQuote },
    fees: { base: feeBase, quote: feeQuote },
    tokens: { base: baseMeta, quote: quoteMeta },
    base,
    quote,
    moreBids: bids.rows.length < depth && unreadSetWords(summaryBid, wordsBid, bestBid, true),
    moreAsks: asks.rows.length < depth && unreadSetWords(summaryAsk, wordsAsk, bestAsk, false),
  };
}

export async function walkDepth(rpc: Rpc, opts: WalkOpts): Promise<BookSnapshot> {
  const first = await walkDepthOnce(rpc, opts);
  if (!first.mismatched) return first;
  return walkDepthOnce(rpc, { ...opts, base: first.base, quote: first.quote });
}

export async function listMarkets(rpc: Rpc, opts: { contract: string }): Promise<{ markets: ListedMarket[]; latestLedger: number }> {
  const contract = opts.contract;
  const kInst = instanceKey(contract);
  const r1 = await fetchEntries(rpc, [kInst]);
  const instEntry = r1.entries[0];
  const config = instEntry ? findStorage(instanceStorage(instEntry), "Config") : null;
  const count = Math.min(Number(asRecord(config)?.market_counter ?? 0), MAX_MARKETS_LISTED);
  if (!count) return { markets: [], latestLedger: r1.latestLedger };

  const marketKeys: LedgerKeyWrap[] = [];
  for (let i = 0; i < count; i++) marketKeys.push(ck(contract, "Market", i));
  const r2 = await fetchEntries(rpc, marketKeys);
  const map2 = indexByKey(r2.entries);
  const markets: ListedMarket[] = [];
  for (let i = 0; i < count; i++) {
    const m = parseMarket(readNative(map2, marketKeys[i]));
    if (m) {
      markets.push({
        id: i,
        base: m.base,
        quote: m.quote,
        market: m,
        baseMeta: null,
        quoteMeta: null,
        baseSym: null,
        quoteSym: null,
      });
    }
  }

  const sacs = [...new Set(markets.flatMap((m) => [m.base, m.quote]))];
  const sacKeys = sacs.map((s) => instanceKey(s));
  const r3 = await fetchEntries(rpc, sacKeys);
  const map3 = indexByKey(r3.entries);
  const metaOf = new Map<string, TokenMeta | null>();
  sacs.forEach((s, i) => {
    const e = map3.get(sacKeys[i].base64);
    metaOf.set(s, e ? parseTokenMeta(instanceStorage(e)) : null);
  });
  for (const m of markets) {
    m.baseMeta = metaOf.get(m.base) || null;
    m.quoteMeta = metaOf.get(m.quote) || null;
    m.baseSym = m.baseMeta?.symbol || null;
    m.quoteSym = m.quoteMeta?.symbol || null;
  }
  return { markets, latestLedger: r3.latestLedger || r2.latestLedger };
}

function eventCursor(res: GetEventsResult, fallback: string | null): string | null {
  if (res.cursor) return res.cursor;
  const evs = res.events ?? [];
  if (evs.length) {
    const last = evs[evs.length - 1];
    return last.pagingToken || last.id || fallback;
  }
  return fallback;
}

function parseEvent(ev: RpcEvent): BookEvent | null {
  let topics: unknown[] = ev.topic ?? ev.topics ?? [];
  let value: unknown = ev.value;
  try {
    if (topics.length && typeof topics[0] === "string") {
      topics = topics.map((t) => StellarSdk.xdr.ScVal.fromXDR(t as string, "base64"));
    }
    if (typeof value === "string") {
      value = StellarSdk.xdr.ScVal.fromXDR(value, "base64");
    }
  } catch {
    return null;
  }
  let name: string;
  try {
    name = String(scValToNative(topics[0] as StellarSdk.xdr.ScVal));
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = scValToNative(value as StellarSdk.xdr.ScVal);
  } catch {
    data = null;
  }
  const arr = Array.isArray(data) ? data : [];
  const txHash = ev.txHash || ev.transactionHash || "";
  const base: EventBase = {
    id: ev.id,
    name,
    ledger: ev.ledger,
    ledgerClosedAt: ev.ledgerClosedAt,
    txHash,
  };
  switch (name) {
    case "filled":
      return {
        ...base,
        name: "filled",
        is_bid: !!arr[0],
        tick: Number(arr[1]),
        lots: asBig(arr[2]),
        quote: asBig(arr[3]),
        taker: arr[0] ? "sell" : "buy",
      };
    case "rested":
      return {
        ...base,
        name: "rested",
        owner: String(arr[0] ?? ""),
        nonce: asBig(arr[1]),
        is_bid: !!arr[2],
        tick: Number(arr[3]),
        generation: Number(arr[4]),
        seq: Number(arr[5]),
      };
    case "settled":
      return {
        ...base,
        name: "settled",
        owner: String(arr[0] ?? ""),
        nonce: asBig(arr[1]),
        filled_lots: asBig(arr[2]),
        refunded_lots: asBig(arr[3]),
      };
    case "swept":
      return {
        ...base,
        name: "swept",
        is_bid: !!arr[0],
        tick: Number(arr[1]),
        generation: Number(arr[2]),
      };
    case "top_changed":
      return {
        ...base,
        name: "top_changed",
        is_bid: !!arr[0],
        old: Number(arr[1]),
        newTick: Number(arr[2]),
      };
    default:
      return { ...base, data: arr };
  }
}

function parseStartHint(err: unknown, start: number, latest: number): number {
  const msg = String(err instanceof Error ? err.message : err);
  const nums = [...msg.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n > 0 && n < latest);
  if (/old|retention|between|range|closer|minimum|oldest/i.test(msg) && nums.length) {
    return Math.max(nums[0], start + 1);
  }
  const mid = start + Math.max(1, Math.floor((latest - start) / 2));
  return mid >= latest ? Math.max(1, latest - 1) : mid;
}

export async function pollEvents(
  rpc: Rpc,
  opts: PollEventsOpts,
): Promise<{ events: BookEvent[]; cursor: string | null; historyFrom: number | null | undefined; seen: Set<string>; oldestLedger: number | null }> {
  const contract = opts.contract;
  const market = Number(opts.market ?? 0);
  const latest = Number(opts.latestLedger);
  const seen = opts.seen instanceof Set ? opts.seen : new Set<string>();
  let cursor = opts.cursor || null;
  let historyFrom = opts.historyFrom;
  const marketTopic = scValU32Base64(market);
  const filters = [
    {
      type: "contract",
      contractIds: [contract],
      topics: [["*", marketTopic]],
    },
  ];

  const events: BookEvent[] = [];
  let oldestLedger: number | null = null;

  const take = (res: GetEventsResult) => {
    for (const ev of res.events ?? []) {
      const id = ev.id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      const parsed = parseEvent(ev);
      if (parsed) events.push(parsed);
    }
    if (res.oldestLedger != null) oldestLedger = res.oldestLedger;
    cursor = eventCursor(res, cursor);
  };

  if (!cursor) {
    let start = opts.startLedger ?? Math.max(1, latest - EVENT_LOOKBACK);
    let res: GetEventsResult | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        res = await rpc.getEvents({ startLedger: start, filters, limit: EVENT_PAGE });
        historyFrom = start;
        break;
      } catch (e) {
        const next = parseStartHint(e, start, latest);
        if (next === start) throw e;
        start = next;
      }
    }
    if (!res) return { events: [], cursor: null, historyFrom, seen, oldestLedger };
    take(res);
    while ((res.events ?? []).length >= EVENT_PAGE && cursor) {
      res = await rpc.getEvents({ cursor, filters, limit: EVENT_PAGE });
      take(res);
    }
  } else {
    let res = await rpc.getEvents({ cursor, filters, limit: EVENT_PAGE });
    take(res);
    while ((res.events ?? []).length >= EVENT_PAGE && cursor) {
      res = await rpc.getEvents({ cursor, filters, limit: EVENT_PAGE });
      take(res);
    }
  }

  return { events, cursor, historyFrom, seen, oldestLedger };
}

export type MockSnapshot = BookSnapshot & {
  events: BookEvent[];
  historyFrom: number;
};

export function mockSnapshot(): MockSnapshot {
  return {
    latestLedger: 4215102,
    mismatched: false,
    bestBid: { empty: false, tick: 99, stale: false },
    bestAsk: { empty: false, tick: 101, stale: false },
    bids: [
      {
        tick: 99,
        open_lots: 40n,
        queue: 3,
        generation: 4,
        head_seq: 0,
        tail_seq: 3,
        head_consumed_lots: 0n,
      },
      {
        tick: 98,
        open_lots: 25n,
        queue: 1,
        generation: 2,
        head_seq: 0,
        tail_seq: 1,
        head_consumed_lots: 0n,
      },
      {
        tick: 97,
        open_lots: 10n,
        queue: 2,
        generation: 1,
        head_seq: 1,
        tail_seq: 3,
        head_consumed_lots: 0n,
      },
    ],
    asks: [
      {
        tick: 101,
        open_lots: 12n,
        queue: 1,
        generation: 3,
        head_seq: 0,
        tail_seq: 1,
        head_consumed_lots: 0n,
      },
      {
        tick: 102,
        open_lots: 30n,
        queue: 2,
        generation: 1,
        head_seq: 0,
        tail_seq: 2,
        head_consumed_lots: 0n,
      },
      {
        tick: 104,
        open_lots: 8n,
        queue: 1,
        generation: 1,
        head_seq: 0,
        tail_seq: 1,
        head_consumed_lots: 0n,
      },
    ],
    market: {
      base: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4",
      quote: "CBEC6J5RWWWC7CYCHJTXIBDFTFRK6GTMLK4E47BECO5BDXVM7YHATUIK",
      lot_size: 1n,
      tick_size: 1n,
      tick_min: 1,
      tick_max: 65536,
      taker_fee_bps: 10,
      min_order_lots: 1n,
      max_order_lots: 1000000n,
      max_levels_crossed: 32,
      max_slots_scanned: 64,
      inline_slots: 32,
      page_slots: 32,
      max_pages: 1,
    },
    paused: false,
    vault: { base: 12340000000n, quote: 567890000000n },
    fees: { base: 70000000n, quote: 0n },
    tokens: {
      base: { symbol: "PBA", decimals: 7, name: "PageBook A" },
      quote: { symbol: "PBB", decimals: 7, name: "PageBook B" },
    },
    base: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4",
    quote: "CBEC6J5RWWWC7CYCHJTXIBDFTFRK6GTMLK4E47BECO5BDXVM7YHATUIK",
    events: [
      {
        id: "mock-filled-1",
        name: "filled",
        ledger: 4215102,
        ledgerClosedAt: "2026-08-18T12:04:31Z",
        txHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        is_bid: false,
        tick: 100,
        lots: 3n,
        quote: 300n,
        taker: "buy",
      },
      {
        id: "mock-rested-1",
        name: "rested",
        ledger: 4215102,
        ledgerClosedAt: "2026-08-18T12:04:31Z",
        txHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        owner: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        nonce: 17n,
        is_bid: true,
        tick: 99,
        generation: 4,
        seq: 2,
      },
      {
        id: "mock-filled-2",
        name: "filled",
        ledger: 4215098,
        ledgerClosedAt: "2026-08-18T12:04:26Z",
        txHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        is_bid: true,
        tick: 99,
        lots: 5n,
        quote: 495n,
        taker: "sell",
      },
      {
        id: "mock-top-1",
        name: "top_changed",
        ledger: 4215098,
        ledgerClosedAt: "2026-08-18T12:04:26Z",
        txHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        is_bid: false,
        old: 101,
        newTick: 102,
      },
      {
        id: "mock-settled-1",
        name: "settled",
        ledger: 4215090,
        ledgerClosedAt: "2026-08-18T12:04:10Z",
        txHash: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        owner: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        nonce: 4n,
        filled_lots: 5n,
        refunded_lots: 0n,
      },
      {
        id: "mock-swept-1",
        name: "swept",
        ledger: 4215088,
        ledgerClosedAt: "2026-08-18T12:04:05Z",
        txHash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        is_bid: false,
        tick: 100,
        generation: 2,
      },
    ],
    historyFrom: 4213102,
    moreBids: false,
    moreAsks: false,
  };
}
