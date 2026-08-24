import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export type LogLine = {
  t: number;
  action: string;
  outcome: string;
  [k: string]: unknown;
};

export type OpsLog = {
  record: (action: string, outcome: string, extra?: Record<string, unknown>) => LogLine;
  close: () => void;
};

export function openLog(path: string, now: () => number = () => Date.now() / 1000): OpsLog {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  return {
    record(action, outcome, extra = {}) {
      const d: LogLine = { t: now(), action, outcome, ...extra };
      appendFileSync(fd, JSON.stringify(d) + "\n");
      return d;
    },
    close() {
      closeSync(fd);
    },
  };
}
