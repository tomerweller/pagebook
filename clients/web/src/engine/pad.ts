import { orderKey } from "../keys";
import type { Rpc } from "../book";
import { wordOf } from "../decode";
import { keyStr, sameKey, type ClientKey, type Hex32 } from "./clientKeys";

export const INLINE_SLOTS = 32;
export const PAGE_SLOTS = 32;
export const CONSUME_WIDTH = 1;
export const MAX_REPLACE_BATCH = 40;

export type CrossedLevel = {
  tick: number;
  headSeq: number;
  openLots: bigint;
};

export type Quoted = {
  market: number;
  ownSide: boolean;
  limitTick: number;
  startTick: number;
  crossed: CrossedLevel[];
  tailSeq: number;
  taker: Hex32;
  nonce: bigint;
  base: Hex32;
  quote: Hex32;
};

export type PageRange = { first: number; last: number };

export type WindowSpec = {
  consume: { tick: number; pages: PageRange }[];
  append: PageRange;
};

export type PadOut = {
  keys: ClientKey[];
  window: WindowSpec;
};

export function pageOf(seq: number): number {
  return seq < INLINE_SLOTS ? 0 : Math.floor((seq - INLINE_SLOTS) / PAGE_SLOTS);
}

export function appendRange(tailSeq: number): PageRange {
  const p = pageOf(tailSeq);
  return { first: p, last: p + 1 };
}

export function keysForSettle(
  market: number,
  owner: Hex32,
  nonce: bigint,
  isBid: boolean,
  tick: number,
  seq: number,
  base: Hex32,
  quote: Hex32,
): ClientKey[] {
  return [
    { t: "Market", market },
    { t: "Order", market, owner, nonce },
    { t: "Level", market, isBid, tick },
    { t: "LevelPage", market, isBid, tick, page: pageOf(seq) },
    { t: "VaultBalance", token: base },
    { t: "VaultBalance", token: quote },
    { t: "UserBalance", token: base },
    { t: "UserBalance", token: quote },
  ];
}

export function keysForReplace(
  market: number,
  owner: Hex32,
  nonce: bigint,
  oldIsBid: boolean,
  oldTick: number,
  oldSeq: number,
  newIsBid: boolean,
  newTick: number,
  newTailSeq: number,
  base: Hex32,
  quote: Hex32,
): { keys: ClientKey[]; append: PageRange } {
  const keys = keysForSettle(market, owner, nonce, oldIsBid, oldTick, oldSeq, base, quote);
  keys.push({ t: "Config" });
  const append = appendRange(newTailSeq);
  keys.push({ t: "Level", market, isBid: newIsBid, tick: newTick });
  keys.push({ t: "TickWord", market, isBid: newIsBid, word: wordOf(newTick) });
  keys.push({ t: "TickSummary", market, isBid: newIsBid });
  keys.push({ t: "BestTick", market, isBid: newIsBid });
  keys.push({ t: "BestTick", market, isBid: !newIsBid });
  pushPages(keys, market, newIsBid, newTick, append);
  dedup(keys);
  return { keys, append };
}

export function pad(q: Quoted, padEnd: number): PadOut {
  const opp = !q.ownSide;
  const m = q.market;
  const keys: ClientKey[] = [];
  keys.push({ t: "Config" });
  keys.push({ t: "Market", market: m });

  const lo = Math.min(q.startTick, padEnd);
  const hi = Math.max(q.startTick, padEnd);
  for (let t = lo; t <= hi; t++) keys.push({ t: "Level", market: m, isBid: opp, tick: t });

  const [wlo, whi] = wordSpan([q.startTick, q.limitTick, padEnd]);
  for (let w = wlo; w <= whi; w++) keys.push({ t: "TickWord", market: m, isBid: opp, word: w });
  keys.push({ t: "TickSummary", market: m, isBid: opp });
  keys.push({ t: "BestTick", market: m, isBid: opp });

  const consume: WindowSpec["consume"] = [];
  for (const c of q.crossed) {
    const p = pageOf(c.headSeq);
    const range = { first: p, last: p + CONSUME_WIDTH };
    pushPages(keys, m, opp, c.tick, range);
    consume.push({ tick: c.tick, pages: range });
  }

  keys.push({ t: "Level", market: m, isBid: q.ownSide, tick: q.limitTick });
  keys.push({ t: "TickWord", market: m, isBid: q.ownSide, word: wordOf(q.limitTick) });
  keys.push({ t: "TickSummary", market: m, isBid: q.ownSide });
  keys.push({ t: "BestTick", market: m, isBid: q.ownSide });
  keys.push({ t: "Order", market: m, owner: q.taker, nonce: q.nonce });
  const append = appendRange(q.tailSeq);
  pushPages(keys, m, q.ownSide, q.limitTick, append);

  keys.push({ t: "FeeAccrual", market: m, token: q.base });
  keys.push({ t: "FeeAccrual", market: m, token: q.quote });
  keys.push({ t: "VaultBalance", token: q.base });
  keys.push({ t: "VaultBalance", token: q.quote });
  keys.push({ t: "UserBalance", token: q.base });
  keys.push({ t: "UserBalance", token: q.quote });

  dedup(keys);
  return { keys, window: { consume, append } };
}

