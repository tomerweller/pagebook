import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpc, type Rpc } from "../src/book";
import { addrToHex } from "../src/engine/clientKeys";
import { pad } from "../src/engine/pad";
import {
  decodePlaceResult,
  submitPlace,
  submitSettle,
  type ClassicToken,
  type EngineResult,
} from "../src/engine/submit";
import { parseArgs, type ArgSpec } from "./lib/args";
import { loadIdentity, type Identity } from "./lib/identity";
import { bandTooWide, drawTake, randInt, repr, takeLimit } from "./lib/math";
import { openLog, type OpsLog } from "./lib/opslog";
import { classicTokens, feeKeys, settlePageKeys, tokenHex } from "./lib/padkeys";
import { outcomeOf } from "./lib/outcomes";
import { createViews, type Views } from "./lib/views";

export type TraderArgs = {
  contract: string;
  market: number;
  identity: string;
  baseSac: string;
  quoteSac: string;
  usdcIssuer: string;
  usdcCode: string;
  configDir: string;
  network: string;
  rpc: string;
  minWait: number;
  maxWait: number;
  restShare: number;
  maxResting: number;
  restMinS: number;
  restMaxS: number;
  log: string;
};

export const TRADER_SPECS: ArgSpec<keyof TraderArgs & string>[] = [
  { flag: "--contract", dest: "contract", required: true },
  { flag: "--market", dest: "market", type: "int", required: true },
  { flag: "--identity", dest: "identity", default: "pb-trader" },
  { flag: "--base-sac", dest: "baseSac", required: true },
  { flag: "--quote-sac", dest: "quoteSac", required: true },
  { flag: "--usdc-issuer", dest: "usdcIssuer", required: true },
  { flag: "--usdc-code", dest: "usdcCode", default: "USDC" },
  { flag: "--config-dir", dest: "configDir", default: ".stellar" },
  { flag: "--network", dest: "network", default: "testnet" },
  { flag: "--rpc", dest: "rpc", default: "https://soroban-testnet.stellar.org" },
  { flag: "--min-wait", dest: "minWait", type: "float", default: 20 },
  { flag: "--max-wait", dest: "maxWait", type: "float", default: 75 },
  { flag: "--rest-share", dest: "restShare", type: "float", default: 0.15 },
  { flag: "--max-resting", dest: "maxResting", type: "int", default: 3 },
  { flag: "--rest-min-s", dest: "restMinS", type: "float", default: 120 },
  { flag: "--rest-max-s", dest: "restMaxS", type: "float", default: 360 },
  { flag: "--log", dest: "log", default: "ops/trader.log" },
];

