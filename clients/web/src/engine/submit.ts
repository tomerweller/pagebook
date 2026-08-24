import * as StellarSdk from "@stellar/stellar-sdk";
import type { Rpc } from "../book";
import { instanceKey } from "../keys";
import { sacBalanceKey } from "../keys";
import { accountLedgerKey, trustlineLedgerKey } from "../wallet/account";
import { readAccount } from "../wallet/account";
import { NETWORK_PASSPHRASE } from "../wallet/network";
import { toLedgerKey, type ClientKey } from "./clientKeys";
import { errorName, hostErrorMessage, parseContractError } from "./errors";
import { pad, restoreMarks, type PadOut, type Quoted, type WindowSpec } from "./pad";
import { simulate } from "./quote";
import { applyPad, classicFee, footprintIndexes, type ApplyPadSizes } from "./txdata";

export type PlaceFlags = {
  post_only: boolean;
  fill_or_kill: boolean;
  no_rest: boolean;
};

export type EnginePhase = "simulation" | "apply" | "send";
export type EngineOk = { kind: "ok"; hash: string; ledger?: number; fee?: string; resultMetaXdr?: string };
export type EngineTyped = { kind: "typed"; errorCode: number; errorName: string; at: "simulation" | "apply"; hash?: string };
export type EngineFootprint = { kind: "footprint"; missingKey?: string; hash?: string; at?: EnginePhase };
export type EngineBadSeq = { kind: "txBadSeq"; message: string; hash?: string; reachedLedger?: boolean; at?: EnginePhase };
export type EngineResourceLimit = { kind: "resourceLimit"; message: string; hash?: string; at?: EnginePhase };
export type EngineSorobanInvalid = { kind: "sorobanInvalid"; message: string; hash?: string; at?: EnginePhase };
export type EngineTimeout = { kind: "timeout"; message: string; hash: string };
export type EngineRpc = { kind: "rpc"; message: string; hash?: string; at?: EnginePhase };
export type EngineTrapped = { kind: "trapped"; message?: string; hash?: string; at?: EnginePhase };
export type EngineResult =
  | EngineOk
  | EngineTyped
  | EngineFootprint
  | EngineBadSeq
  | EngineResourceLimit
  | EngineSorobanInvalid
  | EngineTimeout
  | EngineRpc
  | EngineTrapped;

export type PlaceReturn = {
  rested: boolean;
  filledLots: bigint;
  quoteAtoms: bigint;
};

export function decodePlaceResult(metaXdrBase64: string): PlaceReturn {
  const meta = StellarSdk.xdr.TransactionMeta.fromXDR(metaXdrBase64, "base64");
  const ret = sorobanReturnValue(meta);
  if (!ret) throw new Error("no soroban return value");
  const native = StellarSdk.scValToNative(ret) as unknown;
  if (!Array.isArray(native) || native.length < 3) throw new Error("place return is not a 3-tuple");
  return {
    rested: Boolean(native[0]),
    filledLots: BigInt(String(native[1])),
    quoteAtoms: BigInt(String(native[2])),
  };
}

function sorobanReturnValue(meta: StellarSdk.xdr.TransactionMeta): StellarSdk.xdr.ScVal | null {
  const sw = Number(meta.switch());
  if (sw === 3) {
    const sm = meta.v3().sorobanMeta();
    return sm ? sm.returnValue() : null;
  }
  if (sw === 4) {
    const sm = meta.v4().sorobanMeta();
    return sm ? sm.returnValue() : null;
  }
  return null;
}

export type ClassicToken = { sac: string; code?: string; issuer?: string };

export function tokenExtraKeys(pagebook: string, caller: string, tokens: ClassicToken[]): StellarSdk.xdr.LedgerKey[] {
  const keys: StellarSdk.xdr.LedgerKey[] = [];
  for (const t of tokens) {
    keys.push(instanceKey(t.sac).xdr);
    keys.push(sacBalanceKey(t.sac, pagebook).xdr);
    if (t.code && t.issuer) {
      keys.push(trustlineLedgerKey(caller, { type: "credit", code: t.code, issuer: t.issuer }));
    } else {
      keys.push(accountLedgerKey(caller));
    }
  }
  return keys;
}

export function scvU32(n: number): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvU32(n);
}

export function scvBool(b: boolean): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvBool(b);
}

