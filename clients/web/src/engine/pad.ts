import { orderKey } from "../keys";
import type { Rpc } from "../book";
import { wordOf } from "../decode";
import { accessOf, addrToHex, keyStr, sameKey, type ClientKey, type Hex32 } from "./clientKeys";

export const MAX_REPLACE_BATCH = 40;

export function restKeys(market: number, isBid: boolean, tick: number): ClientKey[] {
  return [
    { t: "Level", market, isBid, tick },
    { t: "TickWord", market, isBid, word: wordOf(tick) },
    { t: "TickSummary", market, isBid },
    { t: "BestTick", market, isBid },
    { t: "BestTick", market, isBid: !isBid },
  ];
}

export function feeKeys(market: number, base: Hex32, quote: Hex32): ClientKey[] {
  return [
    { t: "FeeAccrual", market, token: base },
    { t: "FeeAccrual", market, token: quote },
  ];
}

export function orderClientKey(market: number, owner: Hex32, nonce: bigint): ClientKey {
  return { t: "Order", market, owner, nonce };
}

export type PlannedIntent =
  | { kind: "place"; quoted: Quoted; padEnd: number }
  | {
      kind: "placePostOnly";
      market: number;
      isBid: boolean;
      limitTick: number;
      taker: string;
      nonce: bigint;
      base: Hex32;
      quote: Hex32;
    }
  | { kind: "settle"; market: number; base: Hex32; quote: Hex32 }
  | { kind: "replace"; market: number; isBid: boolean; tick: number; base: Hex32; quote: Hex32 }
  | {
      kind: "replaceBatch";
      market: number;
      items: { isBid: boolean; tick: number }[];
      base: Hex32;
      quote: Hex32;
    }
  | { kind: "invoke" };

export function plannedKeysFor(intent: PlannedIntent): ClientKey[] {
  switch (intent.kind) {
    case "place":
      return pad(intent.quoted, intent.padEnd);
    case "placePostOnly": {
      const keys = [
        ...restKeys(intent.market, intent.isBid, intent.limitTick),
        orderClientKey(intent.market, addrToHex(intent.taker), intent.nonce),
        ...feeKeys(intent.market, intent.base, intent.quote),
      ];
      dedup(keys);
      return keys;
    }
    case "settle":
      return feeKeys(intent.market, intent.base, intent.quote);
    case "replace": {
      const keys = [...restKeys(intent.market, intent.isBid, intent.tick), ...feeKeys(intent.market, intent.base, intent.quote)];
      dedup(keys);
      return keys;
    }
    case "replaceBatch": {
      const keys = [...feeKeys(intent.market, intent.base, intent.quote)];
      for (const it of intent.items) keys.push(...restKeys(intent.market, it.isBid, it.tick));
      dedup(keys);
      return keys;
    }
    case "invoke":
      return [];
  }
}

export function touchedKeysFor(intent: PlannedIntent, planned: ClientKey[]): ClientKey[] {
  if (intent.kind === "place") return restoreMarks(intent.quoted, planned, planned);
  return planned.filter((k) => accessOf(k) === "rw");
}

export type CrossedLevel = {
  tick: number;
};

export type Quoted = {
  market: number;
  ownSide: boolean;
  limitTick: number;
  startTick: number;
  crossed: CrossedLevel[];
  taker: Hex32;
  nonce: bigint;
  base: Hex32;
  quote: Hex32;
};

// Settle touches the order, its level, and the four balance entries. A level
// is one entry (ADR-037), so the queue position of the order does not change
// which keys the call reads.
export function keysForSettle(
  market: number,
  owner: Hex32,
  nonce: bigint,
  isBid: boolean,
  tick: number,
  base: Hex32,
  quote: Hex32,
): ClientKey[] {
  return [
    { t: "Market", market },
    { t: "Order", market, owner, nonce },
    { t: "Level", market, isBid, tick },
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
  newIsBid: boolean,
  newTick: number,
  base: Hex32,
  quote: Hex32,
): ClientKey[] {
  const keys = keysForSettle(market, owner, nonce, oldIsBid, oldTick, base, quote);
  keys.push({ t: "Config" });
  keys.push({ t: "Level", market, isBid: newIsBid, tick: newTick });
  keys.push({ t: "TickWord", market, isBid: newIsBid, word: wordOf(newTick) });
  keys.push({ t: "TickSummary", market, isBid: newIsBid });
  keys.push({ t: "BestTick", market, isBid: newIsBid });
  keys.push({ t: "BestTick", market, isBid: !newIsBid });
  dedup(keys);
  return keys;
}

// The architecture §14 pad rule for a place. The opposite-side band of
// levels from the start tick to the pad end, the words those ticks and the
// limit fall in, the summaries and bests on both sides, the taker's own rest
// level and word, the order, the fee accruals, and the four balance entries
// are read-write. Config and Market are read-only.
export function pad(q: Quoted, padEnd: number): ClientKey[] {
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

  keys.push({ t: "Level", market: m, isBid: q.ownSide, tick: q.limitTick });
  keys.push({ t: "TickWord", market: m, isBid: q.ownSide, word: wordOf(q.limitTick) });
  keys.push({ t: "TickSummary", market: m, isBid: q.ownSide });
  keys.push({ t: "BestTick", market: m, isBid: q.ownSide });
  keys.push({ t: "Order", market: m, owner: q.taker, nonce: q.nonce });

  keys.push({ t: "FeeAccrual", market: m, token: q.base });
  keys.push({ t: "FeeAccrual", market: m, token: q.quote });
  keys.push({ t: "VaultBalance", token: q.base });
  keys.push({ t: "VaultBalance", token: q.quote });
  keys.push({ t: "UserBalance", token: q.base });
  keys.push({ t: "UserBalance", token: q.quote });

  dedup(keys);
  return keys;
}

// Of the archived keys in a pad, the ones the call itself will touch and so
// must be restored first: the crossed levels, the own rest, the bitmaps, and
// the bookkeeping entries. Config and Market are read-only on a trading call,
// so they cannot be restore-marked: archivedSorobanEntries indexes the
// read-write list. A padded but untouched band level can stay archived.
export function restoreMarks(q: Quoted, padKeys: ClientKey[], archived: ClientKey[]): ClientKey[] {
  const m = q.market;
  const opp = !q.ownSide;
  const touched: ClientKey[] = [
    { t: "TickSummary", market: m, isBid: opp },
    { t: "BestTick", market: m, isBid: opp },
    { t: "Level", market: m, isBid: q.ownSide, tick: q.limitTick },
    { t: "TickWord", market: m, isBid: q.ownSide, word: wordOf(q.limitTick) },
    { t: "TickSummary", market: m, isBid: q.ownSide },
    { t: "BestTick", market: m, isBid: q.ownSide },
    { t: "Order", market: m, owner: q.taker, nonce: q.nonce },
    { t: "FeeAccrual", market: m, token: q.base },
    { t: "FeeAccrual", market: m, token: q.quote },
  ];
  for (const c of q.crossed) {
    touched.push({ t: "Level", market: m, isBid: opp, tick: c.tick });
  }
  if (!q.crossed.length) {
    touched.push({ t: "Level", market: m, isBid: opp, tick: q.startTick });
  }
  const [wlo, whi] = wordSpan([q.startTick, q.limitTick]);
  for (let w = wlo; w <= whi; w++) touched.push({ t: "TickWord", market: m, isBid: opp, word: w });

  return archived.filter((k) => padKeys.some((x) => sameKey(x, k)) && touched.some((x) => sameKey(x, k)));
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
