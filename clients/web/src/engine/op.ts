import * as StellarSdk from "@stellar/stellar-sdk";
import { instanceKey, sacBalanceKey } from "../keys";
import { accountLedgerKey, trustlineLedgerKey } from "../wallet/account";
import { scValKeyName, type PlannedLedgerKey } from "./clientKeys";
import { errorName, hostErrorMessage, parseContractError, sacErrorName } from "./errors";
import type { DeclaredResources } from "./txdata";

export type PlaceFlags = {
  post_only: boolean;
  fill_or_kill: boolean;
  no_rest: boolean;
};

export type EnginePhase = "simulation" | "apply" | "send" | "prepare";
export type EngineOk = { kind: "ok"; hash: string; ledger?: number; fee?: string; resultMetaXdr?: string };
// `raisedBy` is the contract the diagnostic events attribute the error to,
// when they carry one. `foreign` means it was some contract other than the
// one invoked — for PageBook that can only be a token, so the code was
// decoded through the SAC error table instead of PageBook's.
export type EngineTyped = {
  kind: "typed";
  errorCode: number;
  errorName: string;
  at: "simulation" | "apply";
  hash?: string;
  raisedBy?: string;
  foreign?: boolean;
};
export type EngineFootprint = { kind: "footprint"; missingKey?: string; hash?: string; at?: EnginePhase };
export type EngineBadSeq = { kind: "txBadSeq"; message: string; hash?: string; reachedLedger?: boolean; at?: EnginePhase };
export type EngineResourceLimit = {
  kind: "resourceLimit";
  message: string;
  hash?: string;
  at?: EnginePhase;
  declared?: DeclaredResources;
};
export type EngineSorobanInvalid = { kind: "sorobanInvalid"; message: string; hash?: string; at?: EnginePhase };
export type EngineTimeout = { kind: "timeout"; message: string; hash: string };
export type EngineRpc = { kind: "rpc"; message: string; hash?: string; at?: EnginePhase };
export type EngineTrapped = { kind: "trapped"; message?: string; hash?: string; at?: EnginePhase };
export type EngineArchived = {
  kind: "archived";
  keyName: string;
  keyXdr: string;
  at: "apply" | "simulation";
  hash?: string;
};
export type EngineBody =
  | EngineOk
  | EngineTyped
  | EngineFootprint
  | EngineBadSeq
  | EngineResourceLimit
  | EngineSorobanInvalid
  | EngineTimeout
  | EngineRpc
  | EngineTrapped
  | EngineArchived;
export type EngineResult = EngineBody & { declared?: DeclaredResources };

export type ClassicToken = { sac: string; code?: string; issuer?: string };

