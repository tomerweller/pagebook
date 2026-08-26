import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpc, type Rpc } from "../src/book";
import { keyStr, toLedgerKey, type ClientKey } from "../src/engine/clientKeys";
import { extendKeys, restoreKeys } from "../src/engine/submit";
import { wordOf } from "../src/decode";
import type { KeyLiveness } from "../src/engine/txdata";
import { parseArgs, type ArgSpec } from "./lib/args";
import { withTimeout } from "./check";
import { loadIdentity, type Identity } from "./lib/identity";
import { openLog, type OpsLog } from "./lib/opslog";
import { classifyLiveness, sweepPadSizes, tokenHex } from "./lib/padkeys";
import { outcomeOf } from "./lib/outcomes";
import { createViews, type Views } from "./lib/views";

export const DEFAULT_WORD_SPAN = 2;
export const DEFAULT_TICK_SPAN = 400;
export const DEFAULT_HORIZON_LEDGERS = 51_840;
export const DEFAULT_EXTEND_LEDGERS = 500_000;
export const EXTEND_BATCH = 90;

export type KeepaliveArgs = {
  contract: string;
  market: number;
  identity: string;
  baseSac: string;
  quoteSac: string;
  configDir: string;
  network: string;
  rpc: string;
  wordSpan: number;
  tickSpan: number;
  horizonLedgers: number;
  extendLedgers: number;
  dryRun: boolean;
  log: string;
};

export const KEEPALIVE_SPECS: ArgSpec<keyof KeepaliveArgs & string>[] = [
  { flag: "--contract", dest: "contract", required: true },
  { flag: "--market", dest: "market", type: "int", required: true },
  { flag: "--identity", dest: "identity", default: "pb-mm" },
  { flag: "--base-sac", dest: "baseSac", required: true },
  { flag: "--quote-sac", dest: "quoteSac", required: true },
  { flag: "--config-dir", dest: "configDir", default: ".stellar" },
  { flag: "--network", dest: "network", default: "testnet" },
  { flag: "--rpc", dest: "rpc", default: "https://soroban-testnet.stellar.org" },
  { flag: "--word-span", dest: "wordSpan", type: "int", default: DEFAULT_WORD_SPAN },
  { flag: "--tick-span", dest: "tickSpan", type: "int", default: DEFAULT_TICK_SPAN },
  { flag: "--horizon-ledgers", dest: "horizonLedgers", type: "int", default: DEFAULT_HORIZON_LEDGERS },
  { flag: "--extend-ledgers", dest: "extendLedgers", type: "int", default: DEFAULT_EXTEND_LEDGERS },
  { flag: "--dry-run", dest: "dryRun", type: "bool" },
  { flag: "--log", dest: "log", default: "ops/keepalive.log" },
];

export function parseKeepaliveArgs(argv: string[]): KeepaliveArgs {
  return parseArgs<KeepaliveArgs>(argv, KEEPALIVE_SPECS);
}

export function wordsAround(mid: number, span: number): number[] {
  const w = wordOf(mid);
  const out: number[] = [];
  for (let i = w - span; i <= w + span; i++) {
    if (i >= 0) out.push(i);
  }
  return out;
}

export function ticksAround(mid: number, span: number): number[] {
  const lo = Math.max(1, mid - span);
  const hi = mid + span;
  const out: number[] = [];
  for (let t = lo; t <= hi; t++) out.push(t);
  return out;
}

export function enumerateKeepaliveKeys(opts: {
  market: number;
  mid: number | null;
  wordSpan: number;
  tickSpan: number;
  base: string;
  quote: string;
}): ClientKey[] {
  const m = opts.market;
  const keys: ClientKey[] = [
    { t: "Market", market: m },
    { t: "TickSummary", market: m, isBid: true },
    { t: "TickSummary", market: m, isBid: false },
    { t: "BestTick", market: m, isBid: true },
    { t: "BestTick", market: m, isBid: false },
    { t: "FeeAccrual", market: m, token: opts.base },
    { t: "FeeAccrual", market: m, token: opts.quote },
  ];
  if (opts.mid != null) {
    for (const isBid of [true, false]) {
      for (const word of wordsAround(opts.mid, opts.wordSpan)) {
        keys.push({ t: "TickWord", market: m, isBid, word });
      }
      for (const tick of ticksAround(opts.mid, opts.tickSpan)) {
        keys.push({ t: "Level", market: m, isBid, tick });
      }
    }
  }
  return keys;
}

export function midFromBests(bid: number | null, ask: number | null): number | null {
  if (bid != null && ask != null) return Math.floor((bid + ask) / 2);
  return bid ?? ask;
}

export type KeepaliveRow = {
  key: ClientKey;
  keyXdr: string;
  liveness: KeyLiveness;
  liveUntil?: number;
};

export type KeepalivePlanItem = KeepaliveRow & {
  keyName: string;
  op: "restore" | "extend";
};

export function planKeepalive(rows: KeepaliveRow[], latest: number, horizon: number): KeepalivePlanItem[] {
  const out: KeepalivePlanItem[] = [];
  for (const row of rows) {
    if (row.liveness === "nonexistent") continue;
    const keyName = keyStr(row.key);
    if (row.liveness === "archived") {
      out.push({ ...row, keyName, op: "restore" });
      out.push({ ...row, keyName, op: "extend" });
    } else if (row.liveUntil != null && row.liveUntil - latest < horizon) {
      out.push({ ...row, keyName, op: "extend" });
    }
  }
  return out;
}

