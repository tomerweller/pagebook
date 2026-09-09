import * as StellarSdk from "@stellar/stellar-sdk";
import { createRpc, type Rpc } from "../book";
import { readAccount } from "../wallet/account";
import { NETWORK_PASSPHRASE } from "../wallet/network";
import { type Hex32 } from "./clientKeys";
import {
  classifyFailedTx,
  classifySubmit,
  type ClassicToken,
  type EngineResult,
  type PlaceArgParams,
} from "./op";
import { type Quoted } from "./pad";
import { prepareInvocation, type Intent, type PadPolicy, type PrepareRequest } from "./prepare";
import { simulate } from "./quote";
import { classicFee, type DeclaredResources } from "./txdata";

export type { Intent, PadPolicy, PrepareRequest };
export type { DeclaredResources };
export {
  ARCHIVED_ENTRY_MSG,
  archivedFromText,
  buildPlaceArgs,
  classifyFailedTx,
  classifySubmit,
  extractArchivedKey,
  scPlaceFlags,
  scReplaceItem,
  scvAddr,
  scvBool,
  scvU32,
  scvU64,
  tokenExtraKeys,
} from "./op";
export type {
  ClassicToken,
  EngineArchived,
  EngineBadSeq,
  EngineBody,
  EngineFootprint,
  EngineOk,
  EnginePhase,
  EngineResourceLimit,
  EngineResult,
  EngineRpc,
  EngineSorobanInvalid,
  EngineTimeout,
  EngineTrapped,
  EngineTyped,
  PlaceArgParams,
  PlaceFlags,
} from "./op";

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

async function waitTx(rpc: Rpc, hash: string, invokedContract?: string): Promise<EngineResult> {
  let delay = 400;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, delay));
    const r = await rpc.getTransaction(hash);
    if (r.status === "SUCCESS") {
      return { kind: "ok", hash, ledger: r.ledger, fee: chargedFee(r), resultMetaXdr: r.resultMetaXdr };
    }
    if (r.status === "FAILED") {
      return classifyFailedTx(r.resultXdr, r.diagnosticEventsXdr, hash, "apply", invokedContract);
    }
    delay = Math.min(Math.round(delay * 1.4), 2000);
  }
  return { kind: "timeout", message: "timed out waiting for transaction", hash };
}

export async function submitInvocation(rpc: Rpc, secret: string, req: PrepareRequest): Promise<EngineResult> {
  const kp = StellarSdk.Keypair.fromSecret(secret);
  let retriedBadSeq = false;
  let restores = 0;
  for (;;) {
    const prepared = await prepareInvocation(rpc, { ...req, source: req.source || kp.publicKey() });
    if (prepared.kind === "restoreNeeded") {
      if (restores >= 2) return { kind: "rpc", message: "restore preamble persisted" };
      const restored = await submitRestorePreamble(rpc, secret, prepared.preamble);
      if (restored.kind !== "ok") return restored;
      restores += 1;
      continue;
    }
    if (prepared.kind !== "prepared") return prepared;
    const tx = prepared.tx;
    tx.sign(kp);
    const result = await sendAndWait(rpc, tx, prepared.declared, req.contract);
    if (result.kind === "txBadSeq" && !result.reachedLedger && !retriedBadSeq) {
      retriedBadSeq = true;
      continue;
    }
    return result;
  }
}

async function sendAndWait(
  rpc: Rpc,
  tx: StellarSdk.Transaction,
  declared?: DeclaredResources,
  invokedContract?: string,
): Promise<EngineResult> {
  try {
    const sent = await rpc.sendTransaction(tx.toXDR());
    const hash = sent.hash;
    const failText = sendFailureText(sent);
    if (sent.status === "ERROR") {
      return { ...classifySubmit(failText || "sendTransaction ERROR", "send", hash), declared };
    }
    if (!hash) return { kind: "rpc", message: sent.message || sent.status || "no hash", declared };
    if (sent.status === "TRY_AGAIN_LATER") return { kind: "rpc", message: "try again later", hash, declared };
    return { ...(await waitTx(rpc, hash, invokedContract)), declared };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ...classifySubmit(message, "send"), declared };
  }
}

export function ledgerKeyFromKeyXdr(contract: string, b64: string): StellarSdk.xdr.LedgerKey {
  try {
    const lk = StellarSdk.xdr.LedgerKey.fromXDR(b64, "base64");
    if (lk.switch().name === "contractData") return lk;
  } catch {
    /* ScVal storage key */
  }
  const scv = StellarSdk.xdr.ScVal.fromXDR(b64, "base64");
  return StellarSdk.xdr.LedgerKey.contractData(
    new StellarSdk.xdr.LedgerKeyContractData({
      contract: new StellarSdk.Address(contract).toScAddress(),
      key: scv,
      durability: StellarSdk.xdr.ContractDataDurability.persistent(),
    }),
  );
}