export function scvU64(n: bigint): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(n, { type: "u64" });
}

export function scvAddr(a: string): StellarSdk.xdr.ScVal {
  return new StellarSdk.Address(a).toScVal();
}

function scvSym(s: string): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvSymbol(s);
}

function scvMap(entries: [string, StellarSdk.xdr.ScVal][]): StellarSdk.xdr.ScVal {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return StellarSdk.xdr.ScVal.scvMap(
    sorted.map(([k, v]) => new StellarSdk.xdr.ScMapEntry({ key: scvSym(k), val: v })),
  );
}

export function scPlaceFlags(f: PlaceFlags): StellarSdk.xdr.ScVal {
  return scvMap([
    ["post_only", scvBool(f.post_only)],
    ["fill_or_kill", scvBool(f.fill_or_kill)],
    ["no_rest", scvBool(f.no_rest)],
  ]);
}

export function scPageRange(r: { first: number; last: number }): StellarSdk.xdr.ScVal {
  return scvMap([
    ["first", scvU32(r.first)],
    ["last", scvU32(r.last)],
  ]);
}

export function scSlotWindow(w: WindowSpec): StellarSdk.xdr.ScVal {
  const consume = w.consume.map((c) =>
    scvMap([
      ["tick", scvU32(c.tick)],
      ["pages", scPageRange(c.pages)],
    ]),
  );
  return scvMap([
    ["consume", StellarSdk.xdr.ScVal.scvVec(consume)],
    ["append", scPageRange(w.append)],
  ]);
}

export function scReplaceItem(item: {
  nonce: bigint;
  isBid: boolean;
  tick: number;
  qtyLots: bigint;
  window: WindowSpec;
}): StellarSdk.xdr.ScVal {
  return scvMap([
    ["nonce", scvU64(item.nonce)],
    ["is_bid", scvBool(item.isBid)],
    ["tick", scvU32(item.tick)],
    ["qty_lots", scvU64(item.qtyLots)],
    ["window", scSlotWindow(item.window)],
  ]);
}

export function classifySubmit(
  text: string,
  at: EnginePhase,
  hash?: string,
): EngineResult {
  const typedAt = at === "send" ? "apply" : at;
  const host = hostErrorMessage(text);
  if (host) return { kind: "rpc", message: host, hash, at };
  const code = parseContractError(text);
  if (code != null) {
    return { kind: "typed", errorCode: code, errorName: errorName(code), at: typedAt, hash };
  }
  if (/txBadSeq|BAD_SEQ/.test(text)) {
    return { kind: "txBadSeq", message: text.slice(0, 400), hash, reachedLedger: at === "apply", at };
  }
  if (/ResourceLimitExceeded/.test(text)) return { kind: "resourceLimit", message: text.slice(0, 400), hash, at };
  if (/TxSorobanInvalid/.test(text)) return { kind: "sorobanInvalid", message: text.slice(0, 400), hash, at };
  if (/footprint|ExceededLimit|storage.*exceeded/i.test(text)) {
    return { kind: "footprint", hash, at };
  }
  return { kind: "rpc", message: text.slice(0, 400), hash, at };
}

type FailedHints = {
  contract?: number;
  footprint: boolean;
  resource: boolean;
};

function walkScVal(val: StellarSdk.xdr.ScVal, hints: FailedHints, texts: string[]): void {
  let sw: string;
  try {
    sw = val.switch().name;
  } catch {
    return;
  }
  if (sw === "scvError") {
    try {
      const err = val.error();
      const kind = err.switch().name;
      if (kind === "sceContract") hints.contract = err.contractCode();
      else if (kind === "sceStorage" && err.code().name === "scecExceededLimit") hints.footprint = true;
      else if (kind === "sceBudget") hints.resource = true;
    } catch {
      /* ignore */
    }
  }
  if (sw === "scvString" || sw === "scvSymbol") {
    try {
      texts.push(String(StellarSdk.scValToNative(val)));
    } catch {
      /* ignore */
    }
  }
  if (sw === "scvVec") {
    try {
      for (const child of val.vec() ?? []) walkScVal(child, hints, texts);
    } catch {
      /* ignore */
    }
  }
  if (sw === "scvMap") {
    try {
      for (const entry of val.map() ?? []) {
        walkScVal(entry.key(), hints, texts);
        walkScVal(entry.val(), hints, texts);
      }
    } catch {
      /* ignore */
    }
  }
}

