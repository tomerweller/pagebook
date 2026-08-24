import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLine = {
  t: number;
  action: string;
  outcome: string;
  [k: string]: unknown;
};

export type OpsLog = {
  record: (action: string, outcome: string, extra?: Record<string, unknown>) => LogLine;
};

export function openLog(path: string, now: () => number = () => Date.now() / 1000): OpsLog {
  mkdirSync(dirname(path), { recursive: true });
  return {
    record(action, outcome, extra = {}) {
      const d: LogLine = { t: now(), action, outcome, ...extra };
      appendFileSync(path, JSON.stringify(d) + "\n");
      return d;
    },
  };
}
