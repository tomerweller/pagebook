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
  type PlaceFlags,
} from "../src/engine/submit";
import { parseArgs, type ArgSpec } from "./lib/args";
import { loadIdentity, type Identity } from "./lib/identity";
import { latestLedger, waitLedgers } from "./lib/ledger";
import { clipDetail } from "./lib/logparse";
import { emptyRestWindow, randInt, repr, startTickForPostOnly } from "./lib/math";
import { openLog, type OpsLog } from "./lib/opslog";
import { outcomeOf, type OutcomeInput } from "./lib/outcomes";
import { classicPairTokens, feeKeys, orderClientKey, restKeys, settlePageKeys, tokenHex } from "./lib/padkeys";
import { resultText, sleep } from "./lib/submitlog";
import { createViews, type Views } from "./lib/views";

export type SoakArgs = {
  contract: string;
  market: number;
  base: string;
  quote: string;
  issuer: string;
  codes: string;
  configDir: string;
  network: string;
  rpc: string;
  ledgers: number;
  mid: number;
  tickMin: number;
  tickMax: number;
  log: string;
  taker: string;
  maker: string;
  spam: string;
  storm: string;
};

export const SOAK_SPECS: ArgSpec<keyof SoakArgs & string>[] = [
  { flag: "--contract", dest: "contract", required: true },
  { flag: "--market", dest: "market", type: "int", default: 0 },
  { flag: "--base", dest: "base", required: true },
  { flag: "--quote", dest: "quote", required: true },
  { flag: "--issuer", dest: "issuer", required: true },
  { flag: "--codes", dest: "codes", required: true },
  { flag: "--config-dir", dest: "configDir", default: ".stellar" },
  { flag: "--network", dest: "network", default: "testnet" },
  { flag: "--rpc", dest: "rpc", default: "https://soroban-testnet.stellar.org" },
  { flag: "--ledgers", dest: "ledgers", type: "int", default: 2000 },
  { flag: "--mid", dest: "mid", type: "int", default: 100 },
  { flag: "--tick-min", dest: "tickMin", type: "int", default: 1 },
  { flag: "--tick-max", dest: "tickMax", type: "int", default: 65536 },
  { flag: "--log", dest: "log", default: "ops/soak.log" },
  { flag: "--taker", dest: "taker", default: "pb-taker" },
  { flag: "--maker", dest: "maker", default: "pb-maker" },
  { flag: "--spam", dest: "spam", default: "pb-spam" },
  { flag: "--storm", dest: "storm", default: "pb-storm" },
];

export function parseSoakArgs(argv: string[]): SoakArgs {
  return parseArgs<SoakArgs>(argv, SOAK_SPECS);
}

export type SoakRole = "pb-taker" | "pb-maker" | "pb-spam" | "pb-storm" | "soak";

export type SoakDeps = {
  rpc?: Rpc;
  ids?: Record<string, Identity>;
  views?: Record<string, Views>;
  log?: OpsLog;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rnd?: () => number;
  latest?: () => Promise<number>;
};

type Live = { nonce: number; isBid: boolean; tick: number };

export function soakLine(role: string, action: string, outcome: string, detail: string, t: number): Record<string, unknown> {
  return { t, role, action, outcome, detail: clipDetail(detail) };
}

export class Soak {
  a: SoakArgs;
  rpc: Rpc;
  ids: Record<string, Identity>;
  views: Record<string, Views>;
  log: OpsLog;
  tokens: ClassicToken[];
  counts: Record<string, number> = {};
  stop = false;
  nonce: Record<string, number> = {};
  private now: () => number;
  private sleepFn: (ms: number) => Promise<void>;
  private rnd: () => number;
  private latestFn: () => Promise<number>;
  private hex: { base: ReturnType<typeof addrToHex>; quote: ReturnType<typeof addrToHex> };