function contractCodeFromNative(n: unknown): number | undefined {
  if (n && typeof n === "object") {
    const rec = n as Record<string, unknown>;
    if (rec.type === "contract" && rec.code != null) {
      const code = Number(rec.code);
      if (Number.isFinite(code)) return code;
    }
    if (rec.contract != null && (typeof rec.contract === "number" || typeof rec.contract === "string")) {
      const code = Number(rec.contract);
      if (Number.isFinite(code)) return code;
    }
    if (rec.error != null) {
      const inner = contractCodeFromNative(rec.error);
      if (inner != null) return inner;
    }
    if (Array.isArray(n)) {
      for (const item of n) {
        const inner = contractCodeFromNative(item);
        if (inner != null) return inner;
      }
    }
  }
  return undefined;
}

function diagnoseEvent(b64: string, hints: FailedHints, texts: string[]): void {
  try {
    const ev = StellarSdk.xdr.DiagnosticEvent.fromXDR(b64, "base64");
    const v0 = ev.event().body().v0();
    for (const topic of v0.topics()) {
      walkScVal(topic, hints, texts);
      try {
        const native = StellarSdk.scValToNative(topic);
        const code = contractCodeFromNative(native);
        if (code != null) hints.contract = code;
      } catch {
        /* ignore */
      }
    }
    walkScVal(v0.data(), hints, texts);
    try {
      const native = StellarSdk.scValToNative(v0.data());
      const code = contractCodeFromNative(native);
      if (code != null) hints.contract = code;
    } catch {
      /* ignore */
    }
  } catch {
    /* raw base64 is not searchable */
  }
}

