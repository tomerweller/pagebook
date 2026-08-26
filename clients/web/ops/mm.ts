import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpc, type Rpc } from "../src/book";
import { addrToHex } from "../src/engine/clientKeys";
import { pad } from "../src/engine/pad";
import {
  submitPlace,
  submitPostOnlyPlace,
  submitReplace,
  submitReplaceBatch,
  submitSettle,
  type ClassicToken,
  type EngineResult,
} from "../src/engine/submit";
import type { ApplyPadSizes } from "../src/engine/txdata";
import { parseArgs, type ArgSpec } from "./lib/args";
import { Feed } from "./lib/feed";
import { fetchBalances } from "./lib/horizon";
import { loadIdentity, type Identity } from "./lib/identity";
import {
  banKey,
  clampHealTarget,
  crosses,
  emptyRestWindow,
  HEAL_DEBOUNCE_S,
  healTargetFromQuote,
  inTickBand,
  halfEvenRound,
  inventorySkew,
  ladder,
  LEVEL_FULL_BAN_S,
  repr,
  startTickForPostOnly,
  stepAwayFromBanned,
  tickOf,
  type LadderParams,
} from "./lib/math";
import { openLog, type OpsLog } from "./lib/opslog";
import { classicTokens, collectUniverseXdr, feeKeys, orderClientKey, restKeys, settlePageKeys, sweepPadSizes, tokenHex } from "./lib/padkeys";
import { loadState, saveState, type MmState, type QuoteState } from "./lib/statefile";
import { type OutcomeInput } from "./lib/outcomes";
import { runSubmit, sleep, type RestoreBudget, type SubmitPair } from "./lib/submitlog";
import { createViews, type Views } from "./lib/views";

export type MmArgs = {
  contract: string;
  market: number;
  identity: string;
  baseSac: string;
  quoteSac: string;
  usdcIssuer: string;
  tickMin: number;
  tickMax: number;
  baseCode: string;
  baseIssuer: string;
  usdcCode: string;
  configDir: string;
  network: string;
  rpc: string;
  horizon: string;
  levels: number;
  halfSpreadBps: number;
  spacingBps: number;
  baseLots: number;
  stepLots: number;
  skewBps: number;
  requoteTicks: number;
  touchSlots: number;
  fullScanEvery: number;
  batch: number;
  maxPlacesPerCycle: number;
  interval: number;
  maxFeedAge: number;
  healBand: number;
  maxHealsPerCycle: number;
  state: string;
  log: string;
  cancelAll: boolean;
  cancelOnExit: boolean;
  padV2: boolean;
  fixedMid?: number;
  walkMid: boolean;
};

export const MM_SPECS: ArgSpec<keyof MmArgs & string>[] = [
  { flag: "--contract", dest: "contract", required: true },
  { flag: "--market", dest: "market", type: "int", required: true },
  { flag: "--identity", dest: "identity", default: "pb-mm" },
  { flag: "--base-sac", dest: "baseSac", required: true },
  { flag: "--quote-sac", dest: "quoteSac", required: true },
  { flag: "--tick-min", dest: "tickMin", type: "int", default: 1 },
  { flag: "--tick-max", dest: "tickMax", type: "int", default: 4194304 },
  { flag: "--base-code", dest: "baseCode", default: "" },
  { flag: "--base-issuer", dest: "baseIssuer", default: "" },
  { flag: "--usdc-issuer", dest: "usdcIssuer", required: true },
  { flag: "--usdc-code", dest: "usdcCode", default: "USDC" },
  { flag: "--config-dir", dest: "configDir", default: ".stellar" },
  { flag: "--network", dest: "network", default: "testnet" },
  { flag: "--rpc", dest: "rpc", default: "https://soroban-testnet.stellar.org" },
  { flag: "--horizon", dest: "horizon", default: "https://horizon-testnet.stellar.org" },
  { flag: "--levels", dest: "levels", type: "int", default: 20 },
  { flag: "--half-spread-bps", dest: "halfSpreadBps", type: "float", default: 4.0 },
  { flag: "--spacing-bps", dest: "spacingBps", type: "float", default: 5.0 },
  { flag: "--base-lots", dest: "baseLots", type: "int", default: 25 },
  { flag: "--step-lots", dest: "stepLots", type: "int", default: 12 },
  { flag: "--skew-bps", dest: "skewBps", type: "float", default: 3.0 },
  { flag: "--requote-ticks", dest: "requoteTicks", type: "int", default: 4 },
  { flag: "--touch-slots", dest: "touchSlots", type: "int", default: 3 },
  { flag: "--full-scan-every", dest: "fullScanEvery", type: "int", default: 8 },
  { flag: "--batch", dest: "batch", type: "int", default: 8 },
  { flag: "--max-places-per-cycle", dest: "maxPlacesPerCycle", type: "int", default: 6 },
  { flag: "--interval", dest: "interval", type: "float", default: 30.0 },
  { flag: "--max-feed-age", dest: "maxFeedAge", type: "float", default: 240.0 },
  { flag: "--heal-band", dest: "healBand", type: "int", default: 150 },
  { flag: "--max-heals-per-cycle", dest: "maxHealsPerCycle", type: "int", default: 6 },
  { flag: "--state", dest: "state", default: "ops/state/mm.json" },
  { flag: "--log", dest: "log", default: "ops/mm.log" },
  { flag: "--cancel-all", dest: "cancelAll", type: "bool" },
  { flag: "--cancel-on-exit", dest: "cancelOnExit", type: "bool" },
  { flag: "--pad-v2", dest: "padV2", type: "bool" },
  { flag: "--fixed-mid", dest: "fixedMid", type: "int" },
  { flag: "--walk-mid", dest: "walkMid", type: "bool" },
];

