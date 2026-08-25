import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpc, type Rpc } from "../src/book";
import { addrToHex, type ClientKey } from "../src/engine/clientKeys";
import { wordOf } from "../src/decode";
import { submitPostOnlyPlace, submitReplaceBatch, type ClassicToken } from "../src/engine/submit";
import type { WindowSpec } from "../src/engine/pad";
import { parseArgs, type ArgSpec } from "./lib/args";
import { loadIdentity, type Identity } from "./lib/identity";
import { latestLedger, waitLedgers } from "./lib/ledger";
import {
  MARKET0_BASE_SAC,
  MARKET0_CODES,
  MARKET0_CONTRACT,
  MARKET0_ID,
  MARKET0_ISSUER,
  MARKET0_NONCE_BASE,
  MARKET0_QUOTE_SAC,
} from "./lib/market0";
import { emptyRestWindow, randInt, repr } from "./lib/math";
import { openLog, type OpsLog } from "./lib/opslog";
import { parseLogLines } from "./lib/logparse";
import { outcomeOf, type OutcomeInput } from "./lib/outcomes";
import { classicPairTokens, feeKeys, orderClientKey, restKeys, tokenHex } from "./lib/padkeys";
import { mapPool } from "./lib/pool";
import { percentiles } from "./lib/stats";
import { resultText, sleep } from "./lib/submitlog";
import { decodeFeeCharged } from "./lib/txdecode";
import { createViews, type Views } from "./lib/views";
import { readFileSync } from "node:fs";

export const CONTRACT = MARKET0_CONTRACT;
export const MARKET = MARKET0_ID;
export const BASE_SAC = MARKET0_BASE_SAC;
export const QUOTE_SAC = MARKET0_QUOTE_SAC;
export const ISSUER = MARKET0_ISSUER;
export const CODES = MARKET0_CODES;
export const NONCE_BASE = MARKET0_NONCE_BASE;

export function ticksFor(acctI: number): number[] {
  const ts = Array.from({ length: 32 }, (_, w) => 2048 * w + 200 + acctI * 17);
  ts.push(...Array.from({ length: 8 }, (_, w) => 2048 * w + 1200 + acctI * 17));
  return ts;
}

export type StressPhase = "seed" | "run" | "analyze";

export type StressArgs = {
  phase: StressPhase;
  accounts: number;
  ledgers: number;
  pause: number;
  extraPad: number;
  configDir: string;
  network: string;
  rpc: string;
  log: string;
};

const STRESS_SPECS: ArgSpec<string>[] = [
  { flag: "--accounts", dest: "accounts", type: "int", default: 8 },
  { flag: "--ledgers", dest: "ledgers", type: "int", default: 250 },
  { flag: "--pause", dest: "pause", type: "float", default: 1.0 },
  { flag: "--extra-pad", dest: "extraPad", type: "int", default: 28 },
  { flag: "--config-dir", dest: "configDir", default: ".stellar" },
  { flag: "--network", dest: "network", default: "testnet" },
  { flag: "--rpc", dest: "rpc", default: "https://soroban-testnet.stellar.org" },
  { flag: "--log", dest: "log", default: "ops/stress.log" },
];

const PHASES = new Set<string>(["seed", "run", "analyze"]);

export function parseStressArgs(argv: string[]): StressArgs {
  const rest = [...argv];
  let phase: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("-") && PHASES.has(rest[i])) {
      phase = rest[i];
      rest.splice(i, 1);
      break;
    }
  }
  if (!phase) throw new Error("missing required argument: phase (seed|run|analyze)");
  const flags = parseArgs<Omit<StressArgs, "phase">>(rest, STRESS_SPECS as ArgSpec<keyof Omit<StressArgs, "phase"> & string>[]);
  return { ...flags, phase: phase as StressPhase };
}

export type StressDeps = {
  rpc?: Rpc;
  ids?: Record<string, Identity>;
  views?: Record<string, Views>;
  log?: OpsLog;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rnd?: () => number;
  latest?: () => Promise<number>;
  readLog?: () => string;
};

export class Stress {
  a: StressArgs;
  rpc: Rpc;
  log: OpsLog;
  counts: Record<string, number> = {};
  tokens: ClassicToken[];
  hex: { base: ReturnType<typeof addrToHex>; quote: ReturnType<typeof addrToHex> };
  stop = false;
  private now: () => number;
  private sleepFn: (ms: number) => Promise<void>;
  private rnd: () => number;
  private latestFn: () => Promise<number>;
  private ids: Record<string, Identity>;
  private viewsCache: Record<string, Views>;
  private givenViews?: Record<string, Views>;
  private readLog: () => string;

  constructor(a: StressArgs, deps: StressDeps = {}) {
    this.a = a;
    this.rpc = deps.rpc ?? createRpc(a.rpc);
    this.log = deps.log ?? openLog(a.log);
    this.now = deps.now ?? (() => Date.now() / 1000);
    this.sleepFn = deps.sleep ?? sleep;
    this.rnd = deps.rnd ?? Math.random;
    this.latestFn = deps.latest ?? (() => latestLedger(this.rpc));
    this.ids = deps.ids ?? {};
    this.viewsCache = {};
    this.givenViews = deps.views;
    this.tokens = classicPairTokens(BASE_SAC, QUOTE_SAC, ISSUER, CODES.join(","));
    this.hex = tokenHex(BASE_SAC, QUOTE_SAC);
    this.readLog = deps.readLog ?? (() => readFileSync(a.log, "utf8"));
  }

