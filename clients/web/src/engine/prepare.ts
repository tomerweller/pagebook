import * as StellarSdk from "@stellar/stellar-sdk";
import type { Rpc } from "../book";
import { readAccount } from "../wallet/account";
import { NETWORK_PASSPHRASE } from "../wallet/network";
import { keyStr, sameKey, toLedgerKey, toPlannedKey, type ClientKey, type Hex32, type PlannedLedgerKey } from "./clientKeys";
import { mergeSizes, sweepPadSizes } from "./liveness";
import {
  buildPlaceArgs,
  classifyFailedTx,
  classifySubmit,
  scReplaceItem,
  scvAddr,
  scvU32,
  scvU64,
  tokenExtraKeys,
  type ClassicToken,
  type EngineBody,
  type PlaceArgParams,
} from "./op";
import { plannedKeysFor, touchedKeysFor, type Quoted } from "./pad";
import { simulate } from "./quote";
import {
  applyPad,
  checkDeclared,
  classicFee,
  declaredFromSoroban,
  DEFAULT_GROWTH,
  MAX_SWEEP_KEYS,
  simRestoreKeys,
  TX_LIMITS,
  type ApplyPadSizes,
  type DeclaredResources,
  type PadKeySize,
  type TxLimits,
} from "./txdata";

export type Intent =
  | ({ kind: "place" } & PlaceArgParams & { quoted: Quoted; padEnd: number })
  | ({ kind: "placePostOnly" } & PlaceArgParams & { base: Hex32; quote: Hex32 })
  | { kind: "settle"; owner: string; market: number; nonce: bigint; base: Hex32; quote: Hex32 }
  | {
      kind: "replace";
      owner: string;
      market: number;
      nonce: bigint;
      isBid: boolean;
      tick: number;
      qtyLots: bigint;
      base: Hex32;
      quote: Hex32;
    }
  | {
      kind: "replaceBatch";
      owner: string;
      market: number;
      items: { nonce: bigint; isBid: boolean; tick: number; qtyLots: bigint }[];
      base: Hex32;
      quote: Hex32;
    }
  | { kind: "invoke"; fn: string; args: StellarSdk.xdr.ScVal[] };

export type PadPolicy = {
  cover?: "sized" | "flat";
  sweep?: ApplyPadSizes;
  extraKeys?: ClientKey[];
  growth?: number;
  slack?: number;
  limits?: Partial<TxLimits>;
};

export type PrepareRequest = {
  contract: string;
  source: string;
  intent: Intent;
  tokens: ClassicToken[];
  policy?: PadPolicy;
  levelCap?: number;
};

export type Prepared = {
  kind: "prepared";
  tx: StellarSdk.Transaction;
  declared: DeclaredResources;
  footprint: { ro: StellarSdk.xdr.LedgerKey[]; rw: StellarSdk.xdr.LedgerKey[] };
  restoreMarked: StellarSdk.xdr.LedgerKey[];
  dropped: number;
  observedLedger: number;
};

export type PrepareResult =
  | Prepared
  | { kind: "restoreNeeded"; preamble: { transactionData?: unknown; minResourceFee?: string } }
  | EngineBody;

const RESOURCE_LABEL: Record<string, string> = {
  entries: "footprint entries",
  rwEntries: "read-write entries",
  writeBytes: "write bytes",
  instructions: "instructions",
  txBytes: "transaction bytes",
};

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function operationFor(intent: Intent): { fn: string; args: StellarSdk.xdr.ScVal[] } {
  switch (intent.kind) {
    case "place":
    case "placePostOnly":
      return { fn: "place", args: buildPlaceArgs(intent) };
    case "settle":
      return { fn: "settle", args: [scvAddr(intent.owner), scvU32(intent.market), scvU64(intent.nonce)] };
    case "replace":
      return {
        fn: "replace",
        args: [
          scvAddr(intent.owner),
          scvU32(intent.market),
          scvU64(intent.nonce),
          StellarSdk.xdr.ScVal.scvBool(intent.isBid),
          scvU32(intent.tick),
          scvU64(intent.qtyLots),
        ],
      };
    case "replaceBatch":
      return {
        fn: "replace_batch",
        args: [scvAddr(intent.owner), scvU32(intent.market), StellarSdk.xdr.ScVal.scvVec(intent.items.map(scReplaceItem))],
      };
    case "invoke":
      return { fn: intent.fn, args: intent.args };
  }
}

