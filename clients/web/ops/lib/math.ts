export const LOT_XLM = 10;
export const TICK_USD_PER_XLM = 0.00001;
export const TICK_MIN = 1;
export const TICK_MAX = 4_194_304;
export const BAND_SKIP = 140;
export const LEVEL_FULL_BAN_S = 600;
export const HEAL_DEBOUNCE_S = 20;
export const MAX_LEVELS_CROSSED = 32;

export function halfEvenRound(x: number): number {
  if (!Number.isFinite(x)) return x;
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const ip = Math.floor(ax);
  const frac = ax - ip;
  if (frac < 0.5) return s * ip;
  if (frac > 0.5) return s * (ip + 1);
  return s * (ip % 2 === 0 ? ip : ip + 1);
}

export function tickOf(price: number): number {
  return halfEvenRound(price / TICK_USD_PER_XLM);
}

export function priceOf(tick: number): number {
  return tick * TICK_USD_PER_XLM;
}

export function crosses(takerIsBid: boolean, oppTick: number, limitTick: number): boolean {
  return takerIsBid ? oppTick <= limitTick : oppTick >= limitTick;
}

export function inTickBand(tick: number): boolean {
  return tick >= TICK_MIN + 1 && tick < TICK_MAX - 1;
}

export type LadderParams = {
  levels: number;
  halfSpreadBps: number;
  spacingBps: number;
  baseLots: number;
  stepLots: number;
};

export type Slot = { tick: number; lots: number };

export function ladder(midTick: number, skewBps: number, a: LadderParams): { bids: Slot[]; asks: Slot[] } {
  const centre = midTick * (1 + skewBps / 1e4);
  const bids: Slot[] = [];
  const asks: Slot[] = [];
  for (let i = 0; i < a.levels; i++) {
    const off = (centre * (a.halfSpreadBps + i * a.spacingBps)) / 1e4;
    bids.push({ tick: Math.floor(centre - off), lots: a.baseLots + a.stepLots * i });
    asks.push({ tick: Math.ceil(centre + off), lots: a.baseLots + a.stepLots * i });
  }
  return { bids, asks };
}

export function sideLots(a: LadderParams): number {
  let n = 0;
  for (let i = 0; i < a.levels; i++) n += a.baseLots + a.stepLots * i;
  return n;
}

export function inventorySkew(opts: {
  skewBps: number;
  ladder: LadderParams;
  price: number;
  xlm: number;
  usdc: number;
  inv0: { xlm: number; usdc: number };
}): number {
  if (opts.skewBps <= 0) return 0;
  const notional = Math.max(1, sideLots(opts.ladder) * LOT_XLM * opts.price);
  const dXlmV = (opts.xlm - opts.inv0.xlm) * opts.price;
  const dUsd = opts.usdc - opts.inv0.usdc;
  const imb = (dXlmV - dUsd) / (2 * notional);
  const clamped = Math.max(-1, Math.min(1, imb));
  return -opts.skewBps * clamped;
}

export function banKey(isBid: boolean, tick: number): string {
  return `${isBid ? "b" : "a"}:${tick}`;
}

export function stepAwayFromBanned(
  isBid: boolean,
  tick: number,
  banned: Map<string, number>,
  now: number,
): number {
  let t = tick;
  while ((banned.get(banKey(isBid, t)) ?? 0) > now) {
    t += isBid ? -1 : 1;
  }
  return t;
}

export function clampHealTarget(isBid: boolean, oppositeBest: number, target: number, healBand: number): number {
  if (crosses(isBid, oppositeBest, target) && Math.abs(target - oppositeBest) > healBand) {
    return isBid ? oppositeBest + healBand : oppositeBest - healBand;
  }
  return target;
}

export function healTargetFromQuote(
  isBid: boolean,
  oppositeBest: number,
  target: number,
  healBand: number,
  crossed: { tick: number }[],
): number {
  let t = clampHealTarget(isBid, oppositeBest, target, healBand);
  if (crossed.length >= MAX_LEVELS_CROSSED) t = crossed[crossed.length - 1].tick;
  return t;
}

export type TakeMix = { lots: number; depth: number };

export function randInt(lo: number, hi: number, rnd: () => number = Math.random): number {
  return lo + Math.floor(rnd() * (hi - lo + 1));
}

export function drawTake(u: number, rnd: () => number = Math.random): TakeMix {
  if (u < 0.6) return { lots: randInt(1, 12, rnd), depth: 0 };
  if (u < 0.9) return { lots: randInt(20, 80, rnd), depth: 12 };
  return { lots: randInt(100, 260, rnd), depth: 40 };
}

export function takeLimit(isBid: boolean, touch: number, depth: number): number {
  return isBid ? touch + depth : Math.max(TICK_MIN + 1, touch - depth);
}

export function bandTooWide(limit: number, startTick: number): boolean {
  return Math.abs(limit - startTick) > BAND_SKIP;
}

export const LOOP_LINE_KEYS = [
  "t",
  "action",
  "outcome",
  "loop",
  "mid",
  "src",
  "mid_tick",
  "skew_bps",
  "our_bid",
  "our_ask",
  "book_bid",
  "book_ask",
  "live",
  "n_bids",
  "n_asks",
  "replaced",
  "placed",
  "fills_total",
  "volume_lots",
  "xlm",
  "usdc",
] as const;

export type LoopLine = {
  t: number;
  action: "loop";
  outcome: string;
  loop: number;
  mid: number | null;
  src: string | null;
  mid_tick: number;
  skew_bps: number;
  our_bid: number | null;
  our_ask: number | null;
  book_bid: number | null;
  book_ask: number | null;
  live: number;
  n_bids: number;
  n_asks: number;
  replaced: number;
  placed: number;
  fills_total: number;
  volume_lots: number;
  xlm: number | null;
  usdc: number | null;
};

export function loopLine(fields: Omit<LoopLine, "t" | "action"> & { t?: number }): LoopLine {
  return { t: fields.t ?? Date.now() / 1000, action: "loop", ...fields };
}

export function startTickForPostOnly(isBid: boolean): number {
  return isBid ? TICK_MAX - 1 : TICK_MIN;
}

export function emptyRestWindow(): { consume: []; append: { first: number; last: number } } {
  return { consume: [], append: { first: 0, last: 1 } };
}

export function repr(e: unknown): string {
  if (e instanceof Error) return `${e.name}('${e.message}')`;
  return String(e);
}

export function secretEnvName(identity: string): string {
  return `PB_SECRET_${identity.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}