function diagnoseResultXdr(b64: string, hints: FailedHints): void {
  try {
    const tr = StellarSdk.xdr.TransactionResult.fromXDR(b64, "base64");
    const name = tr.result().switch().name;
    if (name === "txFailed" || name === "txSuccess") {
      for (const op of tr.result().results()) {
        try {
          const ihf = op.tr().invokeHostFunctionResult().switch().name;
          if (ihf === "invokeHostFunctionResourceLimitExceeded") hints.resource = true;
        } catch {
          /* not an invoke-host op */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

export function classifyFailedTx(
  resultXdr: string | undefined,
  diagnosticEventsXdr: string[] | undefined,
  hash?: string,
): EngineResult {
  const hints: FailedHints = { footprint: false, resource: false };
  const texts: string[] = [];
  if (resultXdr) diagnoseResultXdr(resultXdr, hints);
  for (const b64 of diagnosticEventsXdr ?? []) diagnoseEvent(b64, hints, texts);
  const blob = texts.join("\n");
  if (/trying to access contract data key outside of the footprint/i.test(blob)) hints.footprint = true;
  if (hints.contract != null) {
    return { kind: "typed", errorCode: hints.contract, errorName: errorName(hints.contract), at: "apply", hash };
  }
  if (hints.footprint) return { kind: "footprint", hash, at: "apply" };
  if (hints.resource) return { kind: "resourceLimit", message: "ResourceLimitExceeded", hash, at: "apply" };
  return { kind: "trapped", hash, at: "apply" };
}

function sendFailureText(sent: { status: string; message?: string; errorResultXdr?: string }): string {
  const parts: string[] = [];
  if (sent.message) parts.push(sent.message);
  if (sent.status) parts.push(sent.status);
  if (sent.errorResultXdr) {
    parts.push(sent.errorResultXdr);
    try {
      const tr = StellarSdk.xdr.TransactionResult.fromXDR(sent.errorResultXdr, "base64");
      parts.push(tr.result().switch().name);
    } catch {
      /* keep the raw xdr */
    }
  }
  return parts.join("\n");
}

function chargedFee(r: { feeCharged?: number | string; resultXdr?: string }): string | undefined {
  if (r.feeCharged != null && r.feeCharged !== "") return String(r.feeCharged);
  if (!r.resultXdr) return undefined;
  try {
    return StellarSdk.xdr.TransactionResult.fromXDR(r.resultXdr, "base64").feeCharged().toString();
  } catch {
    return undefined;
  }
}

async function waitTx(rpc: Rpc, hash: string): Promise<EngineResult> {
  let delay = 400;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, delay));
    const r = await rpc.getTransaction(hash);
    if (r.status === "SUCCESS") {
      return { kind: "ok", hash, ledger: r.ledger, fee: chargedFee(r), resultMetaXdr: r.resultMetaXdr };
    }
    if (r.status === "FAILED") {
      return classifyFailedTx(r.resultXdr, r.diagnosticEventsXdr, hash);
    }
    delay = Math.min(Math.round(delay * 1.4), 2000);
  }
  return { kind: "timeout", message: "timed out waiting for transaction", hash };
}

export type SubmitArgs = {
  rpc: Rpc;
  contract: string;
  sourceSecret: string;
  fn: string;
  args: StellarSdk.xdr.ScVal[];
  padKeys?: ClientKey[];
  quoted?: Quoted;
  padOut?: PadOut;
  tokens?: ClassicToken[];
  sizes?: ApplyPadSizes;
};

export async function submitInvocation(a: SubmitArgs): Promise<EngineResult> {
  const kp = StellarSdk.Keypair.fromSecret(a.sourceSecret);
  let retriedBadSeq = false;
  for (;;) {
    const result = await submitOnce(a, kp);
    if (result.kind === "txBadSeq" && !result.reachedLedger && !retriedBadSeq) {
      retriedBadSeq = true;
      continue;
    }
    return result;
  }
}

async function submitOnce(a: SubmitArgs, kp: StellarSdk.Keypair): Promise<EngineResult> {
  const acc = await readAccount(a.rpc, kp.publicKey());
  if (!acc.exists) return { kind: "rpc", message: "account not funded" };
  const account = new StellarSdk.Account(kp.publicKey(), acc.sequence.toString());
  const c = new StellarSdk.Contract(a.contract);
  const op = c.call(a.fn, ...a.args);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();

  let sim;
  try {
    sim = await simulate(a.rpc, tx.toXDR());
  } catch (e) {
    return { kind: "rpc", message: e instanceof Error ? e.message : String(e) };
  }
  if (sim.error) return classifySubmit(sim.error, "simulation");
  if (!sim.transactionData) return { kind: "rpc", message: "simulation returned no transactionData" };

  let assembled: StellarSdk.Transaction;
  try {
    assembled = StellarSdk.rpc.assembleTransaction(tx, sim.raw as StellarSdk.rpc.Api.SimulateTransactionResponse).build();
  } catch (e) {
    return { kind: "rpc", message: e instanceof Error ? e.message : String(e) };
  }

  const extraXdr: StellarSdk.xdr.LedgerKey[] = [];
  if (a.padKeys) {
    const ctx = { contract: a.contract, caller: kp.publicKey() };
    for (const k of a.padKeys) extraXdr.push(toLedgerKey(ctx, k).xdr);
  }
  if (a.tokens) extraXdr.push(...tokenExtraKeys(a.contract, kp.publicKey(), a.tokens));

  const env = assembled.toEnvelope();
  const existing = env.v1().tx().ext().sorobanData();
  let archivedIdx: number[] = [];
  if (a.quoted && a.padOut) {
    const marks = await archivedTouched(a.rpc, a.contract, kp.publicKey(), a.quoted, a.padOut);
    if (marks.length) {
      const markXdr = marks.map((k) => toLedgerKey({ contract: a.contract, caller: kp.publicKey() }, k).xdr);
      archivedIdx = footprintIndexes(existing, markXdr);
    }
  }
  const padded = applyPad(existing, extraXdr, archivedIdx, a.sizes);
  const fee = classicFee(padded.resourceFee);
  const finalTx = StellarSdk.TransactionBuilder.cloneFrom(assembled, { fee }).setSorobanData(padded.data).build();
  finalTx.sign(kp);

  try {
    const sent = await a.rpc.sendTransaction(finalTx.toXDR());
    const hash = sent.hash;
    const failText = sendFailureText(sent);
    if (sent.status === "ERROR") {
      return classifySubmit(failText || "sendTransaction ERROR", "send", hash);
    }
    if (!hash) return { kind: "rpc", message: sent.message || sent.status || "no hash" };
    if (sent.status === "TRY_AGAIN_LATER") return { kind: "rpc", message: "try again later", hash };
    return waitTx(a.rpc, hash);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return classifySubmit(message, "send");
  }
}

async function archivedTouched(
  rpc: Rpc,
  contract: string,
  caller: string,
  quoted: Quoted,
  out: PadOut,
): Promise<ClientKey[]> {
  const ctx = { contract, caller };
  const wraps = out.keys.map((k) => toLedgerKey(ctx, k));
  const res = await rpc.getLedgerEntries(...wraps.map((w) => w.xdr));
  const present = new Set((res.entries ?? []).map((e) => (typeof e.key === "string" ? e.key : null)).filter((k): k is string => !!k));
  const missing: ClientKey[] = [];
  wraps.forEach((w, i) => {
    if (!present.has(w.base64)) missing.push(out.keys[i]);
  });
  return restoreMarks(quoted, out, missing);
}

export async function submitPlace(
  rpc: Rpc,
  opts: {
    contract: string;
    secret: string;
    taker: string;
    market: number;
    isBid: boolean;
    limitTick: number;
    qtyLots: bigint;
    startTick: number;
    nonce: bigint;
    window: WindowSpec;
    flags: PlaceFlags;
    quoted: Quoted;
    tokens: ClassicToken[];
    padEnd: number;
    pagesForEmpty?: boolean;
    sizes?: ApplyPadSizes;
  },
): Promise<EngineResult> {
  const out = pad(opts.quoted, opts.padEnd, { pagesForEmpty: opts.pagesForEmpty });
  return submitInvocation({
    rpc,
    contract: opts.contract,
    sourceSecret: opts.secret,
    fn: "place",
    args: [
      scvAddr(opts.taker),
      scvU32(opts.market),
      scvBool(opts.isBid),
      scvU32(opts.limitTick),
      scvU64(opts.qtyLots),
      scvU32(opts.startTick),
      scvU64(opts.nonce),
      scSlotWindow(opts.window),
      scPlaceFlags(opts.flags),
    ],
    padKeys: out.keys,
    quoted: opts.quoted,
    padOut: out,
    tokens: opts.tokens,
    sizes: opts.sizes,
  });
}

export async function submitSettle(
  rpc: Rpc,
  opts: {
    contract: string;
    secret: string;
    owner: string;
    market: number;
    nonce: bigint;
    padKeys: ClientKey[];
    tokens: ClassicToken[];
    sizes?: ApplyPadSizes;
  },
): Promise<EngineResult> {
  return submitInvocation({
    rpc,
    contract: opts.contract,
    sourceSecret: opts.secret,
    fn: "settle",
    args: [scvAddr(opts.owner), scvU32(opts.market), scvU64(opts.nonce)],
    padKeys: opts.padKeys,
    tokens: opts.tokens,
    sizes: opts.sizes,
  });
}

export async function submitReplaceBatch(
  rpc: Rpc,
  opts: {
    contract: string;
    secret: string;
    owner: string;
    market: number;
    items: { nonce: bigint; isBid: boolean; tick: number; qtyLots: bigint; window: WindowSpec }[];
    padKeys: ClientKey[];
    tokens: ClassicToken[];
    sizes?: ApplyPadSizes;
  },
): Promise<EngineResult> {
  return submitInvocation({
    rpc,
    contract: opts.contract,
    sourceSecret: opts.secret,
    fn: "replace_batch",
    args: [scvAddr(opts.owner), scvU32(opts.market), StellarSdk.xdr.ScVal.scvVec(opts.items.map(scReplaceItem))],
    padKeys: opts.padKeys,
    tokens: opts.tokens,
    sizes: opts.sizes,
  });
}

export async function submitReplace(
  rpc: Rpc,
  opts: {
    contract: string;
    secret: string;
    owner: string;
    market: number;
    nonce: bigint;
    isBid: boolean;
    tick: number;
    qtyLots: bigint;
    window: WindowSpec;
    padKeys: ClientKey[];
    tokens: ClassicToken[];
    sizes?: ApplyPadSizes;
  },
): Promise<EngineResult> {
  return submitInvocation({
    rpc,
    contract: opts.contract,
    sourceSecret: opts.secret,
    fn: "replace",
    args: [
      scvAddr(opts.owner),
      scvU32(opts.market),
      scvU64(opts.nonce),
      scvBool(opts.isBid),
      scvU32(opts.tick),
      scvU64(opts.qtyLots),
      scSlotWindow(opts.window),
    ],
    padKeys: opts.padKeys,
    tokens: opts.tokens,
    sizes: opts.sizes,
  });
}
