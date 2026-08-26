import { ERROR_NAMES } from "../../src/engine/errors";
import type { EngineResult } from "../../src/engine/submit";

export const ERR_NAMES: Record<number, string> = { ...ERROR_NAMES };

export type OutcomeInput =
  | EngineResult
  | { kind: "build_error"; message?: string }
  | { kind: "sign_error"; message?: string };

function withSim(at: string | undefined, name: string): string {
  return at === "simulation" ? `sim:${name}` : name;
}

export function outcomeOf(result: OutcomeInput, opts?: { events?: unknown }): string {
  switch (result.kind) {
    case "ok":
      return "ok";
    case "typed":
      return withSim(result.at, `typed:${result.errorName}`);
    case "footprint":
      return withSim(result.at, "footprint");
    case "txBadSeq":
      return withSim(result.at, "bad_seq");
    case "resourceLimit":
      return withSim(result.at, "resource_limit");
    case "sorobanInvalid":
      return withSim(result.at, "soroban_invalid");
    case "timeout":
      return "rpc_timeout";
    case "build_error":
      return "build_error";
    case "sign_error":
      return "sign_error";
    case "trapped":
      return withSim(result.at, "trapped:unknown");
    case "archived":
      return withSim(result.at, `archived:${result.keyName || "unknown"}`);
    case "rpc": {
      if (opts?.events != null) return withSim(result.at, diagnoseEvents(opts.events));
      return classifyText(result.message, { sim: result.at === "simulation" });
    }
  }
}

export function classifyText(text: string, opts?: { sim?: boolean }): string {
  const inner = classifyBody(text);
  if (opts?.sim) return `sim:${inner}`;
  return inner;
}

function classifyBody(text: string): string {
  const contract = contractErrorName(text);
  if (contract) return `typed:${contract}`;
  if (isFootprint(text)) return "footprint";
  if (/trying to access an archived contract data entry|EntryArchived/i.test(text)) return "archived:unknown";
  if (/TxSorobanInvalid/.test(text)) return "soroban_invalid";
  if (/txBadSeq|BAD_SEQ/.test(text)) return "bad_seq";
  if (/ResourceLimitExceeded/.test(text)) return "resource_limit";
  if (/submission timeout/i.test(text) || /timed out/i.test(text)) return "rpc_timeout";
  return "other";
}

export function diagnoseEvents(events: unknown): string {
  const text = typeof events === "string" ? events : JSON.stringify(events);
  const contract = contractErrorName(text);
  if (contract) return `typed:${contract}`;
  if (/trying to access an archived contract data entry|EntryArchived/i.test(text)) return "archived:unknown";
  if (isFootprint(text) || /"storage"/i.test(text)) return "footprint";
  // A trapped transaction whose events match nothing known is the one outcome
  // the watchdog must never mistake for benign noise (check.py's bad set).
  return "trapped:unknown";
}

function contractErrorName(text: string): string | null {
  const m = text.match(
    /"contract_error"[^0-9]*(\d+)|Error\(Contract, #(\d+)\)|"error"\s*:\s*\{\s*"contract"\s*:\s*(\d+)\}/,
  );
  if (!m) return null;
  const code = Number(m[1] || m[2] || m[3]);
  return ERR_NAMES[code] ?? String(code);
}

function isFootprint(text: string): boolean {
  if (/TxSorobanInvalid/.test(text)) return false;
  if (/trying to access contract data key outside of the footprint/i.test(text)) return true;
  if (/Error\(Storage, /i.test(text)) return true;
  if (/exceeded_limit/i.test(text) && /storage/i.test(text)) return true;
  if (/footprint/i.test(text)) return true;
  return false;
}