export function parseMmArgs(argv: string[]): MmArgs {
  return parseArgs<MmArgs>(argv, MM_SPECS);
}

export type MmDeps = {
  rpc?: Rpc;
  id?: Identity;
  feed?: Feed;
  views?: Views;
  log?: OpsLog;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  balances?: () => Promise<Record<string, number>>;
  place?: typeof submitPlace;
  postOnlyPlace?: typeof submitPostOnlyPlace;
};

type ReplaceItem = { nonce: number; isBid: boolean; tick: number; lots: number; slot: number };

export class MM {
  a: MmArgs;
  rpc: Rpc;
  id: Identity;
  feed: Feed;
  views: Views;
  log: OpsLog;
  state: MmState;
  tokens: ClassicToken[];
  stop = false;
  badTicks = new Map<string, number>();
  healed = new Map<string, number>();
  sizes: ApplyPadSizes | undefined;
  restores: RestoreBudget = { n: 0 };
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private balancesFn: () => Promise<Record<string, number>>;
  private placeFn: typeof submitPlace;
  private postOnlyFn: typeof submitPostOnlyPlace;
  private hex: { base: ReturnType<typeof addrToHex>; quote: ReturnType<typeof addrToHex> };
  private ownerHex: ReturnType<typeof addrToHex>;

  constructor(a: MmArgs, deps: MmDeps = {}) {
    this.a = a;
    this.rpc = deps.rpc ?? createRpc(a.rpc);
    this.id = deps.id ?? loadIdentity(a.identity, a.configDir);
    this.feed =
      deps.feed ??
      new Feed({
        fixedMid: a.fixedMid,
        walkMid: a.walkMid,
      });
    this.views = deps.views ?? createViews(this.rpc, { contract: a.contract, source: this.id.address, market: a.market, owner: this.id.address });
    this.log = deps.log ?? openLog(a.log);
    this.state = loadState(a.state);
    this.tokens = classicTokens({ baseSac: a.baseSac, quoteSac: a.quoteSac, usdcCode: a.usdcCode, usdcIssuer: a.usdcIssuer, baseCode: a.baseCode, baseIssuer: a.baseIssuer });
    this.now = deps.now ?? (() => Date.now() / 1000);
    this.sleep = deps.sleep ?? sleep;
    this.balancesFn = deps.balances ?? (() => fetchBalances(a.horizon, this.id.address));
    this.placeFn = deps.place ?? submitPlace;
    this.postOnlyFn = deps.postOnlyPlace ?? submitPostOnlyPlace;
    this.hex = tokenHex(a.baseSac, a.quoteSac);
    this.ownerHex = addrToHex(this.id.address);
  }

