import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, renameSync } from "node:fs";
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

// The bots run for weeks on a 1 GB volume; an unrotated log eventually fills
// it (and anything that reads the whole file). One rotated generation is kept.
export const ROTATE_BYTES = 64 * 1024 * 1024;

export function openLog(
  path: string,
  now: () => number = () => Date.now() / 1000,
  opts: { rotateBytes?: number } = {},
): OpsLog {
  mkdirSync(dirname(path), { recursive: true });
  let fd = openSync(path, "a");
  const cap = opts.rotateBytes ?? ROTATE_BYTES;
  return {
    record(action, outcome, extra = {}) {
      const d: LogLine = { t: now(), action, outcome, ...extra };
      appendFileSync(fd, JSON.stringify(d) + "\n");
      if (cap > 0 && fstatSync(fd).size >= cap) {
        closeSync(fd);
        renameSync(path, path + ".1");
        fd = openSync(path, "a");
      }
      return d;
    },
    close() {
      closeSync(fd);
    },
  };
}