function parseSorobanData(raw: unknown): StellarSdk.xdr.SorobanTransactionData {
  if (typeof raw === "string") return StellarSdk.xdr.SorobanTransactionData.fromXDR(raw, "base64");
  if (raw && typeof raw === "object" && "build" in raw && typeof (raw as { build: () => unknown }).build === "function") {
    return (raw as StellarSdk.SorobanDataBuilder).build();
  }
  if (raw && typeof raw === "object" && "toXDR" in raw) return raw as StellarSdk.xdr.SorobanTransactionData;
  throw new Error("bad restore preamble transactionData");
}

export async function submitRestorePreamble(
  rpc: Rpc,
  secret: string,
  preamble: { transactionData?: unknown; minResourceFee?: string },
): Promise<EngineResult> {
  if (preamble.transactionData == null) return { kind: "rpc", message: "restore preamble missing transactionData" };
  const kp = StellarSdk.Keypair.fromSecret(secret);
  const acc = await readAccount(rpc, kp.publicKey());
  if (!acc.exists) return { kind: "rpc", message: "account not funded" };
  const account = new StellarSdk.Account(kp.publicKey(), acc.sequence.toString());
  let data: StellarSdk.xdr.SorobanTransactionData;
  try {
    data = parseSorobanData(preamble.transactionData);
  } catch (e) {
    return { kind: "rpc", message: e instanceof Error ? e.message : String(e) };
  }
  const fee = classicFee(BigInt(preamble.minResourceFee ?? data.resourceFee().toString()));
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(StellarSdk.Operation.restoreFootprint())
    .setTimeout(60)
    .setSorobanData(data)
    .build();
  tx.sign(kp);
  return sendAndWait(rpc, tx);
}

export async function restoreKeys(
  rpc: Rpc,
  secret: string,
  contract: string,
  keyXdrs: string[],
): Promise<EngineResult> {
  if (!keyXdrs.length) return { kind: "rpc", message: "no keys to restore" };
  const kp = StellarSdk.Keypair.fromSecret(secret);
  const acc = await readAccount(rpc, kp.publicKey());
  if (!acc.exists) return { kind: "rpc", message: "account not funded" };
  const account = new StellarSdk.Account(kp.publicKey(), acc.sequence.toString());
  let keys: StellarSdk.xdr.LedgerKey[];
  try {
    keys = keyXdrs.map((b64) => ledgerKeyFromKeyXdr(contract, b64));
  } catch (e) {
    return { kind: "rpc", message: e instanceof Error ? e.message : String(e) };
  }
  const data = new StellarSdk.SorobanDataBuilder().setReadWrite(keys).build();
  const built = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(StellarSdk.Operation.restoreFootprint())
    .setTimeout(60)
    .setSorobanData(data)
    .build();

  let sim;
  try {
    sim = await simulate(rpc, built.toXDR());
  } catch (e) {
    return { kind: "rpc", message: e instanceof Error ? e.message : String(e) };
  }
  if (sim.error) return classifySubmit(sim.error, "simulation");
  const priced = sim.transactionData ? parseSorobanData(sim.transactionData) : data;
  const fee = classicFee(BigInt(sim.minResourceFee ?? priced.resourceFee().toString()));
  const finalTx = StellarSdk.TransactionBuilder.cloneFrom(built, { fee }).setSorobanData(priced).build();
  finalTx.sign(kp);
  return sendAndWait(rpc, finalTx);
}

export async function restoreEntries(
  rpcUrl: string,
  secret: string,
  contract: string,
  keyXdrs: string[],
): Promise<EngineResult> {
  return restoreKeys(createRpc(rpcUrl), secret, contract, keyXdrs);
}

export async function extendKeys(
  rpc: Rpc,
  secret: string,
  keyXdrs: string[],
  extendTo: number,
): Promise<EngineResult> {
  if (!keyXdrs.length) return { kind: "ok", hash: "" };
  const kp = StellarSdk.Keypair.fromSecret(secret);
  const acc = await readAccount(rpc, kp.publicKey());
  if (!acc.exists) return { kind: "rpc", message: "account not funded" };
  const account = new StellarSdk.Account(kp.publicKey(), acc.sequence.toString());
  let keys: StellarSdk.xdr.LedgerKey[];
  try {
    keys = keyXdrs.map((b64) => StellarSdk.xdr.LedgerKey.fromXDR(b64, "base64"));
  } catch (e) {
    return { kind: "rpc", message: e instanceof Error ? e.message : String(e) };
  }
  const data = new StellarSdk.SorobanDataBuilder().setReadOnly(keys).build();
  const built = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(StellarSdk.Operation.extendFootprintTtl({ extendTo }))
    .setTimeout(60)
    .setSorobanData(data)
    .build();
  let sim;
  try {
    sim = await simulate(rpc, built.toXDR());
  } catch (e) {
    return { kind: "rpc", message: e instanceof Error ? e.message : String(e) };
  }
  if (sim.error) return classifySubmit(sim.error, "simulation");
  const priced = sim.transactionData ? parseSorobanData(sim.transactionData) : data;
  const fee = classicFee(BigInt(sim.minResourceFee ?? priced.resourceFee().toString()));
  const finalTx = StellarSdk.TransactionBuilder.cloneFrom(built, { fee }).setSorobanData(priced).build();
  finalTx.sign(kp);
  return sendAndWait(rpc, finalTx);
}