export function parseTraderArgs(argv: string[]): TraderArgs {
  return parseArgs<TraderArgs>(argv, TRADER_SPECS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function detailOf(text: string, outcome: string): string {
  if (outcome === "ok") return "";
  return text.length > 460 ? text.slice(0, 300) + " ... " + text.slice(-160) : text;
}

function resultText(res: EngineResult): string {
  if (res.kind === "ok") return "";
  if ("message" in res && res.message) return res.message;
  if (res.kind === "typed") return `${res.errorName}@${res.at}`;
  if (res.kind === "footprint") return res.missingKey ?? "footprint";
  return res.kind;
}

type Resting = { tCancel: number; nonce: number; isBid: boolean; tick: number };

export type TraderDeps = {
  rpc?: Rpc;
  id?: Identity;
  views?: Views;
  log?: OpsLog;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rnd?: () => number;
};

export class Trader {
  a: TraderArgs;
  rpc: Rpc;
  id: Identity;
  views: Views;
  log: OpsLog;
  nonce: number;
  resting: Resting[] = [];
  stop = false;
  stats = { takes: 0, lots_taken: 0, rests: 0, settles: 0 };
  tokens: ClassicToken[];
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private rnd: () => number;
  private hex: { base: ReturnType<typeof addrToHex>; quote: ReturnType<typeof addrToHex> };
  private ownerHex: ReturnType<typeof addrToHex>;

  constructor(a: TraderArgs, deps: TraderDeps = {}) {
    this.a = a;
    this.rpc = deps.rpc ?? createRpc(a.rpc);
    this.id = deps.id ?? loadIdentity(a.identity, a.configDir);
    this.views = deps.views ?? createViews(this.rpc, { contract: a.contract, source: this.id.address, market: a.market, owner: this.id.address });
    this.log = deps.log ?? openLog(a.log);
    this.now = deps.now ?? (() => Date.now() / 1000);
    this.sleep = deps.sleep ?? sleep;
    this.rnd = deps.rnd ?? Math.random;
    this.nonce = Math.floor(this.now()) * 1000;
    this.tokens = classicTokens({ baseSac: a.baseSac, quoteSac: a.quoteSac, usdcCode: a.usdcCode, usdcIssuer: a.usdcIssuer });
    this.hex = tokenHex(a.baseSac, a.quoteSac);
    this.ownerHex = addrToHex(this.id.address);
  }

  bindSignals(): void {
    const stop = () => {
      this.stop = true;
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  }

  record(action: string, outcome: string, extra: Record<string, unknown> = {}) {
    return this.log.record(action, outcome, extra);
  }

  nextNonce(): number {
    this.nonce += 1;
    return this.nonce;
  }

  async place(
    isBid: boolean,
    limit: number,
    lots: number,
    noRest: boolean,
    label: string,
  ): Promise<{ out: string; ret: { rested: boolean; filled_lots: number; quote_atoms: number } | null; nonce: number | null }> {
    const q = await this.views.quotePlace(isBid, limit, lots);
    if (bandTooWide(limit, q.start_tick)) {
      this.record(label, "skip:band_too_wide", { band: Math.abs(limit - q.start_tick) });
      return { out: "skip:band_too_wide", ret: null, nonce: null };
    }
    const nonce = this.nextNonce();
    const quoted = {
      market: this.a.market,
      ownSide: isBid,
      limitTick: limit,
      startTick: q.start_tick,
      crossed: q.crossed,
      tailSeq: q.tail_seq,
      taker: this.ownerHex,
      nonce: BigInt(nonce),
      base: this.hex.base,
      quote: this.hex.quote,
    };
    const outPad = pad(quoted, limit);
    const flags = { post_only: false, fill_or_kill: false, no_rest: noRest };
    const extra = {
      side: isBid ? "bid" : "ask",
      limit,
      lots,
      quoted_fill: q.filled_lots,
      crossed: q.crossed.length,
      band: Math.abs(limit - q.start_tick) + 1,
    };
    let res: EngineResult;
    try {
      res = await submitPlace(this.rpc, {
        contract: this.a.contract,
        secret: this.id.secret,
        taker: this.id.address,
        market: this.a.market,
        isBid,
        limitTick: limit,
        qtyLots: BigInt(lots),
        startTick: q.start_tick,
        nonce: BigInt(nonce),
        window: outPad.window,
        flags,
        quoted,
        tokens: this.tokens,
        padEnd: limit,
      });
    } catch (e) {
      this.record(label, "build_error", { detail: repr(e).slice(-300), ...extra });
      return { out: "build_error", ret: null, nonce };
    }
    const out = outcomeOf(res);
    let ret: { rested: boolean; filled_lots: number; quote_atoms: number } | null = null;
    if (out === "ok" && res.kind === "ok" && res.resultMetaXdr) {
      try {
        const d = decodePlaceResult(res.resultMetaXdr);
        ret = { rested: d.rested, filled_lots: Number(d.filledLots), quote_atoms: Number(d.quoteAtoms) };
      } catch {
        ret = null;
      }
    }
    const text = resultText(res);
    const tx = "hash" in res ? res.hash ?? "" : "";
    this.record(label, out, { tx, ret, detail: detailOf(text, out), ...extra });
    return { out, ret, nonce };
  }

  async settle(nonce: number, isBid: boolean, tick: number): Promise<string> {
    const padKeys = [...feeKeys(this.a.market, this.hex.base, this.hex.quote), ...settlePageKeys(this.a.market, isBid, tick)];
    const res = await submitSettle(this.rpc, {
      contract: this.a.contract,
      secret: this.id.secret,
      owner: this.id.address,
      market: this.a.market,
      nonce: BigInt(nonce),
      padKeys,
      tokens: this.tokens,
    }).catch((e: unknown) => {
      this.record("settle", "build_error", { detail: repr(e).slice(-300), nonce });
      return { kind: "build_error" as const };
    });
    const out = outcomeOf(res);
    const text = resultText(res as EngineResult);
    const tx = "hash" in res ? res.hash ?? "" : "";
    this.record("settle", out, { tx, nonce, detail: detailOf(text, out) });
    return out;
  }

  async step(): Promise<void> {
    const a = this.a;
    const now = this.now();
    const due = this.resting.filter((r) => r.tCancel <= now);
    this.resting = this.resting.filter((r) => r.tCancel > now);
    for (const r of due) {
      if ((await this.settle(r.nonce, r.isBid, r.tick)) === "ok") this.stats.settles += 1;
    }

    const isBid = this.rnd() < 0.5;
    const bb = await this.views.best(true);
    const ba = await this.views.best(false);
    if (bb == null || ba == null) {
      this.record("book", "one_sided", { bid: bb, ask: ba });
      return;
    }
    const touch = isBid ? ba : bb;
    const r = this.rnd();
    if (r < a.restShare && this.resting.length < a.maxResting && ba - bb >= 3) {
      const tick = randInt(bb + 1, ba - 1, this.rnd);
      const lots = randInt(1, 5, this.rnd);
      const placed = await this.place(isBid, tick, lots, false, "rest");
      if (placed.out === "ok" && placed.ret?.rested && placed.nonce != null) {
        this.stats.rests += 1;
        const delay = a.restMinS + this.rnd() * (a.restMaxS - a.restMinS);
        this.resting.push({ tCancel: this.now() + delay, nonce: placed.nonce, isBid, tick });
      }
      return;
    }
    const mix = drawTake(this.rnd(), this.rnd);
    const limit = takeLimit(isBid, touch, mix.depth);
    const placed = await this.place(isBid, limit, mix.lots, true, "take");
    if (placed.out === "ok") {
      this.stats.takes += 1;
      if (placed.ret) this.stats.lots_taken += placed.ret.filled_lots;
    }
  }

  async run(): Promise<void> {
    this.bindSignals();
    while (!this.stop) {
      const t0 = this.now();
      try {
        await this.step();
      } catch (e) {
        this.record("step", "error", { detail: repr(e).slice(-300) });
      }
      this.record("stats", "tick", { ...this.stats, resting: this.resting.length });
      const wait = aUniform(this.a.minWait, this.a.maxWait, this.rnd) - (this.now() - t0);
      await this.sleep(Math.max(0, wait) * 1000);
    }
    for (const r of this.resting) await this.settle(r.nonce, r.isBid, r.tick);
    this.record("shutdown", "done");
  }
}

function aUniform(lo: number, hi: number, rnd: () => number): number {
  return lo + rnd() * (hi - lo);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const a = parseTraderArgs(argv);
  await new Trader(a).run();
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) {
  main().catch((e) => {
    process.stderr.write(String(e) + "\n");
    process.exit(1);
  });
}
