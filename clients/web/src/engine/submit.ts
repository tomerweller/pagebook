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
import { applyPad, classicFee, footprintIndexes } from "./txdata";

export type PlaceFlags = {
  post_only: boolean;
  fill_or_kill: boolean;
  no_rest: boolean;
};

export type EngineOk = { kind: "ok"; hash: string; ledger?: number; fee?: string };
export type EngineTyped = { kind: "typed"; errorCode: number; errorName: string; at: "simulation" | "apply"; hash?: string };
export type EngineFootprint = { kind: "footprint"; missingKey?: string; hash?: string };
export type EngineRpc = { kind: "rpc"; message: string; hash?: string };
export type EngineResult = EngineOk | EngineTyped | EngineFootprint | EngineRpc;

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

function scvU32(n: number): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvU32(n);
}

function scvBool(b: boolean): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvBool(b);
}

function scvU64(n: bigint): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(n, { type: "u64" });
}

function scvAddr(a: string): StellarSdk.xdr.ScVal {
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

function classify(text: string, at: "simulation" | "apply", hash?: string): EngineResult {
  const host = hostErrorMessage(text);
  if (host) return { kind: "rpc", message: host, hash };
  const code = parseContractError(text);
  if (code != null) return { kind: "typed", errorCode: code, errorName: errorName(code), at, hash };
  if (/footprint|ExceededLimit|storage.*exceeded/i.test(text) && !/TxSorobanInvalid/.test(text)) {
    return { kind: "footprint", hash };
  }
  return { kind: "rpc", message: text.slice(0, 400), hash };
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
      return { kind: "ok", hash, ledger: r.ledger, fee: chargedFee(r) };
    }
    if (r.status === "FAILED") {
      const text = [r.resultXdr, ...(r.diagnosticEventsXdr ?? [])].filter(Boolean).join("\n");
      return classify(text || "transaction failed", "apply", hash);
    }
    delay = Math.min(Math.round(delay * 1.4), 2000);
  }
  return { kind: "rpc", message: "timed out waiting for transaction", hash };
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
};

export async function submitInvocation(a: SubmitArgs): Promise<EngineResult> {
  const kp = StellarSdk.Keypair.fromSecret(a.sourceSecret);
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
  if (sim.error) return classify(sim.error, "simulation");
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
  const padded = applyPad(existing, extraXdr, archivedIdx);
  const fee = classicFee(padded.resourceFee);
  const finalTx = StellarSdk.TransactionBuilder.cloneFrom(assembled, { fee }).setSorobanData(padded.data).build();
  finalTx.sign(kp);

  try {
    const sent = await a.rpc.sendTransaction(finalTx.toXDR());
    const hash = sent.hash;
    if (!hash) return { kind: "rpc", message: sent.message || sent.status || "no hash" };
    if (sent.status === "ERROR") return classify(sent.message || sent.errorResultXdr || "sendTransaction ERROR", "apply", hash);
    if (sent.status === "TRY_AGAIN_LATER") return { kind: "rpc", message: "try again later", hash };
    return waitTx(a.rpc, hash);
  } catch (e) {
    return { kind: "rpc", message: e instanceof Error ? e.message : String(e) };
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
  },
): Promise<EngineResult> {
  const out = pad(opts.quoted, opts.padEnd);
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
  });
}
