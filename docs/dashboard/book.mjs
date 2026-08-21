import {
  ck,
  instanceKey,
  sacBalanceKey,
  scValU32Base64,
  resolveSdk,
  setSdk,
} from "./keys.mjs";
import { decodeLevel, decodeBitmap, wordOf } from "./decode.mjs";

export { setSdk, resolveSdk };

const WORDS_PER_SIDE = 4;
const MAX_KEYS = 200;
const EVENT_LOOKBACK = 2000;
const EVENT_PAGE = 1000;

export function createRpc(url) {
  let nextId = 1;
  async function call(method, params) {
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
    const body = await res.json();
    if (body.error) {
      const err = new Error(body.error.message || JSON.stringify(body.error));
      err.code = body.error.code;
      err.data = body.error.data;
      throw err;
    }
    return body.result;
  }
  return {
    getLatestLedger() {
      return call("getLatestLedger");
    },
    getLedgerEntries(...keys) {
      const encoded = keys.map((k) => {
        if (typeof k === "string") return k;
        if (k && k.base64) return k.base64;
        if (k && typeof k.toXDR === "function") return k.toXDR("base64");
        throw new Error("unusable ledger key");
      });
      return call("getLedgerEntries", { keys: encoded });
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
      });
    },
  };
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function fetchEntries(rpc, keys) {
  if (!keys.length) return { entries: [], latestLedger: 0 };
  const all = [];
  let latestLedger = 0;
  for (const group of chunk(keys, MAX_KEYS)) {
    const args = group.map((k) => k.xdr || k);
    const res = await rpc.getLedgerEntries(...args);
    latestLedger = res.latestLedger ?? latestLedger;
    all.push(...(res.entries ?? []));
  }
  return { entries: all, latestLedger };
}

function entryKeyB64(entry) {
  if (typeof entry.key === "string") return entry.key;
  if (entry.key && typeof entry.key.toXDR === "function") return entry.key.toXDR("base64");
  return null;
}

function entryData(entry, sdk) {
  if (entry.val && typeof entry.val.switch === "function") return entry.val;
  const raw = entry.xdr || (typeof entry.val === "string" ? entry.val : null);
  if (!raw) return null;
  try {
    return sdk.xdr.LedgerEntryData.fromXDR(raw, "base64");
  } catch {
    try {
      return sdk.xdr.LedgerEntry.fromXDR(raw, "base64").data();
    } catch {
      return null;
    }
  }
}

function contractScVal(entry, sdk) {
  const data = entryData(entry, sdk);
  if (!data) return null;
  try {
    return data.contractData().val();
  } catch {
    return null;
  }
}

function scBytes(scv) {
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

function indexByKey(entries) {
  const map = new Map();
  for (const e of entries) {
    const k = entryKeyB64(e);
    if (k) map.set(k, e);
  }
  return map;
}

function asBig(n) {
  if (typeof n === "bigint") return n;
  if (n == null) return 0n;
  return BigInt(n);
}

function pick(obj, ...names) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const n of names) {
    if (obj[n] !== undefined) return obj[n];
  }
  return undefined;
}

function parseBest(native) {
  if (!native) return { empty: true, tick: 0 };
  return { empty: !!native.empty, tick: Number(native.tick ?? 0) };
}

function parseMarket(native) {
  if (!native) return null;
  return {
    base: String(native.base),
    quote: String(native.quote),
    lot_size: asBig(native.lot_size),
    tick_size: asBig(native.tick_size),
    tick_min: Number(native.tick_min),
    tick_max: Number(native.tick_max),
    taker_fee_bps: Number(native.taker_fee_bps),
    min_order_lots: asBig(native.min_order_lots),
    max_order_lots: asBig(native.max_order_lots),
    max_levels_crossed: Number(native.max_levels_crossed),
    max_slots_scanned: Number(native.max_slots_scanned),
    inline_slots: Number(native.inline_slots),
    page_slots: Number(native.page_slots),
    max_pages: Number(native.max_pages),
  };
}