  constructor(a: SoakArgs, deps: SoakDeps = {}) {
    this.a = a;
    this.rpc = deps.rpc ?? createRpc(a.rpc);
    const names = [a.taker, a.maker, a.spam, a.storm];
    this.ids = deps.ids ?? Object.fromEntries(names.map((n) => [n, loadIdentity(n, a.configDir)]));
    this.views =
      deps.views ??
      Object.fromEntries(
        names.map((n) => [
          n,
          createViews(this.rpc, {
            contract: a.contract,
            source: this.ids[n].address,
            market: a.market,
            owner: this.ids[n].address,
          }),
        ]),
      );
    this.log = deps.log ?? openLog(a.log);
    this.tokens = classicPairTokens(a.base, a.quote, a.issuer, a.codes);
    this.now = deps.now ?? (() => Date.now() / 1000);
    this.sleepFn = deps.sleep ?? sleep;
    this.rnd = deps.rnd ?? Math.random;
    this.latestFn = deps.latest ?? (() => latestLedger(this.rpc));
    this.hex = tokenHex(a.base, a.quote);
    const seed = (Math.floor(this.now()) % 1_000_000) * 1000;
    for (const n of names) this.nonce[n] = seed;
  }

  bindSignals(): void {
    const stop = () => {
      this.stop = true;
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  }

  record(role: string, action: string, outcome: string, detail = ""): void {
    this.counts[outcome] = (this.counts[outcome] ?? 0) + 1;
    const line = soakLine(role, action, outcome, detail, this.now());
    this.log.record(action, outcome, { role: line.role, detail: line.detail, t: line.t });
  }

  nextNonce(role: string): number {
    this.nonce[role] += 1;
    return this.nonce[role];
  }

  private ownerHex(role: string) {
    return addrToHex(this.ids[role].address);
  }

  async sleepFor(s: number): Promise<void> {
    const ms = s * 1000;
    const step = 200;
    const t0 = Date.now();
    while (Date.now() - t0 < ms && !this.stop) {
      await this.sleepFn(Math.min(step, ms - (Date.now() - t0)));
    }
  }

  async submit(role: string, fn: string, run: () => Promise<OutcomeInput>): Promise<string> {
    let res: OutcomeInput;
    try {
      res = await run();
    } catch (e) {
      this.record(role, fn, "build_error", repr(e));
      return "build_error";
    }
    const out = outcomeOf(res);
    const tx = "hash" in res ? (res as { hash?: string }).hash ?? "" : "";
    const text = resultText(res);
    const detail = tx ? tx + (text ? " " + text.slice(-160) : "") : text;
    this.record(role, fn, out, detail);
    return out;
  }

  async best(role: string, isBid: boolean): Promise<number | null> {
    return this.views[role].best(isBid);
  }

  async place(role: string, isBid: boolean, limit: number, qty: number, flags: PlaceFlags, bandPad: boolean): Promise<{ out: string; nonce: number }> {
    const nonce = this.nextNonce(role);
    const id = this.ids[role];
    if (bandPad) {
      const q = await this.views[role].quotePlace(isBid, limit, qty);
      const quoted = {
        market: this.a.market,
        ownSide: isBid,
        limitTick: limit,
        startTick: q.start_tick,
        crossed: q.crossed,
        tailSeq: q.tail_seq,
        taker: this.ownerHex(role),
        nonce: BigInt(nonce),
        base: this.hex.base,
        quote: this.hex.quote,
      };
      const outPad = pad(quoted, limit);
      const out = await this.submit(role, "place", () =>
        submitPlace(this.rpc, {
          contract: this.a.contract,
          secret: id.secret,
          taker: id.address,
          market: this.a.market,
          isBid,
          limitTick: limit,
          qtyLots: BigInt(qty),
          startTick: q.start_tick,
          nonce: BigInt(nonce),
          window: outPad.window,
          flags,
          quoted,
          tokens: this.tokens,
          padEnd: limit,
        }),
      );
      return { out, nonce };
    }
    const padKeys = [
      ...restKeys(this.a.market, isBid, limit),
      orderClientKey(this.a.market, this.ownerHex(role), BigInt(nonce)),
      ...feeKeys(this.a.market, this.hex.base, this.hex.quote),
    ];
    const out = await this.submit(role, "place", () =>
      submitPostOnlyPlace(this.rpc, {
        contract: this.a.contract,
        secret: id.secret,
        taker: id.address,
        market: this.a.market,
        isBid,
        limitTick: limit,
        qtyLots: BigInt(qty),
        startTick: startTickForPostOnly(isBid, this.a.tickMin, this.a.tickMax),
        nonce: BigInt(nonce),
        window: emptyRestWindow(),
        flags,
        padKeys,
        tokens: this.tokens,
      }),
    );
    return { out, nonce };
  }

  async settle(role: string, nonce: number, isBid: boolean, tick: number): Promise<string> {
    const id = this.ids[role];
    const padKeys = [...feeKeys(this.a.market, this.hex.base, this.hex.quote), ...settlePageKeys(this.a.market, isBid, tick)];
    return this.submit(role, "settle", () =>
      submitSettle(this.rpc, {
        contract: this.a.contract,
        secret: id.secret,
        owner: id.address,
        market: this.a.market,
        nonce: BigInt(nonce),
        padKeys,
        tokens: this.tokens,
      }),
    );
  }

  async takerLoop(): Promise<void> {
    const role = this.a.taker;
    while (!this.stop) {
      const isBid = this.rnd() < 0.5;
      const b = await this.best(role, !isBid);
      if (b == null) {
        await this.sleepFor(4);
        continue;
      }
      const limit = isBid ? b + randInt(0, 3, this.rnd) : Math.max(1, b - randInt(0, 3, this.rnd));
      const qty = randInt(1, 4, this.rnd);
      await this.place(role, isBid, limit, qty, { post_only: false, fill_or_kill: false, no_rest: this.rnd() < 0.5 }, true);
      await this.sleepFor(1 + this.rnd() * 3);
    }
  }

  async makerLoop(): Promise<void> {
    const role = this.a.maker;
    const mid = this.a.mid;
    let live: Live[] = [];
    const settleLater: { t0: number; orders: Live[] }[] = [];
    while (!this.stop) {
      const side = this.rnd() < 0.5;
      const tick = !side ? mid + randInt(1, 5, this.rnd) : mid - randInt(1, 5, this.rnd);
      const { out, nonce } = await this.place(role, side, tick, randInt(2, 6, this.rnd), { post_only: true, fill_or_kill: false, no_rest: false }, false);
      if (out === "ok") live.push({ nonce, isBid: side, tick });
      if (live.length >= 6) {
        const batch = live.slice(0, 6);
        const items = batch.map((o) => {
          let nt = o.tick + (this.rnd() < 0.5 ? 1 : -1);
          if (nt < 1) nt = o.tick;
          return {
            nonce: BigInt(o.nonce),
            isBid: o.isBid,
            tick: nt,
            qtyLots: BigInt(randInt(2, 6, this.rnd)),
            window: emptyRestWindow(),
          };
        });
        const padKeys = [...feeKeys(this.a.market, this.hex.base, this.hex.quote)];
        for (const it of items) padKeys.push(...restKeys(this.a.market, it.isBid, it.tick));
        const id = this.ids[role];
        const bout = await this.submit(role, "replace_batch", () =>
          submitReplaceBatch(this.rpc, {
            contract: this.a.contract,
            secret: id.secret,
            owner: id.address,
            market: this.a.market,
            items,
            padKeys,
            tokens: this.tokens,
          }),
        );
        if (bout === "ok") {
          settleLater.push({
            t0: this.now(),
            orders: items.map((it) => ({ nonce: Number(it.nonce), isBid: it.isBid, tick: it.tick })),
          });
        } else {
          settleLater.push({ t0: this.now(), orders: batch });
        }
        live = live.slice(6);
      }
      const now = this.now();
      const due = settleLater.filter((x) => now - x.t0 > 40);
      for (let i = settleLater.length - 1; i >= 0; i--) {
        if (now - settleLater[i].t0 > 40) settleLater.splice(i, 1);
      }
      for (const g of due) {
        for (const o of g.orders) await this.settle(role, o.nonce, o.isBid, o.tick);
      }
      await this.sleepFor(2 + this.rnd() * 4);
    }
  }

  async spamLoop(): Promise<void> {
    const role = this.a.spam;
    while (!this.stop) {
      const ba = await this.best(role, false);
      const bb = await this.best(role, true);
      if (ba == null || bb == null || ba - bb < 2) {
        await this.sleepFor(5);
        continue;
      }
      const inside = bb + 1;
      const { out, nonce } = await this.place(role, true, inside, 1, { post_only: true, fill_or_kill: false, no_rest: false }, false);
      if (out === "ok") {
        await this.sleepFor(1 + this.rnd() * 2);
        const nt = Math.max(1, bb - 20);
        const id = this.ids[role];
        const padKeys = [...feeKeys(this.a.market, this.hex.base, this.hex.quote), ...restKeys(this.a.market, true, nt)];
        await this.submit(role, "replace", () =>
          submitReplace(this.rpc, {
            contract: this.a.contract,
            secret: id.secret,
            owner: id.address,
            market: this.a.market,
            nonce: BigInt(nonce),
            isBid: true,
            tick: nt,
            qtyLots: 1n,
            window: emptyRestWindow(),
            padKeys,
            tokens: this.tokens,
          }),
        );
      }
      await this.sleepFor(3 + this.rnd() * 5);
    }
  }

  async stormLoop(): Promise<void> {
    const role = this.a.storm;
    let pending: { t0: number; nonce: number; tick: number }[] = [];
    while (!this.stop) {
      const ba = await this.best(role, false);
      if (ba == null) {
        await this.sleepFor(5);
        continue;
      }
      for (let i = 0; i < randInt(3, 8, this.rnd); i++) {
        for (let k = 0; k < 4; k++) {
          const { out, nonce } = await this.place(role, false, ba + k, 1, { post_only: true, fill_or_kill: false, no_rest: false }, false);
          if (out === "ok") pending.push({ t0: this.now(), nonce, tick: ba + k });
          if (out !== "sim:typed:LevelFull") break;
        }
      }
      const now = this.now();
      const due = pending.filter((p) => now - p.t0 > 45);
      pending = pending.filter((p) => now - p.t0 <= 45);
      for (const p of due) await this.settle(role, p.nonce, false, p.tick);
      await this.sleepFor(8 + this.rnd() * 12);
    }
  }

  async run(): Promise<Record<string, unknown>> {
    this.bindSignals();
    const start = await this.latestFn();
    const loops = [this.takerLoop(), this.makerLoop(), this.spamLoop(), this.stormLoop()];
    await waitLedgers({
      latest: this.latestFn,
      start,
      count: this.a.ledgers,
      intervalMs: 15_000,
      progressEvery: 100,
      onProgress: (cur, e) => this.record("soak", "progress", "tick", `ledger ${cur}/${e} counts=${JSON.stringify(this.counts)}`),
      sleep: this.sleepFn,
    });
    this.stop = true;
    await Promise.all(loops);
    const summary = { start_ledger: start, end_ledger: await this.latestFn(), counts: this.counts };
    this.record("soak", "done", "summary", JSON.stringify(summary));
    process.stdout.write(JSON.stringify(summary, null, 1) + "\n");
    return summary;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const a = parseSoakArgs(argv);
  if (a.network !== "testnet") throw new Error("only testnet is supported by the ops entry points today");
  await new Soak(a).run();
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) {
  main().catch((e) => {
    process.stderr.write(String(e) + "\n");
    process.exit(1);
  });
}