export function batchItems<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type KeepaliveDeps = {
  rpc?: Rpc;
  id?: Identity;
  views?: Views;
  log?: OpsLog;
  restore?: typeof restoreKeys;
  extend?: typeof extendKeys;
};

export type KeepaliveSummary = {
  mid: number | null;
  latest: number;
  keys: number;
  restores: number;
  extends: number;
  skipped: number;
  dry: boolean;
};

export async function runKeepalive(a: KeepaliveArgs, deps: KeepaliveDeps = {}): Promise<{ line: string; summary: KeepaliveSummary }> {
  const rpc = deps.rpc ?? createRpc(a.rpc);
  const id = deps.id ?? loadIdentity(a.identity, a.configDir);
  const log = deps.log ?? openLog(a.log);
  const views = deps.views ?? createViews(rpc, { contract: a.contract, source: id.address, market: a.market, owner: id.address });
  const hex = tokenHex(a.baseSac, a.quoteSac);
  let bid: number | null = null;
  let ask: number | null = null;
  try {
    bid = await withTimeout(views.best(true));
    ask = await withTimeout(views.best(false));
  } catch {
    bid = null;
    ask = null;
  }
  const mid = midFromBests(bid, ask);
  const keys = enumerateKeepaliveKeys({
    market: a.market,
    mid,
    wordSpan: a.wordSpan,
    tickSpan: a.tickSpan,
    base: hex.base,
    quote: hex.quote,
  });
  const ctx = { contract: a.contract, caller: id.address };
  const xdrKeys = keys.map((k) => toLedgerKey(ctx, k).xdr);
  const sizes = await sweepPadSizes(rpc, xdrKeys, { chunk: 100, coverBytes: false });
  const latest = sizes.latestLedger ?? 0;
  const rows: KeepaliveRow[] = keys.map((key, i) => {
    const info = sizes.sizeOf(xdrKeys[i]);
    return {
      key,
      keyXdr: xdrKeys[i].toXDR("base64"),
      liveness: info?.liveness ?? classifyLiveness(info?.liveUntil, latest, info?.exists ?? false),
      liveUntil: info?.liveUntil,
    };
  });
  const plan = planKeepalive(rows, latest, a.horizonLedgers);
  const doRestore = deps.restore ?? restoreKeys;
  const doExtend = deps.extend ?? extendKeys;
  let restores = 0;
  let extendsN = 0;
  const restoreItems = plan.filter((p) => p.op === "restore");
  const extendItems = plan.filter((p) => p.op === "extend");
  if (a.dryRun) {
    for (const item of plan) {
      log.record(item.op, "dry", { key: item.keyName, liveUntil: item.liveUntil, latest });
      if (item.op === "restore") restores += 1;
      else extendsN += 1;
    }
  } else {
    for (const group of batchItems(restoreItems, EXTEND_BATCH)) {
      let res = await doRestore(
        rpc,
        id.secret,
        a.contract,
        group.map((g) => g.keyXdr),
      );
      if (res.kind === "txBadSeq") {
        res = await doRestore(rpc, id.secret, a.contract, group.map((g) => g.keyXdr));
      }
      const out = outcomeOf(res);
      for (const item of group) {
        log.record("restore", out, { key: item.keyName, liveUntil: item.liveUntil, latest, tx: "hash" in res ? res.hash : "" });
      }
      if (res.kind === "ok") restores += group.length;
    }
    for (const group of batchItems(extendItems, EXTEND_BATCH)) {
      let res = await doExtend(
        rpc,
        id.secret,
        group.map((g) => g.keyXdr),
        a.extendLedgers,
      );
      if (res.kind === "txBadSeq") {
        // Another submitter on the same identity raced us (the maker, when
        // keepalive runs as pb-mm). One retry with a fresh sequence.
        res = await doExtend(rpc, id.secret, group.map((g) => g.keyXdr), a.extendLedgers);
      }
      const out = outcomeOf(res);
      for (const item of group) {
        log.record("extend", out, { key: item.keyName, liveUntil: item.liveUntil, latest, tx: "hash" in res ? res.hash : "" });
      }
      if (res.kind === "ok") extendsN += group.length;
    }
  }
  const planned = new Set(plan.map((p) => p.keyName));
  for (const row of rows) {
    // Singletons are few; record their remaining TTL even when healthy so the
    // log proves liveness (an operator gap found in the first cloud run).
    const t = row.key.t;
    if ((t === "Market" || t === "TickSummary" || t === "BestTick" || t === "FeeAccrual") && row.liveness === "live" && !planned.has(keyStr(row.key))) {
      log.record("healthy", "live", { key: keyStr(row.key), liveUntil: row.liveUntil, latest, remaining: (row.liveUntil ?? 0) - latest });
    }
  }
  const skipped = rows.length - planned.size;
  const summary: KeepaliveSummary = {
    mid,
    latest,
    keys: keys.length,
    restores,
    extends: extendsN,
    skipped,
    dry: a.dryRun,
  };
  const line = `KEEPALIVE ${a.dryRun ? "dry" : "ok"} ${JSON.stringify(summary)}`;
  log.record("summary", a.dryRun ? "dry" : "ok", { ...summary });
  return { line, summary };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const a = parseKeepaliveArgs(argv);
  if (a.network !== "testnet") throw new Error("only testnet is supported by the ops entry points today");
  const r = await runKeepalive(a);
  process.stdout.write(r.line + "\n");
  return 0;
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
