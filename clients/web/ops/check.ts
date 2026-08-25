import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpc, type Rpc } from "../src/book";
import { parseArgs, type ArgSpec } from "./lib/args";
import { Feed } from "./lib/feed";
import { loadIdentity } from "./lib/identity";
import { parseLogLines, type OpsLogRecord } from "./lib/logparse";
import { tickOf } from "./lib/math";
import { createViews, type Views } from "./lib/views";

export type CheckArgs = {
  contract: string;
  market: number;
  identity: string;
  configDir: string;
  network: string;
  rpc: string;
  log: string;
  state: string;
  traderLog: string;
  maxLoopAge: number;
  maxMidDevBps: number;
  maxTouchBps: number;
  throughMidTolBps: number;
  minXlm: number;
  window: number;
  maxTraderAge: number;
};

export const CHECK_SPECS: ArgSpec<keyof CheckArgs & string>[] = [
  { flag: "--contract", dest: "contract", required: true },
  { flag: "--market", dest: "market", type: "int", required: true },
  { flag: "--identity", dest: "identity", default: "pb-mm" },
  { flag: "--config-dir", dest: "configDir", default: ".stellar" },
  { flag: "--network", dest: "network", default: "testnet" },
  { flag: "--rpc", dest: "rpc", default: "https://soroban-testnet.stellar.org" },
  { flag: "--log", dest: "log", default: "ops/mm.log" },
  { flag: "--state", dest: "state", default: "ops/state/mm.json" },
  { flag: "--trader-log", dest: "traderLog", default: "ops/trader.log" },
  { flag: "--max-loop-age", dest: "maxLoopAge", type: "float", default: 300 },
  { flag: "--max-mid-dev-bps", dest: "maxMidDevBps", type: "float", default: 50 },
  { flag: "--max-touch-bps", dest: "maxTouchBps", type: "float", default: 40 },
  { flag: "--through-mid-tol-bps", dest: "throughMidTolBps", type: "float", default: 15 },
  { flag: "--min-xlm", dest: "minXlm", type: "float", default: 2000 },
  { flag: "--window", dest: "window", type: "float", default: 3600 },
  { flag: "--max-trader-age", dest: "maxTraderAge", type: "float", default: 600 },
];

export function parseCheckArgs(argv: string[]): CheckArgs {
  return parseArgs<CheckArgs>(argv, CHECK_SPECS);
}

const MM_BAD = new Set(["footprint", "trapped:unknown", "build_error", "sign_error", "resource_limit", "soroban_invalid"]);

export function isMmBadOutcome(outcome: string): boolean {
  if (MM_BAD.has(outcome)) return true;
  return outcome.startsWith("typed:") && !outcome.includes("Crossed");
}

export function isTraderBadOutcome(outcome: string): boolean {
  if (outcome === "error" || MM_BAD.has(outcome)) return true;
  return outcome.startsWith("typed:") && !outcome.includes("Crossed");
}

export type CheckDeps = {
  now?: () => number;
  readFile?: (path: string) => string | null;
  exists?: (path: string) => boolean;
  feed?: Feed;
  views?: Views;
  rpc?: Rpc;
};

export type CheckResult = {
  ok: boolean;
  line: string;
  alerts: string[];
  notes: string[];
  summary: Record<string, unknown>;
};

type QuoteRow = { side?: string; tick?: number };