export function tokenExtraKeys(pagebook: string, caller: string, tokens: ClassicToken[]): PlannedLedgerKey[] {
  const keys: PlannedLedgerKey[] = [];
  for (const t of tokens) {
    keys.push({ key: instanceKey(t.sac).xdr, access: "ro" });
    keys.push({ key: sacBalanceKey(t.sac, pagebook).xdr, access: "rw" });
    if (t.code && t.issuer) {
      keys.push({ key: trustlineLedgerKey(caller, { type: "credit", code: t.code, issuer: t.issuer }), access: "rw" });
    } else {
      keys.push({ key: accountLedgerKey(caller), access: "rw" });
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

export function scReplaceItem(item: {
  nonce: bigint;
  isBid: boolean;
  tick: number;
  qtyLots: bigint;
}): StellarSdk.xdr.ScVal {
  return scvMap([
    ["nonce", scvU64(item.nonce)],
    ["is_bid", scvBool(item.isBid)],
    ["tick", scvU32(item.tick)],
    ["qty_lots", scvU64(item.qtyLots)],
  ]);
}

export type PlaceArgParams = {
  taker: string;
  market: number;
  isBid: boolean;
  limitTick: number;
  qtyLots: bigint;
  startTick: number;
  nonce: bigint;
  flags: PlaceFlags;
};

export function buildPlaceArgs(opts: PlaceArgParams): StellarSdk.xdr.ScVal[] {
  return [
    scvAddr(opts.taker),
    scvU32(opts.market),
    scvBool(opts.isBid),
    scvU32(opts.limitTick),
    scvU64(opts.qtyLots),
    scvU32(opts.startTick),
    scvU64(opts.nonce),
    scPlaceFlags(opts.flags),
  ];
}

export function classifySubmit(
  text: string,
  at: EnginePhase,
  hash?: string,
): EngineResult {
  const typedAt: "simulation" | "apply" = at === "simulation" ? "simulation" : "apply";
  const host = hostErrorMessage(text);
  if (host) return { kind: "rpc", message: host, hash, at };
  const archived = archivedFromText(text);
  if (archived) return { ...archived, at: typedAt === "simulation" ? "simulation" : "apply", hash };
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

export const ARCHIVED_ENTRY_MSG = "trying to access an archived contract data entry";

export function archivedFromText(text: string): { kind: "archived"; keyName: string; keyXdr: string } | null {
  if (!new RegExp(`${ARCHIVED_ENTRY_MSG}|EntryArchived|invalid_input.*archived`, "i").test(text)) {
    return null;
  }
  return { kind: "archived", keyName: "unknown", keyXdr: "" };
}

export function extractArchivedKey(data: StellarSdk.xdr.ScVal): { keyName: string; keyXdr: string } | undefined {
  try {
    if (data.switch().name !== "scvVec") return undefined;
    const vec = data.vec() ?? [];
    let sawMsg = false;
    let afterAddr: StellarSdk.xdr.ScVal | undefined;
    for (let i = 0; i < vec.length; i++) {
      const v = vec[i];
      const sw = v.switch().name;
      if (sw === "scvString" || sw === "scvSymbol") {
        try {
          if (String(StellarSdk.scValToNative(v)).includes(ARCHIVED_ENTRY_MSG)) {
            sawMsg = true;
          }
        } catch {
          /* ignore */
        }
      }
      if (sw === "scvAddress" && i + 1 < vec.length) afterAddr = vec[i + 1];
    }
    if (!sawMsg) return undefined;
    if (afterAddr) return { keyName: scValKeyName(afterAddr), keyXdr: afterAddr.toXDR("base64") };
    return { keyName: "unknown", keyXdr: "" };
  } catch {
    return undefined;
  }
}

type FailedHints = {
  contract?: number;
  // Contract address the first error-carrying diagnostic event names. Errors
  // abort execution, so that first event is the deepest frame — the raiser;
  // later events for the same error are the parent frames escalating it.
  raisedBy?: string;
  footprint: boolean;
  resource: boolean;
  archived?: { keyName: string; keyXdr: string };
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
      if (kind === "sceContract" && hints.contract == null) hints.contract = err.contractCode();
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
    const hadContract = hints.contract != null;
    const v0 = ev.event().body().v0();
    for (const topic of v0.topics()) {
      walkScVal(topic, hints, texts);
      try {
        const native = StellarSdk.scValToNative(topic);
        const code = contractCodeFromNative(native);
        if (code != null && hints.contract == null) hints.contract = code;
      } catch {
        /* ignore */
      }
    }
    walkScVal(v0.data(), hints, texts);
    const archived = extractArchivedKey(v0.data());
    if (archived) hints.archived = archived;
    try {
      const native = StellarSdk.scValToNative(v0.data());
      const code = contractCodeFromNative(native);
      if (code != null && hints.contract == null) hints.contract = code;
    } catch {
      /* ignore */
    }
    if (!hadContract && hints.contract != null) {
      try {
        const id = ev.event().contractId();
        if (id) hints.raisedBy = StellarSdk.StrKey.encodeContract(id);
      } catch {
        /* attribution stays unknown */
      }
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
  at: "apply" | "simulation" = "apply",
  invokedContract?: string,
): EngineResult {
  const hints: FailedHints = { footprint: false, resource: false };
  const texts: string[] = [];
  if (resultXdr) diagnoseResultXdr(resultXdr, hints);
  for (const b64 of diagnosticEventsXdr ?? []) diagnoseEvent(b64, hints, texts);
  const blob = texts.join("\n");
  if (/trying to access contract data key outside of the footprint/i.test(blob)) hints.footprint = true;
  if (hints.archived || blob.includes(ARCHIVED_ENTRY_MSG) || /EntryArchived/i.test(blob)) {
    return {
      kind: "archived",
      keyName: hints.archived?.keyName ?? "unknown",
      keyXdr: hints.archived?.keyXdr ?? "",
      at,
      hash,
    };
  }
  if (hints.contract != null) {
    // Contract error codes are per-table: only decode through PageBook's table
    // when PageBook raised it. Any other raiser is a token (the contract calls
    // nothing else), so a foreign error decodes through the SAC table. With no
    // attribution (no contractId in the events), keep the old PageBook decode.
    const foreign = hints.raisedBy != null && invokedContract != null && hints.raisedBy !== invokedContract;
    return {
      kind: "typed",
      errorCode: hints.contract,
      errorName: foreign ? sacErrorName(hints.contract) : errorName(hints.contract),
      at,
      hash,
      raisedBy: hints.raisedBy,
      foreign,
    };
  }
  if (hints.footprint) return { kind: "footprint", hash, at };
  if (hints.resource) return { kind: "resourceLimit", message: "ResourceLimitExceeded", hash, at };
  return { kind: "trapped", hash, at };
}