function unionPlanned(keys: PlannedLedgerKey[]): PlannedLedgerKey[] {
  const seen = new Set<string>();
  const out: PlannedLedgerKey[] = [];
  for (const p of keys) {
    const s = p.key.toXDR("base64");
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(p);
  }
  return out;
}

function unionClient(keys: ClientKey[]): ClientKey[] {
  const seen = new Set<string>();
  const out: ClientKey[] = [];
  for (const k of keys) {
    const s = keyStr(k);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(k);
  }
  return out;
}

function wrapSizes(sizes: ApplyPadSizes, cover: "sized" | "flat", growth: number, slack?: number): ApplyPadSizes {
  return {
    sizeOf(key) {
      return sizes.sizeOf(key);
    },
    growth,
    slack: slack ?? sizes.slack,
    coverBytes: cover === "sized",
    latestLedger: sizes.latestLedger,
  };
}

function emptySizes(cover: "sized" | "flat", growth: number, slack?: number): ApplyPadSizes {
  return {
    sizeOf() {
      return undefined;
    },
    growth,
    slack,
    coverBytes: cover === "sized",
    latestLedger: 0,
  };
}

function bandLevels(intent: Intent): number | undefined {
  if (intent.kind !== "place") return undefined;
  const lo = Math.min(intent.quoted.startTick, intent.padEnd);
  const hi = Math.max(intent.quoted.startTick, intent.padEnd);
  return hi - lo + 1;
}

function bandNote(
  intent: Intent,
  sizes: ApplyPadSizes,
  ctx: { contract: string; caller: string },
  unswept = false,
): string {
  if (intent.kind !== "place") return "";
  const levels = bandLevels(intent);
  if (levels == null) return "";
  if (unswept) return ` (band ${fmt(levels)} levels, unswept)`;
  const lo = Math.min(intent.quoted.startTick, intent.padEnd);
  const hi = Math.max(intent.quoted.startTick, intent.padEnd);
  let exist = 0;
  for (let t = lo; t <= hi; t++) {
    const k = toLedgerKey(ctx, { t: "Level", market: intent.quoted.market, isBid: !intent.quoted.ownSide, tick: t });
    if (sizes.sizeOf(k.xdr)?.exists) exist += 1;
  }
  return ` (band ${fmt(levels)} levels, ${fmt(exist)} exist)`;
}

function oversizeMessage(
  intent: Intent,
  over: { resource: string; declared: number; cap: number },
  note: string,
): string {
  const label = RESOURCE_LABEL[over.resource] ?? over.resource;
  const hint = intent.kind === "place" || intent.kind === "placePostOnly" ? "; narrow the limit or split the take" : "";
  return `declared ${fmt(over.declared)} ${label} over the ${fmt(over.cap)} per-transaction cap${note}${hint}`;
}

function ceilingMessage(intent: Intent, keyCount: number): string {
  const levels = bandLevels(intent);
  const band = levels != null ? ` (band ${fmt(levels)} levels, unswept)` : "";
  const hint = intent.kind === "place" || intent.kind === "placePostOnly" ? "; narrow the limit" : "";
  return `${fmt(keyCount)} keys to sweep exceed the ${fmt(MAX_SWEEP_KEYS)} sweep ceiling${band}${hint}`;
}

function keyB64(k: StellarSdk.xdr.LedgerKey): string {
  return k.toXDR("base64");
}

function countsTowardAdd(liveness: PadKeySize["liveness"], missing: "skip" | "added"): boolean {
  if (liveness === "live" || liveness === "nonexistent") return true;
  if (liveness === "archived") return false;
  return missing === "added";
}