function parseBalance(native) {
  if (native == null) return null;
  if (typeof native === "bigint" || typeof native === "number" || typeof native === "string") {
    return asBig(native);
  }
  if (typeof native === "object") {
    const amt = pick(native, "amount", "Amount");
    if (amt != null) return asBig(amt);
  }
  return null;
}

function parseFee(native) {
  if (native == null) return 0n;
  if (typeof native === "object" && native.accrued != null) return asBig(native.accrued);
  try {
    return asBig(native);
  } catch {
    return 0n;
  }
}

function instanceStorage(entry, sdk) {
  const scv = contractScVal(entry, sdk);
  if (!scv) return [];
  try {
    const inst = scv.instance();
    const storage = inst.storage();
    if (!storage) return [];
    return [...storage].map((pair) => ({
      key: sdk.scValToNative(pair.key()),
      val: sdk.scValToNative(pair.val()),
    }));
  } catch {
    return [];
  }
}

function findStorage(pairs, name) {
  for (const p of pairs) {
    const k = p.key;
    if (k === name) return p.val;
    if (Array.isArray(k) && k[0] === name) return p.val;
  }
  return undefined;
}

function parseTokenMeta(pairs) {
  const meta = findStorage(pairs, "METADATA") ?? findStorage(pairs, "Metadata");
  if (!meta || typeof meta !== "object") return null;
  const symbol = pick(meta, "symbol", "Symbol");
  const decimals = pick(meta, "decimal", "decimals", "Decimal", "Decimals");
  const tokenName = pick(meta, "name", "Name");
  if (symbol == null && decimals == null) return null;
  return {
    symbol: symbol != null ? displaySymbol(String(symbol)) : null,
    decimals: decimals != null ? Number(decimals) : null,
    name: tokenName != null ? String(tokenName) : null,
  };
}

// The native-asset SAC reports its symbol as "native"; show it as XLM.
export function displaySymbol(symbol) {
  return symbol === "native" ? "XLM" : symbol;
}

function readNative(map, keyObj, sdk) {
  const e = map.get(keyObj.base64);
  if (!e) return null;
  const scv = contractScVal(e, sdk);
  if (!scv) return null;
  const bytes = scBytes(scv);
  if (bytes) return { _bytes: bytes };
  try {
    return sdk.scValToNative(scv);
  } catch {
    return null;
  }
}

