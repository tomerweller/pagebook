import * as StellarSdk from "@stellar/stellar-sdk";
import { contractScVal, indexByKey, readNative } from "./client/entries";
import {
  findStorage,
  instanceStorage,
  parseBalance,
  parseBest,
  parseFee,
  parseMarket,
  parseTokenMeta,
  type BestTick,
  type MarketInfo,
  type TokenMeta,
} from "./client/protocol";
import {
  entryKeyB64,
  fetchEntries,
  type GetEventsResult,
  type Rpc,
  type RpcEvent,
  type RpcLedgerEntry,
} from "./client/rpc";
import { parseLevel, decodeBitmap, wordOf, type Bitmap } from "./decode";
import { ck, instanceKey, sacBalanceKey, scValU32Base64, type LedgerKeyWrap } from "./keys";

const WORDS_PER_SIDE = 4;
const EVENT_LOOKBACK = 2000;
const EVENT_PAGE = 1000;
const MAX_MARKETS_LISTED = 64;

// A re-quoting maker leaves a long trail of stale-set bits behind it: bits
// stay set on levels that emptied, and only a sweep clears them. Measured on
// testnet, one word carried 569 set bits above the best ask with a single live
// level among them, at candidate 137. So candidates are read in rounds and the
// scan stops as soon as a side has `depth` live levels: one round covers a
// healthy book, and a phantom trail costs extra rounds instead of hiding the
// levels behind it (ADR-046).
const LEVEL_SCAN_CHUNK = 96;
const LEVEL_SCAN_ROUNDS = 5;

export type LevelRow = {
  tick: number;
  open_lots: bigint;
  queue: number;
  generation: number;
  head_seq: number;
  depth: number;
};

export type BookSnapshot = {
  latestLedger: number;
  mismatched: boolean;
  bestBid: BestTick & { stale: boolean };
  bestAsk: BestTick & { stale: boolean };
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

function scValToNative(scv: StellarSdk.xdr.ScVal): unknown {
  return StellarSdk.scValToNative(scv) as unknown;
}

function asBig(n: unknown): bigint {
  if (typeof n === "bigint") return n;
  if (n == null) return 0n;
  return BigInt(n as string | number | bigint | boolean);
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

type SideScan = {
  isBid: boolean;
  cands: number[];
  best: { empty: boolean; tick: number };
};

export type SideRows = {
  rows: LevelRow[];
  staleBest: boolean;
  // Candidates whose Level entry was read. A side that stopped short of its
  // own candidate list has levels the window never looked at.
  scanned: number;
};

function readLevelEntry(map: Map<string, RpcLedgerEntry>, keyObj: LedgerKeyWrap) {
  const e = map.get(keyObj.base64);
  if (!e) return null;
  const scv = contractScVal(e);
  if (!scv) return null;
  try {
    return parseLevel(scValToNative(scv));
  } catch {
    return null;
  }
}

export async function scanLevels(
  rpc: Rpc,
  opts: { contract: string; market: number; depth: number; sides: SideScan[] },
): Promise<{ sides: SideRows[]; latestLedger: number; ledgers: number[] }> {
  const out: SideRows[] = opts.sides.map(() => ({ rows: [], staleBest: false, scanned: 0 }));
  const ledgers: number[] = [];
  for (let round = 0; round < LEVEL_SCAN_ROUNDS; round++) {
    const keys: LedgerKeyWrap[] = [];
    const plan: { at: number; tick: number; key: LedgerKeyWrap }[] = [];
    opts.sides.forEach((side, at) => {
      if (out[at].rows.length >= opts.depth) return;
      const from = out[at].scanned;
      const to = Math.min(side.cands.length, from + LEVEL_SCAN_CHUNK);
      for (let c = from; c < to; c++) {
        const key = ck(opts.contract, "Level", opts.market, side.isBid, side.cands[c]);
        keys.push(key);
        plan.push({ at, tick: side.cands[c], key });
      }
      out[at].scanned = to;
    });
    if (!keys.length) break;
    const res = await fetchEntries(rpc, keys);
    if (res.latestLedger) ledgers.push(res.latestLedger);
    const map = indexByKey(res.entries);
    for (const p of plan) {
      const side = opts.sides[p.at];
      const dst = out[p.at];
      const lvl = readLevelEntry(map, p.key);
      const empty = !lvl || lvl.open_lots === 0n;
      if (!side.best.empty && p.tick === side.best.tick && empty) dst.staleBest = true;
      if (empty || !lvl || dst.rows.length >= opts.depth) continue;
      dst.rows.push({
        tick: p.tick,
        open_lots: lvl.open_lots,
        queue: lvl.slots.length - lvl.head_seq,
        generation: lvl.generation,
        head_seq: lvl.head_seq,
        depth: lvl.slots.length,
      });
    }
  }
  return { sides: out, latestLedger: ledgers.length ? Math.max(...ledgers) : 0, ledgers };
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

  const candLimit = LEVEL_SCAN_CHUNK * LEVEL_SCAN_ROUNDS;
  const candBid = ensureBest(
    bestBid.empty ? [] : ticksFromWords(wordMapBid, bestBid.tick, true, candLimit),
    bestBid,
  );
  const candAsk = ensureBest(
    bestAsk.empty ? [] : ticksFromWords(wordMapAsk, bestAsk.tick, false, candLimit),
    bestAsk,
  );

  const scan = await scanLevels(rpc, {
    contract,
    market,
    depth,
    sides: [
      { isBid: true, cands: candBid, best: bestBid },
      { isBid: false, cands: candAsk, best: bestAsk },
    ],
  });
  const [bids, asks] = scan.sides;

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

  const ledgers = [r1.latestLedger, r2.latestLedger, ...scan.ledgers].filter(Boolean);
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
    moreBids:
      bids.rows.length < depth &&
      (bids.scanned < candBid.length || unreadSetWords(summaryBid, wordsBid, bestBid, true)),
    moreAsks:
      asks.rows.length < depth &&
      (asks.scanned < candAsk.length || unreadSetWords(summaryAsk, wordsAsk, bestAsk, false)),
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