function countWouldAdd(
  extra: PlannedLedgerKey[],
  simRo: Set<string>,
  simRw: Set<string>,
  simRoLen: number,
  simRwLen: number,
  sizeOf: (key: StellarSdk.xdr.LedgerKey) => PadKeySize | undefined,
  missing: "skip" | "added" = "skip",
): { rw: number; entries: number } {
  let addRw = 0;
  let addEntries = 0;
  for (const p of extra) {
    const s = keyB64(p.key);
    if (!countsTowardAdd(sizeOf(p.key)?.liveness, missing)) continue;
    if (p.access === "rw") {
      if (simRw.has(s)) continue;
      addRw += 1;
      if (!simRo.has(s)) addEntries += 1;
    } else if (!simRo.has(s) && !simRw.has(s)) {
      addEntries += 1;
    }
  }
  return { rw: simRwLen + addRw, entries: simRoLen + simRwLen + addEntries };
}

function overflowOf(
  counts: { rw: number; entries: number },
  limits: TxLimits,
): { resource: string; declared: number; cap: number } | null {
  if (counts.rw > limits.rwEntries) return { resource: "rwEntries", declared: counts.rw, cap: limits.rwEntries };
  if (counts.entries > limits.entries) return { resource: "entries", declared: counts.entries, cap: limits.entries };
  return null;
}

