import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpc, type Rpc } from "../src/book";
import { parseArgs, type ArgSpec } from "./lib/args";
import type { OpsLogRecord } from "./lib/logparse";
import { mapPool } from "./lib/pool";
import { decodeCoreMetrics, decodeEnvelopeResources, decodeFeeCharged } from "./lib/txdecode";

export type ResourcesArgs = {
  contract: string;
  configDir: string;
  network: string;
  rpc: string;
  mmLog: string;
  traderLog: string;
  perCat: number;
  out: string;
};

export const RESOURCES_SPECS: ArgSpec<keyof ResourcesArgs & string>[] = [
  { flag: "--contract", dest: "contract", required: true },
  { flag: "--config-dir", dest: "configDir", default: ".stellar" },
  { flag: "--network", dest: "network", default: "testnet" },
  { flag: "--rpc", dest: "rpc", default: "https://soroban-testnet.stellar.org" },
  { flag: "--mm-log", dest: "mmLog", default: "ops/mm.log" },
  { flag: "--trader-log", dest: "traderLog", default: "ops/trader.log" },
  { flag: "--per-cat", dest: "perCat", type: "int", default: 30 },
  { flag: "--out", dest: "out", default: "resources.json" },
];

export function parseResourcesArgs(argv: string[]): ResourcesArgs {
  return parseArgs<ResourcesArgs>(argv, RESOURCES_SPECS);
}

export type ResourcePick = { cat: string; tx: string; meta: Record<string, unknown> };

export function categorizeLine(d: OpsLogRecord, kind: "mm" | "trader"): ResourcePick | null {
  if (d.outcome !== "ok" || !d.tx) return null;
  const a = d.action ?? "";
  if (kind === "mm") {
    if (a === "place") return { cat: "place post-only (maker quote)", tx: String(d.tx), meta: {} };
    if (a === "heal") {
      const p = Number(d.phantoms ?? 0);
      const cat = p <= 8 ? "heal walk, 1-8 phantom levels" : "heal walk, 9+ phantom levels";
      return { cat, tx: String(d.tx), meta: { phantoms: p } };
    }
    if (a === "replace") return { cat: "replace (single quote)", tx: String(d.tx), meta: {} };
    if (a === "replace_batch") return { cat: "replace_batch (6-8 quotes)", tx: String(d.tx), meta: {} };
    if (a === "settle") return { cat: "settle", tx: String(d.tx), meta: {} };
    return null;
  }
  if (a === "take") {
    const c = Number(d.crossed ?? 0);
    let cat: string;
    if (c <= 1) cat = "place take, 0-1 levels crossed";
    else if (c <= 3) cat = "place take, 2-3 levels crossed";
    else cat = "place take, 4+ levels crossed";
    return { cat, tx: String(d.tx), meta: { crossed: c, lots: d.lots } };
  }
  if (a === "rest") return { cat: "place rest inside spread (trader)", tx: String(d.tx), meta: {} };
  if (a === "settle") return { cat: "settle", tx: String(d.tx), meta: {} };
  return null;
}

export function categorizeLog(text: string, kind: "mm" | "trader"): ResourcePick[] {
  const lines = text.split(/\r?\n/);
  const out: ResourcePick[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const d = JSON.parse(lines[i]) as OpsLogRecord;
      const pick = categorizeLine(d, kind);
      if (pick) out.push(pick);
    } catch {
      continue;
    }
  }
  return out;
}

export function pickPerCat(picks: ResourcePick[], perCat: number): ResourcePick[] {
  const picked = new Map<string, ResourcePick[]>();
  for (const p of picks) {
    const cur = picked.get(p.cat) ?? [];
    if (cur.length < perCat) {
      cur.push(p);
      picked.set(p.cat, cur);
    }
  }
  return [...picked.values()].flat();
}

export type ResourceRecord = {
  cat: string;
  tx: string;
  d_ro: number;
  d_rw: number;
  d_instr: number;
  d_read_b: number;
  d_write_b: number;
  d_fee: number;
  tx_fee: number;
  fee_charged: number;
  [k: string]: unknown;
};

export function recordFromTx(
  cat: string,
  hash: string,
  meta: Record<string, unknown>,
  tx: { status?: string; envelopeXdr?: string; resultXdr?: string; diagnosticEventsXdr?: string[] },
): ResourceRecord | null {
  if (tx.status && tx.status !== "SUCCESS") return null;
  if (!tx.envelopeXdr || !tx.resultXdr) return null;
  try {
    const decl = decodeEnvelopeResources(tx.envelopeXdr);
    const rec: ResourceRecord = {
      cat,
      tx: hash,
      ...meta,
      ...decl,
      fee_charged: decodeFeeCharged(tx.resultXdr),
      ...decodeCoreMetrics(tx.diagnosticEventsXdr ?? []),
    };
    return rec;
  } catch {
    return null;
  }
}

export type ResourcesDeps = {
  rpc?: Rpc;
  readFile?: (path: string) => string | null;
  exists?: (path: string) => boolean;
  write?: (path: string, data: string) => void;
};

export async function runResources(a: ResourcesArgs, deps: ResourcesDeps = {}): Promise<ResourceRecord[]> {
  const exists = deps.exists ?? existsSync;
  const readFile =
    deps.readFile ??
    ((path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    });
  const write = deps.write ?? ((path, data) => writeFileSync(path, data));
  const rpc = deps.rpc ?? createRpc(a.rpc);

  const jobs: ResourcePick[] = [];
  for (const [path, kind] of [
    [a.mmLog, "mm"],
    [a.traderLog, "trader"],
  ] as const) {
    if (!exists(path)) continue;
    const text = readFile(path);
    if (text == null) continue;
    jobs.push(...pickPerCat(categorizeLog(text, kind), a.perCat));
  }
  process.stderr.write(`${jobs.length} transactions across ${new Set(jobs.map((j) => j.cat)).size} categories\n`);
  const out: ResourceRecord[] = [];
  let done = 0;
  const fetched = await mapPool(jobs, 8, async (j) => {
    try {
      const r = await rpc.getTransaction(j.tx);
      const rec = recordFromTx(j.cat, j.tx, j.meta, r);
      done += 1;
      if (done % 25 === 0) process.stderr.write(`${done}/${jobs.length}\n`);
      return rec;
    } catch {
      return null;
    }
  });
  for (const r of fetched) if (r) out.push(r);
  write(a.out, JSON.stringify(out));
  process.stderr.write(`wrote ${out.length} records to ${a.out}\n`);
  return out;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const a = parseResourcesArgs(argv);
  if (a.network !== "testnet") throw new Error("only testnet is supported by the ops entry points today");
  await runResources(a);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) {
  main().catch((e) => {
    process.stderr.write(String(e) + "\n");
    process.exit(1);
  });
}