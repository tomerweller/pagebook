import type { EngineResult } from "../../src/engine/submit";
import { repr } from "./math";
import { outcomeOf, type OutcomeInput } from "./outcomes";

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function detailOf(text: string, outcome: string): string {
  if (outcome === "ok") return "";
  return text.length > 460 ? text.slice(0, 300) + " ... " + text.slice(-160) : text;
}

export function resultText(res: OutcomeInput): string {
  if (res.kind === "ok") return "";
  if ("message" in res && res.message) return res.message;
  if (res.kind === "typed") return `${res.errorName}@${res.at}`;
  if (res.kind === "footprint") return res.missingKey ?? "footprint";
  if (res.kind === "archived") return `archived:${res.keyName}`;
  return res.kind;
}

export function recordSubmit(
  log: { record: (action: string, outcome: string, extra?: Record<string, unknown>) => unknown },
  label: string,
  res: OutcomeInput,
  extra: Record<string, unknown> = {},
): string {
  const out = outcomeOf(res);
  const text = resultText(res);
  const tx = "hash" in res ? (res as { hash?: string }).hash ?? "" : "";
  log.record(label, out, { tx, detail: detailOf(text, out), ...extra });
  return out;
}

export type SubmitPair = { out: string; res: OutcomeInput };

export async function runSubmit(
  log: { record: (action: string, outcome: string, extra?: Record<string, unknown>) => unknown },
  label: string,
  extra: Record<string, unknown>,
  run: () => Promise<EngineResult>,
): Promise<SubmitPair> {
  let res: OutcomeInput;
  try {
    res = await run();
  } catch (e) {
    res = { kind: "build_error", message: repr(e) };
  }
  const out = recordSubmit(log, label, res, extra);
  return { out, res };
}