  ladderParams(): LadderParams {
    return {
      levels: this.a.levels,
      halfSpreadBps: this.a.halfSpreadBps,
      spacingBps: this.a.spacingBps,
      baseLots: this.a.baseLots,
      stepLots: this.a.stepLots,
    };
  }

  save(): void {
    saveState(this.a.state, this.state);
  }

  record(action: string, outcome: string, extra: Record<string, unknown> = {}) {
    return this.log.record(action, outcome, extra);
  }

  nextNonce(): number {
    const n = this.state.next_nonce;
    this.state.next_nonce = n + 1;
    return n;
  }

  bindSignals(): void {
    const stop = () => {
      this.stop = true;
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  }

  padSizes(): ApplyPadSizes | undefined {
    return this.a.padV2 ? this.sizes : undefined;
  }

  async refreshSizes(extraKeys: import("../src/engine/clientKeys").ClientKey[] = []): Promise<void> {
    if (!this.a.padV2) {
      this.sizes = undefined;
      return;
    }
    const padKeys = [...extraKeys, ...feeKeys(this.a.market, this.hex.base, this.hex.quote)];
    for (const q of Object.values(this.state.quotes)) {
      padKeys.push(...restKeys(this.a.market, q.side === "bid", q.tick));
    }
    const keys = collectUniverseXdr({
      contract: this.a.contract,
      caller: this.id.address,
      padKeys,
      tokens: this.tokens,
    });
    this.sizes = await sweepPadSizes(this.rpc, keys, { growth: 32, chunk: 100 });
  }

  async submit(label: string, extra: Record<string, unknown>, run: () => Promise<EngineResult>): Promise<SubmitPair> {
    return runSubmit(this.log, label, extra, run, {
      rpc: this.rpc,
      secret: this.id.secret,
      contract: this.a.contract,
      budget: this.restores,
    });
  }

  private simTyped(res: OutcomeInput, name: string): boolean {
    return res.kind === "typed" && res.errorName === name && res.at === "simulation";
  }

  async place(isBid: boolean, tick: number, lots: number, slot: number): Promise<string> {
    const nonce = this.nextNonce();
    const start = startTickForPostOnly(isBid, this.a.tickMin, this.a.tickMax);
    const window = emptyRestWindow();
    const flags = { post_only: true, fill_or_kill: false, no_rest: false };
    const padKeys = [
      ...restKeys(this.a.market, isBid, tick),
      orderClientKey(this.a.market, this.ownerHex, BigInt(nonce)),
      ...feeKeys(this.a.market, this.hex.base, this.hex.quote),
    ];
    const { out, res } = await this.submit("place", {}, () =>
      this.postOnlyFn(this.rpc, {
        contract: this.a.contract,
        secret: this.id.secret,
        taker: this.id.address,
        market: this.a.market,
        isBid,
        limitTick: tick,
        qtyLots: BigInt(lots),
        startTick: start,
        nonce: BigInt(nonce),
        window,
        flags,
        padKeys,
        tokens: this.tokens,
        sizes: this.padSizes(),
      }),
    );
    if (res.kind === "ok") {
      this.state.quotes[String(nonce)] = { side: isBid ? "bid" : "ask", tick, lots, slot, t: this.now() };
      this.save();
    } else if (this.simTyped(res, "LevelFull")) {
      this.badTicks.set(banKey(isBid, tick), this.now() + LEVEL_FULL_BAN_S);
    } else if (this.simTyped(res, "Crossed")) {
      await this.healTo(isBid, tick);
    }
    return out;
  }

  async replaceItems(items: ReplaceItem[]): Promise<string | undefined> {
    if (!items.length) return;
    const window = emptyRestWindow();
    if (items.length === 1) {
      const { nonce, isBid, tick, lots, slot } = items[0];
      const padKeys = [...restKeys(this.a.market, isBid, tick), ...feeKeys(this.a.market, this.hex.base, this.hex.quote)];
      const { out, res } = await this.submit("replace", {}, () =>
        submitReplace(this.rpc, {
          contract: this.a.contract,
          secret: this.id.secret,
          owner: this.id.address,
          market: this.a.market,
          nonce: BigInt(nonce),
          isBid,
          tick,
          qtyLots: BigInt(lots),
          window,
          padKeys,
          tokens: this.tokens,
          sizes: this.padSizes(),
        }),
      );
      if (res.kind === "ok") {
        this.state.quotes[String(nonce)] = { side: isBid ? "bid" : "ask", tick, lots, slot, t: this.now() };
        this.save();
      } else if (this.simTyped(res, "LevelFull")) {
        this.badTicks.set(banKey(isBid, tick), this.now() + LEVEL_FULL_BAN_S);
      } else if (this.simTyped(res, "Crossed")) {
        await this.healTo(isBid, tick);
      } else if (res.kind === "typed" && res.errorName === "UnknownOrder") {
        delete this.state.quotes[String(nonce)];
        this.save();
      }
      return out;
    }
    const body = items.map((it) => ({
      nonce: BigInt(it.nonce),
      isBid: it.isBid,
      tick: it.tick,
      qtyLots: BigInt(it.lots),
      window,
    }));
    const padKeys = [...feeKeys(this.a.market, this.hex.base, this.hex.quote)];
    for (const it of items) padKeys.push(...restKeys(this.a.market, it.isBid, it.tick));
    const { out, res } = await this.submit("replace_batch", {}, () =>
      submitReplaceBatch(this.rpc, {
        contract: this.a.contract,
        secret: this.id.secret,
        owner: this.id.address,
        market: this.a.market,
        items: body,
        padKeys,
        tokens: this.tokens,
        sizes: this.padSizes(),
      }),
    );
    if (res.kind === "ok") {
      for (const it of items) {
        this.state.quotes[String(it.nonce)] = {
          side: it.isBid ? "bid" : "ask",
          tick: it.tick,
          lots: it.lots,
          slot: it.slot,
          t: this.now(),
        };
      }
      this.save();
      return out;
    }
    for (const it of items) await this.replaceItems([it]);
    return out;
  }

  async healTo(isBid: boolean, target: number): Promise<string> {
    const b = await this.views.best(!isBid);
    if (b == null || !crosses(isBid, b, target)) return "clear";
    let lv;
    try {
      lv = await this.views.level(!isBid, b);
    } catch {
      return "view_error";
    }
    if ((lv.open_lots ?? 0) > 0) return "real_cross";
    const key = banKey(isBid, b);
    if ((this.healed.get(key) ?? 0) > this.now()) return "recent";
    this.healed.set(key, this.now() + HEAL_DEBOUNCE_S);
    const q = await this.views.quotePlace(isBid, clampHealTarget(isBid, b, target, this.a.healBand), 1);
    const healTarget = healTargetFromQuote(isBid, b, target, this.a.healBand, q.crossed);
    const nonce = this.nextNonce();
    const quoted = {
      market: this.a.market,
      ownSide: isBid,
      limitTick: healTarget,
      startTick: q.start_tick,
      crossed: q.crossed,
      tailSeq: q.tail_seq,
      taker: this.ownerHex,
      nonce: BigInt(nonce),
      base: this.hex.base,
      quote: this.hex.quote,
    };
    const outPad = pad(quoted, healTarget, { pagesForEmpty: false });
    const flags = { post_only: false, fill_or_kill: false, no_rest: true };
    const { out } = await this.submit(
      "heal",
      { side: isBid ? "bid" : "ask", phantom_tick: b, target: healTarget, phantoms: q.crossed.length },
      () =>
        this.placeFn(this.rpc, {
          contract: this.a.contract,
          secret: this.id.secret,
          taker: this.id.address,
          market: this.a.market,
          isBid,
          limitTick: healTarget,
          qtyLots: 1n,
          startTick: q.start_tick,
          nonce: BigInt(nonce),
          window: outPad.window,
          flags,
          quoted,
          tokens: this.tokens,
          padEnd: healTarget,
          pagesForEmpty: false,
        }),
    );
    return out;
  }

  async settle(nonce: number, isBid: boolean, tick: number): Promise<string> {
    const padKeys = [...feeKeys(this.a.market, this.hex.base, this.hex.quote), ...settlePageKeys(this.a.market, isBid, tick)];
    const { out, res } = await this.submit("settle", {}, () =>
      submitSettle(this.rpc, {
        contract: this.a.contract,
        secret: this.id.secret,
        owner: this.id.address,
        market: this.a.market,
        nonce: BigInt(nonce),
        padKeys,
        tokens: this.tokens,
        sizes: this.padSizes(),
      }),
    );
    if (res.kind === "ok" || (res.kind === "typed" && res.errorName === "UnknownOrder")) {
      delete this.state.quotes[String(nonce)];
      this.save();
    }
    return out;
  }

  async cancelAll(): Promise<void> {
    for (const [n, q] of Object.entries(this.state.quotes)) {
      await this.settle(Number(n), q.side === "bid", q.tick);
    }
  }

  async run(): Promise<void> {
    this.bindSignals();
    let loop = 0;
    while (!this.stop) {
      const t0 = this.now();
      try {
        await this.cycle(loop);
      } catch (e) {
        this.record("cycle", "error", { detail: repr(e).slice(-300) });
      }
      loop += 1;
      const dt = this.now() - t0;
      await this.sleep(Math.max(0, this.a.interval - dt) * 1000);
    }
    if (this.a.cancelOnExit) {
      this.record("shutdown", "cancelling", { n: Object.keys(this.state.quotes).length });
      await this.cancelAll();
    }
    this.record("shutdown", "done");
  }

  async cycle(loop: number): Promise<void> {
    this.restores.n = 0;
    const a = this.a;
    await this.feed.fetch();
    const stale = this.feed.age() > a.maxFeedAge;
    if (stale) {
      if (Object.keys(this.state.quotes).length) {
        this.record("feed", "stale", { age: Math.round(this.feed.age()), action: "cancel_all" });
        await this.cancelAll();
      } else {
        this.record("feed", "stale", { age: Math.round(this.feed.age()) });
      }
      return;
    }
    const midTick = tickOf(this.feed.last!);
    const bal = await this.balancesFn();
    if (!this.state.inv0 && Object.keys(bal).length) {
      this.state.inv0 = { xlm: bal.XLM ?? 0, usdc: bal[a.usdcCode] ?? 0 };
    }
    let skew = 0;
    const inv0 = this.state.inv0;
    if (inv0 && Object.keys(bal).length && a.skewBps > 0 && this.feed.last != null) {
      skew = inventorySkew({
        skewBps: a.skewBps,
        ladder: this.ladderParams(),
        price: this.feed.last,
        xlm: bal.XLM ?? 0,
        usdc: bal[a.usdcCode] ?? 0,
        inv0,
      });
    }
    const { bids, asks } = ladder(midTick, skew, this.ladderParams());

    const quotes = this.state.quotes;
    const bySlot = new Map<string, { n: number; q: QuoteState }>();
    for (const [ns, q] of Object.entries(quotes)) {
      bySlot.set(`${q.side}:${q.slot}`, { n: Number(ns), q });
    }
    const fullScan = loop % a.fullScanEvery === 0;
    const filled: { n: number; filled_lots: number }[] = [];
    for (const [key, cur] of [...bySlot.entries()]) {
      if (!(fullScan || cur.q.slot < a.touchSlots)) continue;
      const info = await this.views.order(cur.n);
      if (info == null) {
        delete quotes[String(cur.n)];
        bySlot.delete(key);
        continue;
      }
      if ((info.filled_lots ?? 0) > 0) {
        filled.push({ n: cur.n, filled_lots: info.filled_lots });
        cur.q.filled_lots = info.filled_lots;
      }
    }
    if (filled.length) {
      this.state.fills += filled.length;
      this.state.volume_lots += filled.reduce((s, f) => s + f.filled_lots, 0);
    }
    this.save();

    const toReplace: ReplaceItem[] = [];
    const toPlace: { isBid: boolean; tick: number; lots: number; slot: number }[] = [];
    const now = this.now();
    const sides: ["bid" | "ask", boolean, typeof bids][] = [
      ["bid", true, bids],
      ["ask", false, asks],
    ];
    for (const [sideName, isBid, sideLadder] of sides) {
      for (let slot = 0; slot < sideLadder.length; slot++) {
        let { tick, lots } = sideLadder[slot];
        if (!inTickBand(tick, this.a.tickMin, this.a.tickMax)) continue;
        tick = stepAwayFromBanned(isBid, tick, this.badTicks, now);
        const cur = bySlot.get(`${sideName}:${slot}`);
        if (!cur) {
          toPlace.push({ isBid, tick, lots, slot });
          continue;
        }
        const moved = Math.abs(cur.q.tick - tick);
        const thresh = slot < a.touchSlots ? a.requoteTicks : a.requoteTicks * 2;
        const wasFilled = filled.some((f) => f.n === cur.n);
        if (wasFilled || moved >= thresh || cur.q.lots !== lots) {
          toReplace.push({ nonce: cur.n, isBid, tick, lots, slot });
        }
      }
    }

    for (let i = 0; i < a.maxHealsPerCycle; i++) {
      const bookBa = await this.views.best(false);
      if (bookBa == null || !bids.length || bookBa > bids[0].tick) break;
      if ((await this.healTo(true, bids[0].tick)) !== "ok") break;
    }
    for (let i = 0; i < a.maxHealsPerCycle; i++) {
      const bookBb = await this.views.best(true);
      if (bookBb == null || !asks.length || bookBb < asks[0].tick) break;
      if ((await this.healTo(false, asks[0].tick)) !== "ok") break;
    }

    if (toReplace.length || toPlace.length) {
      const universe = [...toReplace.map((it) => restKeys(this.a.market, it.isBid, it.tick)).flat(), ...toPlace.map((p) => restKeys(this.a.market, p.isBid, p.tick)).flat()];
      await this.refreshSizes(universe);
    }

    for (let i = 0; i < toReplace.length; i += a.batch) {
      await this.replaceItems(toReplace.slice(i, i + a.batch));
    }
    for (const p of toPlace.slice(0, a.maxPlacesPerCycle)) {
      await this.place(p.isBid, p.tick, p.lots, p.slot);
    }

    const live = this.state.quotes;
    const bidTicks = Object.values(live).filter((q) => q.side === "bid").map((q) => q.tick);
    const askTicks = Object.values(live).filter((q) => q.side === "ask").map((q) => q.tick);
    const bb = bidTicks.length ? Math.max(...bidTicks) : null;
    const ba = askTicks.length ? Math.min(...askTicks) : null;
    const bookBb = await this.views.best(true);
    const bookBa = await this.views.best(false);
    this.record("loop", "ok", makeLoopLine({
      t: this.now(),
      loop,
      mid: this.feed.last,
      src: this.feed.source,
      mid_tick: midTick,
      skew_bps: halfEvenRound(skew * 100) / 100,
      our_bid: bb,
      our_ask: ba,
      book_bid: bookBb,
      book_ask: bookBa,
      live: Object.keys(live).length,
      n_bids: bidTicks.length,
      n_asks: askTicks.length,
      replaced: toReplace.length,
      placed: Math.min(toPlace.length, a.maxPlacesPerCycle),
      fills_total: this.state.fills,
      volume_lots: this.state.volume_lots,
      xlm: bal.XLM ?? null,
      usdc: bal[a.usdcCode] ?? null,
    }));
  }
}

export function makeLoopLine(fields: {
  t: number;
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
}): Record<string, unknown> {
  return {
    t: fields.t,
    action: "loop",
    outcome: "ok",
    loop: fields.loop,
    mid: fields.mid,
    src: fields.src,
    mid_tick: fields.mid_tick,
    skew_bps: fields.skew_bps,
    our_bid: fields.our_bid,
    our_ask: fields.our_ask,
    book_bid: fields.book_bid,
    book_ask: fields.book_ask,
    live: fields.live,
    n_bids: fields.n_bids,
    n_asks: fields.n_asks,
    replaced: fields.replaced,
    placed: fields.placed,
    fills_total: fields.fills_total,
    volume_lots: fields.volume_lots,
    xlm: fields.xlm,
    usdc: fields.usdc,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const a = parseMmArgs(argv);
  if (a.network !== "testnet") throw new Error("only testnet is supported by the ops entry points today");
  const mm = new MM(a);
  if (a.cancelAll) {
    await mm.cancelAll();
    return;
  }
  await mm.run();
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) {
  main().catch((e) => {
    process.stderr.write(String(e) + "\n");
    process.exit(1);
  });
}
