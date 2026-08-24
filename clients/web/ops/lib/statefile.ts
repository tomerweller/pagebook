import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type QuoteState = {
  side: "bid" | "ask";
  tick: number;
  lots: number;
  slot: number;
  t: number;
  filled_lots?: number;
  [k: string]: unknown;
};

export type MmState = {
  quotes: Record<string, QuoteState>;
  next_nonce: number;
  fills: number;
  volume_lots: number;
  inv0?: { xlm: number; usdc: number };
};

export function emptyState(now = Date.now() / 1000): MmState {
  return { quotes: {}, next_nonce: Math.floor(now) * 1000, fills: 0, volume_lots: 0 };
}

export function loadState(path: string, now = Date.now() / 1000): MmState {
  const base = emptyState(now);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<MmState>;
    return {
      quotes: raw.quotes ?? base.quotes,
      next_nonce: raw.next_nonce ?? base.next_nonce,
      fills: raw.fills ?? base.fills,
      volume_lots: raw.volume_lots ?? base.volume_lots,
      ...(raw.inv0 ? { inv0: raw.inv0 } : {}),
    };
  } catch {
    return base;
  }
}

export function saveState(path: string, state: MmState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}