  src(i: number): string {
    return `pb-stress${i + 1}`;
  }

  idOf(name: string): Identity {
    if (!this.ids[name]) this.ids[name] = loadIdentity(name, this.a.configDir);
    return this.ids[name];
  }

  viewsOf(name: string): Views {
    if (this.givenViews?.[name]) return this.givenViews[name];
    if (!this.viewsCache[name]) {
      const id = this.idOf(name);
      this.viewsCache[name] = createViews(this.rpc, {
        contract: CONTRACT,
        source: id.address,
        market: MARKET,
        owner: id.address,
      });
    }
    return this.viewsCache[name];
  }

  record(kw: Record<string, unknown>): void {
    const outcome = String(kw.outcome ?? "?");
    this.counts[outcome] = (this.counts[outcome] ?? 0) + 1;
    this.log.record(String(kw.action ?? ""), outcome, { ...kw, t: this.now() });
  }

  tokenPadKeys(): ClientKey[] {
    return feeKeys(MARKET, this.hex.base, this.hex.quote);
  }

  async submit(source: string, fn: string, run: () => Promise<OutcomeInput>, extra: Record<string, unknown> = {}): Promise<string | null> {
    const t0 = this.now();
    let l0: number | null = null;
    try {
      l0 = await this.latestFn();
    } catch {
      l0 = null;
    }
    let res: OutcomeInput;
    try {
      res = await run();
    } catch (e) {
      const msg = repr(e);
      const sim = /simulat/i.test(msg);
      this.record({
        acct: source,
        action: fn,
        outcome: sim ? outcomeOf({ kind: "rpc", message: msg, at: "simulation" }) : "build_error",
        detail: msg.slice(-260),
        ...extra,
      });
      return null;
    }
    const out = outcomeOf(res);
    const tx = "hash" in res ? (res as { hash?: string }).hash ?? "" : "";
    const decl = "declared" in res && res.declared ? res.declared : {};
    const text = resultText(res);
    this.record({
      acct: source,
      action: fn,
      outcome: out,
      tx,
      submit_ledger: l0,
      wall_s: Math.round((this.now() - t0) * 100) / 100,
      detail: out === "ok" ? "" : text.slice(-200),
      ...decl,
      ...extra,
    });
    return out;
  }

  async seed(): Promise<void> {
    await mapPool(
      Array.from({ length: this.a.accounts }, (_, i) => i),
      8,
      (i) => this.seedOne(i),
    );
  }

  async seedOne(i: number): Promise<void> {
    const src = this.src(i);
    const id = this.idOf(src);
    const views = this.viewsOf(src);
    const ownerHex = addrToHex(id.address);
    for (let j = 0; j < ticksFor(i).length; j++) {
      const tick = ticksFor(i)[j];
      const nonce = NONCE_BASE + i * 1000 + j;
      try {
        const live = await views.order(nonce);
        if (live) continue;
      } catch {
        /* place */
      }
      const padKeys: ClientKey[] = [
        ...restKeys(MARKET, false, tick),
        orderClientKey(MARKET, ownerHex, BigInt(nonce)),
        ...this.tokenPadKeys(),
      ];
      await this.submit(
        src,
        "place",
        () =>
          submitPostOnlyPlace(this.rpc, {
            contract: CONTRACT,
            secret: id.secret,
            taker: id.address,
            market: MARKET,
            isBid: false,
            limitTick: tick,
            qtyLots: 2n,
            startTick: 65535,
            nonce: BigInt(nonce),
            window: emptyRestWindow(),
            flags: { post_only: true, fill_or_kill: false, no_rest: false },
            padKeys,
            tokens: this.tokens,
          }),
        { seed: 1 },
      );
    }
    process.stderr.write(`${src} seeded\n`);
  }

  async batchOnce(i: number): Promise<string | null> {
    const src = this.src(i);
    const id = this.idOf(src);
    const items: { nonce: bigint; isBid: boolean; tick: number; qtyLots: bigint; window: WindowSpec }[] = [];
    const padKeys: ClientKey[] = [...this.tokenPadKeys()];
    for (let j = 0; j < ticksFor(i).length; j++) {
      const tick = ticksFor(i)[j];
      const nonce = NONCE_BASE + i * 1000 + j;
      items.push({
        nonce: BigInt(nonce),
        isBid: false,
        tick,
        qtyLots: BigInt(randInt(2, 5, this.rnd)),
        window: emptyRestWindow(),
      });
      padKeys.push({ t: "Level", market: MARKET, isBid: false, tick });
      padKeys.push({ t: "TickWord", market: MARKET, isBid: false, word: wordOf(tick) });
      padKeys.push({ t: "LevelPage", market: MARKET, isBid: false, tick, page: 0 });
    }
    padKeys.push({ t: "TickSummary", market: MARKET, isBid: false });
    padKeys.push({ t: "BestTick", market: MARKET, isBid: false });
    padKeys.push({ t: "BestTick", market: MARKET, isBid: true });
    for (const tick of ticksFor((i + 1) % this.a.accounts).slice(0, this.a.extraPad)) {
      padKeys.push({ t: "Level", market: MARKET, isBid: false, tick });
    }
    return this.submit(src, "replace_batch", () =>
      submitReplaceBatch(this.rpc, {
        contract: CONTRACT,
        secret: id.secret,
        owner: id.address,
        market: MARKET,
        items,
        padKeys,
        tokens: this.tokens,
      }),
    );
  }