export async function runCheck(a: CheckArgs, deps: CheckDeps = {}): Promise<CheckResult> {
  const alerts: string[] = [];
  const notes: string[] = [];
  const now = deps.now ?? (() => Date.now() / 1000);
  const tnow = now();
  const readFile =
    deps.readFile ??
    ((path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch (e) {
        if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "ENOENT") return null;
        throw e;
      }
    });
  const exists = deps.exists ?? existsSync;

  let lastLoop: OpsLogRecord | null = null;
  const outcomes = new Map<string, number>();
  let heals = 0;
  const mmText = readFile(a.log);
  if (mmText == null) {
    alerts.push("no log");
  } else {
    for (const d of parseLogLines(mmText)) {
      if (d.action === "loop") lastLoop = d;
      if (tnow - (d.t ?? 0) <= a.window && d.action !== "loop") {
        const key = `${d.action ?? ""}\0${d.outcome ?? ""}`;
        outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
        if (d.action === "heal") heals += 1;
      }
    }
  }
  if (lastLoop == null) {
    alerts.push("no loop line yet");
  } else {
    const age = tnow - Number(lastLoop.t ?? 0);
    if (age > a.maxLoopAge) alerts.push(`bot stale: last loop ${Math.floor(age)}s ago`);
  }

  const bad: Record<string, number> = {};
  let okN = 0;
  let simRej = 0;
  let applyRej = 0;
  for (const [key, v] of outcomes) {
    const [action, outcome] = key.split("\0");
    if (isMmBadOutcome(outcome)) bad[`${action}/${outcome}`] = v;
    if (outcome === "ok") okN += v;
    if (outcome.startsWith("sim:")) simRej += v;
    if (outcome.startsWith("typed:")) applyRej += v;
  }
  if (Object.keys(bad).length) alerts.push("bad outcomes in window: " + JSON.stringify(bad));

  const feed = deps.feed ?? new Feed();
  const p = await feed.fetch();
  if (p == null) notes.push("feed unavailable now");
  else if (lastLoop && lastLoop.mid != null) {
    const mid = Number(lastLoop.mid);
    const dev = (Math.abs(mid - p) / p) * 1e4;
    if (dev > a.maxMidDevBps) alerts.push(`bot mid ${mid} vs feed ${p}: ${dev.toFixed(0)} bps`);
  }

  let state: { quotes?: Record<string, QuoteRow> } = {};
  if (exists(a.state)) {
    const raw = readFile(a.state);
    if (raw != null) state = JSON.parse(raw) as { quotes?: Record<string, QuoteRow> };
  }
  const quotes = state.quotes ?? {};
  const bids = Object.values(quotes).filter((q) => q.side === "bid").map((q) => Number(q.tick));
  const asks = Object.values(quotes).filter((q) => q.side === "ask").map((q) => Number(q.tick));
  const ourBid = bids.length ? Math.max(...bids) : null;
  const ourAsk = asks.length ? Math.min(...asks) : null;
  if (p != null && ourBid != null && ourAsk != null) {
    const midTick = tickOf(p);
    if (ourBid >= ourAsk) alerts.push(`own quotes crossed: bid ${ourBid} ask ${ourAsk}`);
    const tol = Math.floor((midTick * a.throughMidTolBps) / 1e4);
    if (ourBid >= midTick + tol || ourAsk <= midTick - tol) {
      alerts.push(`quote through the mid: bid ${ourBid} ask ${ourAsk} mid ${midTick}`);
    } else if (ourBid >= midTick || ourAsk <= midTick) {
      notes.push(
        `touch at/through the instantaneous mid (bid ${ourBid} ask ${ourAsk} mid ${midTick}); within ${a.throughMidTolBps} bps tolerance`,
      );
    }
    const tb = ((midTick - ourBid) / midTick) * 1e4;
    const ta = ((ourAsk - midTick) / midTick) * 1e4;
    if (tb > a.maxTouchBps || ta > a.maxTouchBps) {
      alerts.push(`touch far from mid: bid ${tb.toFixed(0)} bps, ask ${ta.toFixed(0)} bps`);
    }
  } else if (lastLoop != null && tnow - Number(lastLoop.t ?? 0) < a.maxLoopAge && (!bids.length || !asks.length)) {
    alerts.push(`one-sided or empty ladder: ${bids.length} bids, ${asks.length} asks`);
  }

  let views = deps.views;
  if (!views) {
    const rpc = deps.rpc ?? createRpc(a.rpc);
    const id = loadIdentity(a.identity, a.configDir);
    views = createViews(rpc, { contract: a.contract, source: id.address, market: a.market, owner: id.address });
  }
  let bookBid: number | null = null;
  let bookAsk: number | null = null;
  try {
    bookBid = await views.best(true);
    bookAsk = await views.best(false);
  } catch (e) {
    notes.push(`best view error: ${String(e).slice(-80)}`);
  }
  if (bookBid != null && bookAsk != null && bookBid >= bookAsk) {
    try {
      const lb = await views.level(true, bookBid);
      const la = await views.level(false, bookAsk);
      if ((lb.open_lots ?? 0) > 0 && (la.open_lots ?? 0) > 0) {
        alerts.push(`book crossed for real: bid ${bookBid} (${lb.open_lots} lots) ask ${bookAsk} (${la.open_lots} lots)`);
      } else {
        notes.push(
          `recorded bests cross via a phantom (bid ${bookBid}/${lb.open_lots} lots, ask ${bookAsk}/${la.open_lots} lots)`,
        );
      }
    } catch (e) {
      notes.push(`level view error: ${String(e).slice(-80)}`);
    }
  }

  let trader: Record<string, number> | null = null;
  if (exists(a.traderLog)) {
    const tc = new Map<string, number>();
    let lots = 0;
    let lastT = 0;
    const ttext = readFile(a.traderLog) ?? "";
    for (const d of parseLogLines(ttext)) {
      lastT = Math.max(lastT, d.t ?? 0);
      if (tnow - (d.t ?? 0) > a.window || d.action === "stats") continue;
      const key = `${d.action ?? ""}\0${d.outcome ?? ""}`;
      tc.set(key, (tc.get(key) ?? 0) + 1);
      if (d.action === "take" && d.outcome === "ok" && d.ret && typeof d.ret === "object") {
        lots += Number((d.ret as { filled_lots?: number }).filled_lots ?? 0);
      }
    }
    const tbad: Record<string, number> = {};
    let takesOk = 0;
    let restsOk = 0;
    let settlesOk = 0;
    let tSim = 0;
    let tApply = 0;
    for (const [key, v] of tc) {
      const [action, outcome] = key.split("\0");
      if (isTraderBadOutcome(outcome)) tbad[`${action}/${outcome}`] = v;
      if (action === "take" && outcome === "ok") takesOk = v;
      if (action === "rest" && outcome === "ok") restsOk = v;
      if (action === "settle" && outcome === "ok") settlesOk = v;
      if (outcome.startsWith("sim:")) tSim += v;
      if (outcome.startsWith("typed:")) tApply += v;
    }
    if (Object.keys(tbad).length) alerts.push("trader bad outcomes in window: " + JSON.stringify(tbad));
    if (lastT && tnow - lastT > a.maxTraderAge) alerts.push(`trader stale: last line ${Math.floor(tnow - lastT)}s ago`);
    trader = {
      takes_ok: takesOk,
      lots_taken: lots,
      rests_ok: restsOk,
      settles_ok: settlesOk,
      sim_rejected: tSim,
      apply_rejected: tApply,
    };
  }

  const xlm = lastLoop && lastLoop.xlm != null ? Number(lastLoop.xlm) : null;
  if (xlm != null && xlm < a.minXlm) alerts.push(`XLM reserve low: ${xlm}`);

  const summary = {
    feed: p,
    bot_mid: lastLoop && lastLoop.mid != null ? lastLoop.mid : null,
    loop_age_s: lastLoop ? Math.floor(tnow - Number(lastLoop.t ?? 0)) : null,
    live: Object.keys(quotes).length,
    our_bid: ourBid,
    our_ask: ourAsk,
    book_bid: bookBid,
    book_ask: bookAsk,
    fills_total: lastLoop && lastLoop.fills_total != null ? lastLoop.fills_total : null,
    volume_lots: lastLoop && lastLoop.volume_lots != null ? lastLoop.volume_lots : null,
    xlm,
    usdc: lastLoop && lastLoop.usdc != null ? lastLoop.usdc : null,
    last_hour: { ok: okN, sim_rejected: simRej, apply_rejected: applyRej, heals },
    trader_last_hour: trader,
  };

  let line: string;
  if (alerts.length) {
    line = "MM ALERT " + alerts.join("; ") + " | " + JSON.stringify(summary) + (notes.length ? " | " + notes.join("; ") : "");
  } else {
    line = "MM OK " + JSON.stringify(summary) + (notes.length ? " | " + notes.join("; ") : "");
  }
  return { ok: alerts.length === 0, line, alerts, notes, summary };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const a = parseCheckArgs(argv);
  if (a.network !== "testnet") throw new Error("only testnet is supported by the ops entry points today");
  const r = await runCheck(a);
  process.stdout.write(r.line + "\n");
  return r.ok ? 0 : 1;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) {
  main()
    .then((code) => {
      if (code) process.exit(code);
    })
    .catch((e) => {
      process.stderr.write(String(e) + "\n");
      process.exit(1);
    });
}