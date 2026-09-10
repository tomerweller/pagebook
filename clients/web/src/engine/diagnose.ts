import * as StellarSdk from "@stellar/stellar-sdk";
import { scValKeyName } from "./clientKeys";
import { errorName, hostErrorMessage, parseContractError, sacErrorName } from "./errors";
import type { EnginePhase, EngineResult } from "./op";

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

export function sorobanReturnValue(meta: StellarSdk.xdr.TransactionMeta): StellarSdk.xdr.ScVal | null {
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

export function sendFailureText(sent: { status: string; message?: string; errorResultXdr?: string }): string {
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

export function chargedFee(r: { feeCharged?: number | string; resultXdr?: string }): string | undefined {
  if (r.feeCharged != null && r.feeCharged !== "") return String(r.feeCharged);
  if (!r.resultXdr) return undefined;
  try {
    return StellarSdk.xdr.TransactionResult.fromXDR(r.resultXdr, "base64").feeCharged().toString();
  } catch {
    return undefined;
  }
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