  async run(): Promise<Record<string, unknown>> {
    const start = await this.latestFn();
    const end = start + this.a.ledgers;
    this.stop = false;
    const workers = Array.from({ length: this.a.accounts }, (_, i) => this.worker(i));
    await waitLedgers({
      latest: this.latestFn,
      start,
      count: this.a.ledgers,
      intervalMs: 10_000,
      progressEvery: 30,
      onProgress: (cur, e) =>
        this.record({
          acct: "stress",
          action: "progress",
          outcome: "tick",
          detail: `ledger ${cur}/${e} counts=${JSON.stringify(this.counts)}`,
        }),
      sleep: this.sleepFn,
      onPollError: () => undefined,
    });
    this.stop = true;
    await this.sleepFn(20_000);
    await Promise.all(workers);
    const summary = { start, end, counts: this.counts };
    this.record({ acct: "stress", action: "done", outcome: "summary", detail: JSON.stringify(summary) });
    process.stdout.write(JSON.stringify(summary, null, 1) + "\n");
    return summary;
  }

  private async worker(i: number): Promise<void> {
    while (!this.stop) {
      await this.batchOnce(i);
      const t0 = Date.now();
      while (Date.now() - t0 < this.a.pause * 1000 && !this.stop) {
        await this.sleepFn(Math.min(200, this.a.pause * 1000));
      }
    }
  }

  async analyze(): Promise<Record<string, unknown>> {
    const recs = [];
    for (const d of parseLogLines(this.readLog())) {
      if (d.action === "replace_batch" && d.outcome === "ok" && d.tx) recs.push(d);
    }
    process.stderr.write(`${recs.length} landed batches\n`);
    const got = await mapPool(recs, 8, async (r) => {
      try {
        const g = await this.rpc.getTransaction(String(r.tx));
        const fee = g.resultXdr ? decodeFeeCharged(g.resultXdr) : null;
        return { led: g.ledger ?? null, fee };
      } catch {
        return { led: null, fee: null };
      }
    });
    const per = new Map<number, { n: number; rw: number; wb: number; instr: number; fee: number }>();
    const delays: number[] = [];
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      const { led, fee } = got[i];
      if (led == null) continue;
      const p = per.get(led) ?? { n: 0, rw: 0, wb: 0, instr: 0, fee: 0 };
      p.n += 1;
      p.rw += Number(r.rw ?? 0);
      p.wb += Number(r.wb ?? 0);
      p.instr += Number(r.instr ?? 0);
      p.fee += fee ?? 0;
      per.set(led, p);
      if (r.submit_ledger != null) delays.push(led - Number(r.submit_ledger));
    }
    const vals = [...per.values()];
    const out = {
      ledgers_with_batches: per.size,
      per_ledger: {
        n: percentiles(vals.map((p) => p.n)),
        rw_declared: percentiles(vals.map((p) => p.rw)),
        write_bytes_declared: percentiles(vals.map((p) => p.wb)),
        instr_declared: percentiles(vals.map((p) => p.instr)),
      },
      inclusion_delay_ledgers: percentiles(delays),
      wall_s: percentiles(recs.map((r) => Number(r.wall_s ?? 0))),
      fee_charged: percentiles(got.map((g) => g.fee).filter((f): f is number => f != null)),
    };
    process.stdout.write(JSON.stringify(out, null, 1) + "\n");
    const top = [...per.entries()].sort((a, b) => b[1].wb - a[1].wb).slice(0, 10);
    process.stdout.write("busiest ledgers (by our declared write bytes):\n");
    for (const [led, p] of top) {
      process.stdout.write(
        `  ${led}: ${p.n} batches, rw ${p.rw} (${(p.rw / 10).toFixed(0)}% of cap), wb ${p.wb.toLocaleString("en-US")} (${(p.wb / 2867.2).toFixed(0)}% of cap), instr ${(p.instr / 1e6).toFixed(0)}M (${(p.instr / 5.8e6).toFixed(0)}% of cap)\n`,
      );
    }
    return out;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const a = parseStressArgs(argv);
  if (a.network !== "testnet") throw new Error("only testnet is supported by the ops entry points today");
  const s = new Stress(a);
  if (a.phase === "seed") await s.seed();
  else if (a.phase === "run") await s.run();
  else await s.analyze();
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) {
  main().catch((e) => {
    process.stderr.write(String(e) + "\n");
    process.exit(1);
  });
}