import type { BookSnapshot } from "../book";
import type { OpenOrder } from "./orders";

export function noteFills(
  prev: Record<string, string>,
  rows: OpenOrder[],
): { next: Record<string, string>; added: number } {
  const next = { ...prev };
  let added = 0;
  for (const r of rows) {
    const k = r.nonce.toString();
    const cur = r.filledLots.toString();
    if (!(k in prev)) {
      next[k] = cur;
      continue;
    }
    if (r.filledLots > BigInt(prev[k])) added += 1;
    next[k] = cur;
  }
  return { next, added };
}

export function ordersBeyondWindow(
  rows: OpenOrder[],
  book: BookSnapshot | null,
): { above: OpenOrder[]; below: OpenOrder[] } {
  const asks = book?.asks ?? [];
  const bids = book?.bids ?? [];
  const maxAsk = asks.length ? Math.max(...asks.map((r) => r.tick)) : null;
  const minBid = bids.length ? Math.min(...bids.map((r) => r.tick)) : null;
  const above = rows.filter((o) => !o.isBid && (maxAsk == null || o.tick > maxAsk));
  const below = rows.filter((o) => o.isBid && (minBid == null || o.tick < minBid));
  return { above, below };
}

export function closestBeyond(rows: OpenOrder[], side: "ask" | "bid"): OpenOrder | null {
  if (!rows.length) return null;
  return side === "ask"
    ? rows.reduce((a, b) => (a.tick < b.tick ? a : b))
    : rows.reduce((a, b) => (a.tick > b.tick ? a : b));
}

export function instrumentExtra(orders: number, unseen: number): string {
  const bits: string[] = [];
  if (orders > 0) bits.push(`${orders} ${orders === 1 ? "order" : "orders"}`);
  if (unseen > 0) bits.push(`${unseen} ${unseen === 1 ? "fill" : "fills"}`);
  return bits.join(" · ");
}

export function tapeIsOwn(txHash: string | undefined, hashes: Set<string> | undefined): boolean {
  return !!txHash && !!hashes?.has(txHash);
}