export async function prepareInvocation(rpc: Rpc, req: PrepareRequest): Promise<PrepareResult> {
  const acc = await readAccount(rpc, req.source);
  if (!acc.exists) return { kind: "rpc", message: "account not funded" };
  const account = new StellarSdk.Account(req.source, acc.sequence.toString());
  const { fn, args } = operationFor(req.intent);
  const op = new StellarSdk.Contract(req.contract).call(fn, ...args);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();

  let sim;
  try {
    sim = await simulate(rpc, tx.toXDR());
  } catch (e) {
    return { kind: "rpc", message: e instanceof Error ? e.message : String(e) };
  }
  if (sim.restorePreamble?.transactionData) {
    return { kind: "restoreNeeded", preamble: sim.restorePreamble };
  }
  if (sim.error) {
    const raw = sim.raw as { events?: unknown };
    const events = Array.isArray(raw?.events) ? raw.events.filter((e): e is string => typeof e === "string") : [];
    if (events.length) {
      const fromEv = classifyFailedTx(undefined, events, undefined, "simulation", req.contract);
      if (fromEv.kind === "archived" || fromEv.kind === "typed") return fromEv;
    }
    return classifySubmit(sim.error, "simulation");
  }
  if (!sim.transactionData) return { kind: "rpc", message: "simulation returned no transactionData" };

  let assembled: StellarSdk.Transaction;
  try {
    assembled = StellarSdk.rpc.assembleTransaction(tx, sim.raw as StellarSdk.rpc.Api.SimulateTransactionResponse).build();
  } catch (e) {
    return { kind: "rpc", message: e instanceof Error ? e.message : String(e) };
  }

  const policy = req.policy ?? {};
  const cover = policy.cover ?? "sized";
  const growth = policy.growth ?? DEFAULT_GROWTH;
  const ctx = { contract: req.contract, caller: req.source };
  if (!policy.sweep && req.intent.kind === "place") {
    const levels = bandLevels(req.intent);
    if (levels != null && levels > MAX_SWEEP_KEYS) {
      return { kind: "resourceLimit", at: "prepare", message: ceilingMessage(req.intent, levels) };
    }
  }
  const planned = plannedKeysFor(req.intent);
  const extra = unionPlanned([
    ...unionClient([...planned, ...(policy.extraKeys ?? [])]).map((k) => toPlannedKey(ctx, k)),
    ...tokenExtraKeys(req.contract, req.source, req.tokens),
  ]);

  const existing = assembled.toEnvelope().v1().tx().ext().sorobanData();
  const simFp = new StellarSdk.SorobanDataBuilder(existing);
  const simRo = simFp.getReadOnly();
  const simRw = simFp.getReadWrite();
  const simRoSet = new Set(simRo.map((k) => k.toXDR("base64")));
  const simRwSet = new Set(simRw.map((k) => k.toXDR("base64")));
  const limits = { ...TX_LIMITS, ...policy.limits };

  const wouldAdd = (sizeOf: (key: StellarSdk.xdr.LedgerKey) => PadKeySize | undefined) =>
    countWouldAdd(extra, simRoSet, simRwSet, simRo.length, simRw.length, sizeOf);

  const refuseUnswept = (over: { resource: string; declared: number; cap: number }) => {
    const message = oversizeMessage(req.intent, over, bandNote(req.intent, emptySizes(cover, growth, policy.slack), ctx, true));
    return { kind: "resourceLimit" as const, at: "prepare" as const, message };
  };

  const cachedOver = overflowOf(
    wouldAdd((k) => policy.sweep?.sizeOf(k)),
    limits,
  );
  if (cachedOver) return refuseUnswept(cachedOver);

  const uncovered: StellarSdk.xdr.LedgerKey[] = [];
  for (const p of extra) {
    if (policy.sweep?.sizeOf(p.key) != null) continue;
    uncovered.push(p.key);
  }
  if (uncovered.length > MAX_SWEEP_KEYS) {
    return { kind: "resourceLimit", at: "prepare", message: ceilingMessage(req.intent, uncovered.length) };
  }

  let sizes: ApplyPadSizes;
  if (uncovered.length) {
    const fresh = await sweepPadSizes(rpc, uncovered, {
      growth,
      chunk: 100,
      coverBytes: cover === "sized",
      stopWhen: (byKey) =>
        overflowOf(
          wouldAdd((k) => byKey.get(keyB64(k)) ?? policy.sweep?.sizeOf(k)),
          limits,
        ) != null,
    });
    if (fresh.stoppedEarly) {
      const over = overflowOf(
        wouldAdd((k) => fresh.sizeOf(k) ?? policy.sweep?.sizeOf(k)),
        limits,
      );
      if (over) return refuseUnswept(over);
    }
    sizes = wrapSizes(mergeSizes(policy.sweep, fresh), cover, growth, policy.slack);
  } else if (policy.sweep) {
    sizes = wrapSizes(policy.sweep, cover, growth, policy.slack);
  } else {
    sizes = emptySizes(cover, growth, policy.slack);
  }

  const archived: ClientKey[] = [];
  for (const k of planned) {
    if (sizes.sizeOf(toLedgerKey(ctx, k).xdr)?.liveness === "archived") archived.push(k);
  }
  const touched = touchedKeysFor(req.intent, planned);
  const marks: StellarSdk.xdr.LedgerKey[] = [];
  for (const k of touched) {
    if (!archived.some((a) => sameKey(a, k))) continue;
    marks.push(toLedgerKey(ctx, k).xdr);
  }

  const padded = applyPad(existing, extra, marks, sizes, req.levelCap);
  const declared = declaredFromSoroban(padded.data);
  const fee = classicFee(padded.resourceFee);
  let finalTx: StellarSdk.Transaction;
  try {
    finalTx = StellarSdk.TransactionBuilder.cloneFrom(assembled, { fee }).setSorobanData(padded.data).build();
  } catch (e) {
    return { kind: "rpc", message: e instanceof Error ? e.message : String(e) };
  }

  const txBytes = finalTx.toEnvelope().toXDR().length + 256;
  const over = checkDeclared(declared, txBytes, policy.limits);
  if (over) {
    return {
      kind: "resourceLimit",
      at: "prepare",
      message: oversizeMessage(req.intent, over, bandNote(req.intent, sizes, ctx)),
      declared,
    };
  }

  const rw = [...new StellarSdk.SorobanDataBuilder(padded.data).getReadWrite()];
  const ro = [...new StellarSdk.SorobanDataBuilder(padded.data).getReadOnly()];
  return {
    kind: "prepared",
    tx: finalTx,
    declared,
    footprint: { ro, rw },
    restoreMarked: simRestoreKeys(padded.data, rw),
    dropped: padded.dropped,
    observedLedger: Math.max(sizes.latestLedger ?? 0, sim.latestLedger ?? 0),
  };
}