function invocationReq(
  secret: string,
  opts: { contract: string; tokens: ClassicToken[]; policy?: PadPolicy; levelCap?: number },
  intent: Intent,
): PrepareRequest {
  return {
    contract: opts.contract,
    source: StellarSdk.Keypair.fromSecret(secret).publicKey(),
    intent,
    tokens: opts.tokens,
    policy: opts.policy,
    levelCap: opts.levelCap,
  };
}

export async function submitPlace(
  rpc: Rpc,
  opts: PlaceArgParams & {
    contract: string;
    secret: string;
    quoted: Quoted;
    tokens: ClassicToken[];
    padEnd: number;
    policy?: PadPolicy;
    levelCap?: number;
  },
): Promise<EngineResult> {
  return submitInvocation(
    rpc,
    opts.secret,
    invocationReq(opts.secret, opts, {
      kind: "place",
      taker: opts.taker,
      market: opts.market,
      isBid: opts.isBid,
      limitTick: opts.limitTick,
      qtyLots: opts.qtyLots,
      startTick: opts.startTick,
      nonce: opts.nonce,
      flags: opts.flags,
      quoted: opts.quoted,
      padEnd: opts.padEnd,
    }),
  );
}

export async function submitPostOnlyPlace(
  rpc: Rpc,
  opts: PlaceArgParams & {
    contract: string;
    secret: string;
    tokens: ClassicToken[];
    base: Hex32;
    quote: Hex32;
    policy?: PadPolicy;
    levelCap?: number;
  },
): Promise<EngineResult> {
  return submitInvocation(
    rpc,
    opts.secret,
    invocationReq(opts.secret, opts, {
      kind: "placePostOnly",
      taker: opts.taker,
      market: opts.market,
      isBid: opts.isBid,
      limitTick: opts.limitTick,
      qtyLots: opts.qtyLots,
      startTick: opts.startTick,
      nonce: opts.nonce,
      flags: opts.flags,
      base: opts.base,
      quote: opts.quote,
    }),
  );
}

export async function submitSettle(
  rpc: Rpc,
  opts: {
    contract: string;
    secret: string;
    owner: string;
    market: number;
    nonce: bigint;
    tokens: ClassicToken[];
    base: Hex32;
    quote: Hex32;
    policy?: PadPolicy;
    levelCap?: number;
  },
): Promise<EngineResult> {
  return submitInvocation(
    rpc,
    opts.secret,
    invocationReq(opts.secret, opts, {
      kind: "settle",
      owner: opts.owner,
      market: opts.market,
      nonce: opts.nonce,
      base: opts.base,
      quote: opts.quote,
    }),
  );
}

export async function submitReplaceBatch(
  rpc: Rpc,
  opts: {
    contract: string;
    secret: string;
    owner: string;
    market: number;
    items: { nonce: bigint; isBid: boolean; tick: number; qtyLots: bigint }[];
    tokens: ClassicToken[];
    base: Hex32;
    quote: Hex32;
    policy?: PadPolicy;
    levelCap?: number;
  },
): Promise<EngineResult> {
  return submitInvocation(
    rpc,
    opts.secret,
    invocationReq(opts.secret, opts, {
      kind: "replaceBatch",
      owner: opts.owner,
      market: opts.market,
      items: opts.items,
      base: opts.base,
      quote: opts.quote,
    }),
  );
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
    tokens: ClassicToken[];
    base: Hex32;
    quote: Hex32;
    policy?: PadPolicy;
    levelCap?: number;
  },
): Promise<EngineResult> {
  return submitInvocation(
    rpc,
    opts.secret,
    invocationReq(opts.secret, opts, {
      kind: "replace",
      owner: opts.owner,
      market: opts.market,
      nonce: opts.nonce,
      isBid: opts.isBid,
      tick: opts.tick,
      qtyLots: opts.qtyLots,
      base: opts.base,
      quote: opts.quote,
    }),
  );
}