export function restoreMarks(q: Quoted, out: PadOut, archived: ClientKey[]): ClientKey[] {
  const m = q.market;
  const opp = !q.ownSide;
  const touched: ClientKey[] = [
    { t: "Config" },
    { t: "Market", market: m },
    { t: "TickSummary", market: m, isBid: opp },
    { t: "BestTick", market: m, isBid: opp },
    { t: "Level", market: m, isBid: q.ownSide, tick: q.limitTick },
    { t: "TickWord", market: m, isBid: q.ownSide, word: wordOf(q.limitTick) },
    { t: "TickSummary", market: m, isBid: q.ownSide },
    { t: "BestTick", market: m, isBid: q.ownSide },
    { t: "Order", market: m, owner: q.taker, nonce: q.nonce },
    { t: "LevelPage", market: m, isBid: q.ownSide, tick: q.limitTick, page: 0 },
    { t: "LevelPage", market: m, isBid: q.ownSide, tick: q.limitTick, page: pageOf(q.tailSeq) },
    { t: "LevelPage", market: m, isBid: q.ownSide, tick: q.limitTick, page: pageOf(q.tailSeq) + 1 },
    { t: "FeeAccrual", market: m, token: q.base },
    { t: "FeeAccrual", market: m, token: q.quote },
  ];
  for (const c of q.crossed) {
    touched.push({ t: "Level", market: m, isBid: opp, tick: c.tick });
    const p = pageOf(c.headSeq);
    touched.push({ t: "LevelPage", market: m, isBid: opp, tick: c.tick, page: p });
    touched.push({ t: "LevelPage", market: m, isBid: opp, tick: c.tick, page: p + CONSUME_WIDTH });
  }
  if (!q.crossed.length) {
    touched.push({ t: "Level", market: m, isBid: opp, tick: q.startTick });
  }
  const [wlo, whi] = wordSpan([q.startTick, q.limitTick]);
  for (let w = wlo; w <= whi; w++) touched.push({ t: "TickWord", market: m, isBid: opp, word: w });

  return archived.filter((k) => out.keys.some((x) => sameKey(x, k)) && touched.some((x) => sameKey(x, k)));
}

export function windowJson(q: Quoted): string {
  const consume = q.crossed.map((c) => {
    const p = pageOf(c.headSeq);
    return { tick: c.tick, pages: { first: p, last: p + CONSUME_WIDTH } };
  });
  const p = pageOf(q.tailSeq);
  return JSON.stringify({ consume, append: { first: p, last: p + 1 } });
}

export class NonceAlloc {
  private next: bigint;
  constructor(start = 1n) {
    this.next = start;
  }
  take(): bigint {
    const n = this.next;
    this.next += 1n;
    return n;
  }
}

export async function allocNonce(
  rpc: Rpc,
  contract: string,
  market: number,
  owner: string,
  hint: bigint,
): Promise<bigint> {
  let n = hint;
  for (let i = 0; i < 64; i++) {
    const res = await rpc.getLedgerEntries(orderKey(contract, market, owner, n));
    if (!(res.entries && res.entries.length)) return n;
    n += 1n;
  }
  throw new Error("no free nonce");
}

function wordSpan(ticks: number[]): [number, number] {
  let lo = 0xffffffff;
  let hi = 0;
  for (const t of ticks) {
    const w = wordOf(t);
    if (w < lo) lo = w;
    if (w > hi) hi = w;
  }
  return [lo, hi];
}

function pushPages(keys: ClientKey[], market: number, isBid: boolean, tick: number, r: PageRange): void {
  for (let p = r.first; p <= r.last; p++) keys.push({ t: "LevelPage", market, isBid, tick, page: p });
  keys.push({ t: "LevelPage", market, isBid, tick, page: 0 });
}

function dedup(keys: ClientKey[]): void {
  const seen = new Set<string>();
  let w = 0;
  for (const k of keys) {
    const s = keyStr(k);
    if (seen.has(s)) continue;
    seen.add(s);
    keys[w++] = k;
  }
  keys.length = w;
}