function listWords(summary, bestTick, isBid, k = WORDS_PER_SIDE) {
  const start = wordOf(bestTick);
  const words = [];
  const seen = new Set();
  const add = (w) => {
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

function unreadSetWords(summary, readWords, best, isBid) {
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

function ticksFromWords(wordMap, bestTick, isBid, limit) {
  const ticks = [];
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

function ensureBest(cands, best) {
  if (best.empty) return cands;
  if (!cands.includes(best.tick)) return [best.tick, ...cands];
  return cands;
}

async function walkDepthOnce(rpc, opts) {
  const sdk = resolveSdk(opts.sdk);
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

  const batch1 = [kBestBid, kBestAsk, kSumBid, kSumAsk, kMarket, kInst];
  let extraKnown = [];
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

  const bestBid = parseBest(readNative(map, kBestBid, sdk));
  const bestAsk = parseBest(readNative(map, kBestAsk, sdk));
  const sumBidRaw = readNative(map, kSumBid, sdk);
  const sumAskRaw = readNative(map, kSumAsk, sdk);
  const summaryBid = sumBidRaw?._bytes ? decodeBitmap(sumBidRaw._bytes) : null;
  const summaryAsk = sumAskRaw?._bytes ? decodeBitmap(sumAskRaw._bytes) : null;
  const marketInfo = parseMarket(readNative(map, kMarket, sdk));

  const instEntry = map.get(kInst.base64);
  const instPairs = instEntry ? instanceStorage(instEntry, sdk) : [];
  const config = findStorage(instPairs, "Config") || {};
  const paused = !!(config && config.paused);

  const base = marketInfo?.base || opts.base || null;
  const quote = marketInfo?.quote || opts.quote || null;

  const wordsBid = bestBid.empty ? [] : listWords(summaryBid, bestBid.tick, true);
  const wordsAsk = bestAsk.empty ? [] : listWords(summaryAsk, bestAsk.tick, false);
  const wordKeys = [];
  const wordMeta = [];
  for (const w of wordsBid) {
    wordKeys.push(ck(contract, "TickWord", market, true, w));
    wordMeta.push({ side: "bid", word: w });
  }
  for (const w of wordsAsk) {
    wordKeys.push(ck(contract, "TickWord", market, false, w));
    wordMeta.push({ side: "ask", word: w });
  }

  const tokenKeys = [];
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

  const wordMapBid = new Map();
  const wordMapAsk = new Map();
  for (let i = 0; i < wordKeys.length; i++) {
    const raw = readNative(map, wordKeys[i], sdk);
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

  const levelKeys = [];
  for (const t of candBid) levelKeys.push(ck(contract, "Level", market, true, t));
  for (const t of candAsk) levelKeys.push(ck(contract, "Level", market, false, t));

  const r3 = await fetchEntries(rpc, levelKeys);
  const map3 = indexByKey(r3.entries);

  function readLvl(keyObj) {
    const e = map3.get(keyObj.base64);
    if (!e) return null;
    const scv = contractScVal(e, sdk);
    const bytes = scBytes(scv);
    return bytes ? decodeLevel(bytes) : null;
  }

  function collect(cands, keyOffset, best) {
    const rows = [];
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

  let vaultBase = null;
  let vaultQuote = null;
  let feeBase = 0n;
  let feeQuote = 0n;
  let baseMeta = null;
  let quoteMeta = null;
  if (base && quote) {
    const nativeOf = (ko) => {
      const e = map.get(ko.base64);
      if (!e) return null;
      const scv = contractScVal(e, sdk);
      if (!scv) return null;
      try {
        return sdk.scValToNative(scv);
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
    if (be) baseMeta = parseTokenMeta(instanceStorage(be, sdk));
    if (qe) quoteMeta = parseTokenMeta(instanceStorage(qe, sdk));
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

export async function walkDepth(rpc, opts) {
  if (opts.sdk) setSdk(opts.sdk);
  const first = await walkDepthOnce(rpc, opts);
  if (!first.mismatched) return first;
  return walkDepthOnce(rpc, { ...opts, base: first.base, quote: first.quote });
}

const MAX_MARKETS_LISTED = 64;

/// Every market on the contract: `Config.market_counter` from the instance,
/// then `Market(i)` for each id and the two SAC instances for symbols. Two
/// round trips. Markets whose entry is missing (archived) are skipped.
export async function listMarkets(rpc, opts) {
  if (opts.sdk) setSdk(opts.sdk);
  const sdk = resolveSdk(opts.sdk);
  const contract = opts.contract;
  const kInst = instanceKey(contract);
  const r1 = await fetchEntries(rpc, [kInst]);
  const instEntry = r1.entries[0];
  const config = instEntry ? findStorage(instanceStorage(instEntry, sdk), "Config") : null;
  const count = Math.min(Number(config?.market_counter ?? 0), MAX_MARKETS_LISTED);
  if (!count) return { markets: [], latestLedger: r1.latestLedger };

  const marketKeys = [];
  for (let i = 0; i < count; i++) marketKeys.push(ck(contract, "Market", i));
  const r2 = await fetchEntries(rpc, marketKeys);
  const map2 = indexByKey(r2.entries);
  const markets = [];
  for (let i = 0; i < count; i++) {
    const m = parseMarket(readNative(map2, marketKeys[i], sdk));
    if (m) markets.push({ id: i, base: m.base, quote: m.quote, market: m });
  }

  const sacs = [...new Set(markets.flatMap((m) => [m.base, m.quote]))];
  const sacKeys = sacs.map((s) => instanceKey(s));
  const r3 = await fetchEntries(rpc, sacKeys);
  const map3 = indexByKey(r3.entries);
  const metaOf = new Map();
  sacs.forEach((s, i) => {
    const e = map3.get(sacKeys[i].base64);
    metaOf.set(s, e ? parseTokenMeta(instanceStorage(e, sdk)) : null);
  });
  for (const m of markets) {
    m.baseMeta = metaOf.get(m.base) || null;
    m.quoteMeta = metaOf.get(m.quote) || null;
    m.baseSym = m.baseMeta?.symbol || null;
    m.quoteSym = m.quoteMeta?.symbol || null;
  }
  return { markets, latestLedger: r3.latestLedger || r2.latestLedger };
}

function eventCursor(res, fallback) {
  if (res.cursor) return res.cursor;
  const evs = res.events ?? [];
  if (evs.length) {
    const last = evs[evs.length - 1];
    return last.pagingToken || last.id || fallback;
  }
  return fallback;
}

function parseEvent(sdk, ev) {
  let topics = ev.topic ?? ev.topics ?? [];
  let value = ev.value;
  try {
    if (topics.length && typeof topics[0] === "string") {
      topics = topics.map((t) => sdk.xdr.ScVal.fromXDR(t, "base64"));
    }
    if (typeof value === "string") {
      value = sdk.xdr.ScVal.fromXDR(value, "base64");
    }
  } catch {
    return null;
  }
  let name;
  try {
    name = String(sdk.scValToNative(topics[0]));
  } catch {
    return null;
  }
  let data;
  try {
    data = sdk.scValToNative(value);
  } catch {
    data = null;
  }
  const arr = Array.isArray(data) ? data : [];
  const txHash = ev.txHash || ev.transactionHash || "";
  const base = {
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
        is_bid: !!arr[0],
        tick: Number(arr[1]),
        lots: asBig(arr[2]),
        quote: asBig(arr[3]),
        taker: arr[0] ? "sell" : "buy",
      };
    case "rested":
      return {
        ...base,
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
        owner: String(arr[0] ?? ""),
        nonce: asBig(arr[1]),
        filled_lots: asBig(arr[2]),
        refunded_lots: asBig(arr[3]),
      };
    case "swept":
      return {
        ...base,
        is_bid: !!arr[0],
        tick: Number(arr[1]),
        generation: Number(arr[2]),
      };
    case "top_changed":
      return {
        ...base,
        is_bid: !!arr[0],
        old: Number(arr[1]),
        newTick: Number(arr[2]),
      };
    default:
      return { ...base, data: arr };
  }
}

function parseStartHint(err, start, latest) {
  const msg = String(err && err.message ? err.message : err);
  const nums = [...msg.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n > 0 && n < latest);
  if (/old|retention|between|range|closer|minimum|oldest/i.test(msg) && nums.length) {
    return Math.max(nums[0], start + 1);
  }
  const mid = start + Math.max(1, Math.floor((latest - start) / 2));
  return mid >= latest ? Math.max(1, latest - 1) : mid;
}

export async function pollEvents(rpc, opts) {
  if (opts.sdk) setSdk(opts.sdk);
  const sdk = resolveSdk(opts.sdk);
  const contract = opts.contract;
  const market = Number(opts.market ?? 0);
  const latest = Number(opts.latestLedger);
  const seen = opts.seen instanceof Set ? opts.seen : new Set();
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

  const events = [];
  let oldestLedger = null;

  const take = (res) => {
    for (const ev of res.events ?? []) {
      const id = ev.id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      const parsed = parseEvent(sdk, ev);
      if (parsed) events.push(parsed);
    }
    if (res.oldestLedger != null) oldestLedger = res.oldestLedger;
    cursor = eventCursor(res, cursor);
  };

  if (!cursor) {
    let start = opts.startLedger ?? Math.max(1, latest - EVENT_LOOKBACK);
    let res = null;
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

export function mockSnapshot() {
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
