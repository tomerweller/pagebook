import { formatInt, formatRatio, ticksToPrice, formatAtoms } from "../decode";
import type { BookSnapshot, TokenMeta } from "../book";

export type UrlOverrides = {
  baseSym: string | null;
  quoteSym: string | null;
  baseDec: number | null;
  quoteDec: number | null;
};

export function shortAddr(a: string | null | undefined): string {
  if (!a || a.length < 12) return a || "";
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export function shortHash(hash: string): string {
  if (!hash) return "";
  return `${hash.slice(0, 6)}…`;
}

export function txLink(hash: string): string {
  if (!hash) return "";
  return `<a href="https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(hash)}">${esc(shortHash(hash))}</a>`;
}

export function countLabel(n: number | bigint, singular: string, plural = `${singular}s`): string {
  const v = typeof n === "bigint" ? n : BigInt(n);
  return `${v.toString()} ${v === 1n ? singular : plural}`;
}

export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function fmtTime(iso: string | undefined): { text: string; title: string } {
  if (!iso) return { text: "", title: "" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { text: String(iso).slice(11, 19), title: String(iso) };
  return {
    text: d.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    title: d.toISOString(),
  };
}

export function contractLink(id: string, testnet: boolean): string {
  const short = esc(shortAddr(id));
  if (!testnet) return short;
  return `<a href="https://stellar.expert/explorer/testnet/contract/${encodeURIComponent(id)}" title="${esc(id)}">${short}</a>`;
}

export function tokenLabel(meta: TokenMeta | null | undefined, urlSym: string | null, addr: string | null): string {
  return urlSym || meta?.symbol || shortAddr(addr) || "?";
}

export function tokenDecimals(meta: TokenMeta | null | undefined, urlDec: number | null): number {
  if (urlDec != null && !Number.isNaN(urlDec)) return urlDec;
  if (meta?.decimals != null) return meta.decimals;
  return 7;
}

export function priceOf(tick: number, book: BookSnapshot, overrides: UrlOverrides): string {
  const m = book.market;
  if (!m) return String(tick);
  const bd = tokenDecimals(book.tokens?.base, overrides.baseDec);
  const qd = tokenDecimals(book.tokens?.quote, overrides.quoteDec);
  return ticksToPrice(tick, m.tick_size, m.lot_size, bd, qd);
}

/// Lots expressed in base units (lots × lot_size atoms at the base token's
/// decimals). The ladder, tape, and last-KPI quantities read in base units;
/// exact lots stay in tooltips, like atoms.
export function lotsToBase(lots: bigint | number, book: BookSnapshot, overrides: UrlOverrides): string {
  const m = book.market;
  const n = typeof lots === "bigint" ? lots : BigInt(lots);
  if (!m) return formatInt(n);
  const bd = tokenDecimals(book.tokens?.base, overrides.baseDec);
  return formatAtoms(n * BigInt(m.lot_size), bd);
}

export function midSpread(
  bid: BookSnapshot["bestBid"],
  ask: BookSnapshot["bestAsk"],
  book: BookSnapshot,
  overrides: UrlOverrides,
): { spread: string | null; mid: string | null; pct: string | null; ticks: string | null } {
  if (bid.empty || ask.empty) return { spread: null, mid: null, pct: null, ticks: null };
  const b = BigInt(bid.tick);
  const a = BigInt(ask.tick);
  const spreadTicks = a - b;
  const sum = a + b;
  const m = book.market;
  const ts = m ? BigInt(m.tick_size) : 1n;
  const ls = m ? BigInt(m.lot_size) : 1n;
  const bd = BigInt(m ? tokenDecimals(book.tokens?.base, overrides.baseDec) : 0);
  const qd = BigInt(m ? tokenDecimals(book.tokens?.quote, overrides.quoteDec) : 0);
  const num = ts * 10n ** bd;
  const den = ls * 10n ** qd;
  const spread = formatRatio(spreadTicks * num, den);
  const mid = formatRatio(sum * num, 2n * den);
  const hundredths = sum === 0n ? 0n : (spreadTicks * 20000n) / sum;
  const pct = `${formatInt(hundredths / 100n)}.${(hundredths % 100n).toString().padStart(2, "0")}%`;
  return { spread, mid, pct, ticks: formatInt(spreadTicks) };
}
