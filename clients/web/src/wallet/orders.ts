import * as StellarSdk from "@stellar/stellar-sdk";
import type { BookEvent, BookSnapshot } from "../book";
import { indexByKey } from "../client/entries";
import type { MarketInfo } from "../client/protocol";
import type { Rpc, RpcLedgerEntry } from "../client/rpc";
import { formatAtoms, formatInt } from "../decode";
import { accessOf, addrToHex } from "../engine/clientKeys";
import { keysForReplace, MAX_REPLACE_BATCH } from "../engine/pad";
import { simulate } from "../engine/quote";
import { type ClassicToken, type EngineResult } from "../engine/op";
import { submitReplace, submitReplaceBatch, submitSettle } from "../engine/submit";
import { estimatePaddedFee } from "../engine/txdata";
import { orderKey } from "../keys";
import { countLabel, esc, priceOf, tokenDecimals, tokenLabel, txLink, type UrlOverrides } from "../view/format";
import { parseAssetFromSacName } from "../client/account";
import { NETWORK_PASSPHRASE } from "../client/network";
import {
  plainError,
  typedErrorHtml,
  XLM_FEE_HEADROOM,
  type TicketBalances,
  type TicketCheck,
} from "./ticket";
import { walletBalances } from "./balances";
import { MarkupCache } from "../view/stable";
import type { Store } from "../store";
import type { AppState } from "../view/market";
import {
  lotsToQty,
  oneLotQtyStep,
  oneTickPriceStep,
  parseDecimal,
  priceToTick,
  qtyToLots,
  stepLots,
  stepTick,
  tickToPrice,
  type Quant,
} from "./units";

const STORAGE_KEY = "pagebook.orders.v1";
const ORDER_ENTRY_BATCH = 200;
const ORDER_VIEW_CONCURRENCY = 4;
export const ARCHIVE_RENT_STROOPS = 1_100_000n;

export type OpenOrder = {
  nonce: bigint;
  isBid: boolean;
  tick: number;
  qtyLots: bigint;
  filledLots: bigint;
  refundLots: bigint;
  generation: number;
  seq: number;
  archived: boolean;
  unavailable?: boolean;
  restedLedger?: number;
};

export type OrderRead =
  | { kind: "found"; order: OpenOrder }
  | { kind: "archived"; order: OpenOrder }
  | { kind: "absent" }
  | { kind: "unavailable"; reason: string };

export type EntryStatus = "absent" | "live" | "archived";

export type EntryLookup = { kind: "ok"; status: EntryStatus } | { kind: "unavailable"; reason: string };

export type TokenDelta = { base: bigint; quote: bigint };

export type OrdersDomain = {
  selected: string[];
  confirmSettle: string | null;
  replaceOf: string | null;
  replaceTick: number;
  replaceLots: bigint;
  replacePriceStr: string;
  replaceQtyStr: string;
  replaceBid: boolean;
  replacePostOnly: boolean;
  batchOffset: number;
  phase: string;
  lastHash: string;
};

export function ordersBusy(phase: string): boolean {
  return phase === "settling" || phase === "replacing" || phase === "batch replace";
}

function clearDoneOrdersPhase(s: { orders: OrdersDomain }): void {
  if (!s.orders.phase || ordersBusy(s.orders.phase)) return;
  s.orders.phase = "";
  s.orders.lastHash = "";
}

export function emptyOrdersDomain(): OrdersDomain {
  return {
    selected: [],
    confirmSettle: null,
    replaceOf: null,
    replaceTick: 1,
    replaceLots: 1n,
    replacePriceStr: "",
    replaceQtyStr: "",
    replaceBid: true,
    replacePostOnly: true,
    batchOffset: 15,
    phase: "",
    lastHash: "",
  };
}

type Stored = Record<string, string[]>;

function slotKey(pub: string, contract: string, market: number): string {
  return `${pub}:${contract}:${market}`;
}

function readStore(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Stored;
  } catch {
    return {};
  }
}

function writeStore(s: Stored): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export function rememberNonce(pub: string, contract: string, market: number, nonce: bigint): void {
  const s = readStore();
  const k = slotKey(pub, contract, market);
  const cur = new Set(s[k] ?? []);
  cur.add(nonce.toString());
  s[k] = [...cur];
  writeStore(s);
}

export function loadNonces(pub: string, contract: string, market: number): bigint[] {
  return (readStore()[slotKey(pub, contract, market)] ?? []).map((n) => BigInt(n));
}

export function dropNonce(pub: string, contract: string, market: number, nonce: bigint): void {
  const s = readStore();
  const k = slotKey(pub, contract, market);
  s[k] = (s[k] ?? []).filter((n) => n !== nonce.toString());
  writeStore(s);
}

export function sessionRestedNonces(events: BookEvent[], owner: string): bigint[] {
  const out: bigint[] = [];
  for (const e of events) {
    if (e.name !== "rested" || !("owner" in e)) continue;
    if (e.owner !== owner) continue;
    out.push(e.nonce);
  }
  return out;
}

export function restedLedgerOf(events: BookEvent[], owner: string, nonce: bigint): number | undefined {
  for (const e of events) {
    if (e.name !== "rested" || !("owner" in e)) continue;
    if (e.owner === owner && e.nonce === nonce && e.ledger != null) return e.ledger;
  }
  return undefined;
}

export function isArchivedEntry(liveUntil: number | undefined, latestLedger: number): boolean {
  return liveUntil != null && liveUntil > 0 && liveUntil < latestLedger;
}

export function classifyOrderEntry(entry: RpcLedgerEntry | undefined, latestLedger: number): EntryStatus {
  if (!entry) return "absent";
  return isArchivedEntry(entry.liveUntilLedgerSeq, latestLedger) ? "archived" : "live";
}

function failReason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function mapBounded<T, U>(items: T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]);
    }
  }
  const n = Math.min(limit, items.length);
  const running: Promise<void>[] = [];
  for (let w = 0; w < n; w++) running.push(worker());
  await Promise.all(running);
  return out;
}

export async function readOrderEntries(
  rpc: Rpc,
  contract: string,
  market: number,
  owner: string,
  nonces: bigint[],
): Promise<Map<string, EntryLookup>> {
  const out = new Map<string, EntryLookup>();
  for (let i = 0; i < nonces.length; i += ORDER_ENTRY_BATCH) {
    const chunk = nonces.slice(i, i + ORDER_ENTRY_BATCH);
    const keys = chunk.map((n) => orderKey(contract, market, owner, n));
    try {
      const res = await rpc.getLedgerEntries(...keys);
      const byKey = indexByKey(res.entries ?? []);
      const latest = res.latestLedger ?? 0;
      for (let j = 0; j < chunk.length; j++) {
        out.set(chunk[j].toString(), { kind: "ok", status: classifyOrderEntry(byKey.get(keys[j].base64), latest) });
      }
    } catch (e) {
      const reason = failReason(e);
      for (const n of chunk) out.set(n.toString(), { kind: "unavailable", reason });
    }
  }
  return out;
}

export function isStaleGeneration(orderGeneration: number, levelGeneration: number | undefined): boolean {
  return levelGeneration != null && levelGeneration > orderGeneration;
}

export function settleAtoms(order: OpenOrder, lotSize: bigint, tickSize: bigint): TokenDelta {
  if (order.isBid) {
    return {
      base: order.filledLots * lotSize,
      quote: order.refundLots * BigInt(order.tick) * tickSize,
    };
  }
  return {
    base: order.refundLots * lotSize,
    quote: order.filledLots * BigInt(order.tick) * tickSize,
  };
}

export function replaceNet(
  order: OpenOrder,
  newIsBid: boolean,
  newTick: number,
  newLots: bigint,
  lotSize: bigint,
  tickSize: bigint,
): TokenDelta {
  const s = settleAtoms(order, lotSize, tickSize);
  const escrowBase = newIsBid ? 0n : newLots * lotSize;
  const escrowQuote = newIsBid ? newLots * BigInt(newTick) * tickSize : 0n;
  return { base: s.base - escrowBase, quote: s.quote - escrowQuote };
}

/// A replace refunds the old order and escrows the new one in the same call,
/// so what the wallet has to cover is the net outflow. The place ticket has
/// always checked this; the replace form did not, and an unaffordable requote
/// reached the chain and came back as a bare SAC "BalanceError".
export function validateReplace(net: TokenDelta, bal: TicketBalances): TicketCheck {
  if (!bal.funded) return { ok: false, reason: "account not funded" };
  if (bal.xlmSpendable < XLM_FEE_HEADROOM) return { ok: false, reason: "need at least 0.2 XLM for the padded fee" };
  const needQuote = net.quote < 0n ? -net.quote : 0n;
  if (needQuote > 0n) {
    if (bal.quoteAtoms == null) return { ok: false, reason: `no ${bal.quoteSymbol} trustline` };
    if (bal.quoteAtoms < needQuote) {
      return {
        ok: false,
        reason: `need ${formatAtoms(needQuote, bal.quoteDec)} ${bal.quoteSymbol} for this replace`,
        title: `${needQuote.toString()} atoms`,
      };
    }
  }
  const needBase = net.base < 0n ? -net.base : 0n;
  if (needBase > 0n) {
    const avail = bal.baseIsNative ? bal.xlmSpendable - XLM_FEE_HEADROOM : bal.baseAtoms;
    if (avail < needBase) {
      return {
        ok: false,
        reason: `need ${formatAtoms(needBase, bal.baseDec)} ${bal.baseSymbol} for this replace`,
        title: `${needBase.toString()} atoms`,
      };
    }
  }
  return { ok: true };
}

export function sumDeltas(parts: TokenDelta[]): TokenDelta {
  return parts.reduce((a, p) => ({ base: a.base + p.base, quote: a.quote + p.quote }), { base: 0n, quote: 0n });
}

export function batchRequoteTicks(orders: OpenOrder[], mid: number, offset: number): { order: OpenOrder; newTick: number }[] {
  return orders.map((o) => ({
    order: o,
    newTick: Math.max(1, o.isBid ? mid - offset : mid + offset),
  }));
}

export async function simulateOrderView(
  rpc: Rpc,
  contract: string,
  source: string,
  sequence: string,
  market: number,
  owner: string,
  nonce: bigint,
  archived: boolean,
): Promise<OrderRead> {
  const fail = (reason: string): OrderRead =>
    archived ? { kind: "archived", order: placeholderArchived(nonce) } : { kind: "unavailable", reason };
  try {
    const c = new StellarSdk.Contract(contract);
    const account = new StellarSdk.Account(source, sequence);
    const op = c.call(
      "order",
      StellarSdk.nativeToScVal(market, { type: "u32" }),
      new StellarSdk.Address(owner).toScVal(),
      StellarSdk.nativeToScVal(nonce, { type: "u64" }),
    );
    const tx = new StellarSdk.TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const sim = await simulate(rpc, tx.toXDR());
    if (sim.error || !sim.results?.[0]?.xdr) return fail(sim.error || "simulation returned no result");
    const native: unknown = StellarSdk.scValToNative(StellarSdk.xdr.ScVal.fromXDR(sim.results[0].xdr, "base64"));
    if (!native || typeof native !== "object") return fail("decoded value is not an object");
    const rec = native as Record<string, unknown>;
    const order: OpenOrder = {
      nonce,
      isBid: !!rec.is_bid,
      tick: Number(rec.tick),
      qtyLots: BigInt(String(rec.qty_lots ?? 0)),
      filledLots: BigInt(String(rec.filled_lots ?? 0)),
      refundLots: BigInt(String(rec.refund_lots ?? 0)),
      generation: Number(rec.generation ?? 0),
      seq: Number(rec.seq ?? 0),
      archived,
    };
    return { kind: archived ? "archived" : "found", order };
  } catch (e) {
    return fail(failReason(e));
  }
}

export async function readOrderView(
  rpc: Rpc,
  contract: string,
  source: string,
  sequence: string,
  market: number,
  owner: string,
  nonce: bigint,
): Promise<OrderRead> {
  const lookups = await readOrderEntries(rpc, contract, market, owner, [nonce]);
  const lookup = lookups.get(nonce.toString()) ?? { kind: "unavailable" as const, reason: "missing lookup" };
  if (lookup.kind === "unavailable") return lookup;
  if (lookup.status === "absent") return { kind: "absent" };
  return simulateOrderView(rpc, contract, source, sequence, market, owner, nonce, lookup.status === "archived");
}

function placeholderArchived(nonce: bigint): OpenOrder {
  return {
    nonce,
    isBid: true,
    tick: 0,
    qtyLots: 0n,
    filledLots: 0n,
    refundLots: 0n,
    generation: 0,
    seq: 0,
    archived: true,
  };
}

export async function loadOpenOrders(
  rpc: Rpc,
  contract: string,
  source: string,
  sequence: string,
  market: number,
  owner: string,
  extraNonces: bigint[],
  events: BookEvent[] = [],
  previous: OpenOrder[] = [],
): Promise<OpenOrder[]> {
  const seen = new Set<string>();
  const nonces: bigint[] = [];
  for (const n of [...loadNonces(owner, contract, market), ...extraNonces]) {
    const k = n.toString();
    if (seen.has(k)) continue;
    seen.add(k);
    nonces.push(n);
  }
  const lookups = await readOrderEntries(rpc, contract, market, owner, nonces);
  const queued: { nonce: bigint; archived: boolean }[] = [];
  for (const n of nonces) {
    const lookup = lookups.get(n.toString());
    if (!lookup || lookup.kind === "unavailable") continue;
    if (lookup.status === "absent") {
      dropNonce(owner, contract, market, n);
      continue;
    }
    queued.push({ nonce: n, archived: lookup.status === "archived" });
  }
  const views = await mapBounded(queued, ORDER_VIEW_CONCURRENCY, (item) =>
    simulateOrderView(rpc, contract, source, sequence, market, owner, item.nonce, item.archived),
  );
  const viewOf = new Map<string, OrderRead>();
  for (let i = 0; i < queued.length; i++) viewOf.set(queued[i].nonce.toString(), views[i]);
  const prevOf = new Map(previous.map((r) => [r.nonce.toString(), r]));
  const rows: OpenOrder[] = [];
  for (const n of nonces) {
    const key = n.toString();
    const lookup = lookups.get(key);
    if (!lookup || lookup.kind === "unavailable" || lookup.status === "absent") {
      if (lookup?.kind === "unavailable" || !lookup) {
        const prev = prevOf.get(key);
        if (prev) rows.push({ ...prev, unavailable: true });
      }
      continue;
    }
    const view = viewOf.get(key);
    if (!view || view.kind === "unavailable") {
      const prev = prevOf.get(key);
      if (prev) rows.push({ ...prev, unavailable: true });
      continue;
    }
    if (view.kind === "found" || view.kind === "archived") {
      view.order.restedLedger = restedLedgerOf(events, owner, n);
      rows.push(view.order);
    }
  }
  return rows;
}

export function ownTicksOf(rows: OpenOrder[]): { bid: Set<number>; ask: Set<number> } {
  const bid = new Set<number>();
  const ask = new Set<number>();
  for (const r of rows) {
    if (r.isBid) bid.add(r.tick);
    else ask.add(r.tick);
  }
  return { bid, ask };
}

export function ordersHtml(rows: OpenOrder[]): string {
  if (!rows.length) return `<section class="orders"><h3>open orders</h3><p class="wallet-muted">— no open orders</p></section>`;
  const body = rows
    .map((r) => {
      const side = r.isBid ? "bid" : "ask";
      return `<li>${esc(side)} ${r.tick} · ${esc(formatInt(r.qtyLots))} lots · filled ${esc(formatInt(r.filledLots))} · #${r.nonce.toString()}</li>`;
    })
    .join("");
  return `<section class="orders"><h3>open orders</h3><ul class="orders-list">${body}</ul></section>`;
}

function levelGeneration(book: BookSnapshot | null, isBid: boolean, tick: number): number | undefined {
  const rows = isBid ? book?.bids : book?.asks;
  return rows?.find((r) => r.tick === tick)?.generation;
}

function midTick(book: BookSnapshot | null): number {
  if (!book) return 100;
  if (!book.bestBid.empty && !book.bestAsk.empty) return Math.floor((book.bestBid.tick + book.bestAsk.tick) / 2);
  if (!book.bestBid.empty) return book.bestBid.tick;
  if (!book.bestAsk.empty) return book.bestAsk.tick;
  return 100;
}

function padTokens(book: BookSnapshot | null): ClassicToken[] {
  const out: ClassicToken[] = [];
  if (book?.base) {
    const a = book.tokens.base?.name ? tryAsset(book.tokens.base.name) : null;
    if (a && a.type === "credit") out.push({ sac: book.base, code: a.code, issuer: a.issuer });
    else out.push({ sac: book.base });
  }
  if (book?.quote) {
    const a = book.tokens.quote?.name ? tryAsset(book.tokens.quote.name) : null;
    if (a && a.type === "credit") out.push({ sac: book.quote, code: a.code, issuer: a.issuer });
    else out.push({ sac: book.quote });
  }
  return out;
}

function tryAsset(name: string) {
  try {
    return parseAssetFromSacName(name);
  } catch {
    return null;
  }
}

function wouldCross(book: BookSnapshot | null, isBid: boolean, tick: number): boolean {
  if (!book) return false;
  if (isBid && !book.bestAsk.empty && tick >= book.bestAsk.tick) return true;
  if (!isBid && !book.bestBid.empty && tick <= book.bestBid.tick) return true;
  return false;
}

export type OrdersHandle = {
  draw(root: HTMLElement): void;
};

export function createOrders(opts: {
  store: Store<AppState>;
  rpc: Rpc;
  contract: string;
  getSecret: () => string | null;
  getPublic: () => string | null;
  getMarket: () => number;
  onRefresh: () => void;
  onLog: (text: string, hash?: string) => void;
}): OrdersHandle {
  const app = opts.store;
  let rootEl: HTMLElement | null = null;
  let bound = false;
  const cache = new MarkupCache();

  function snap(): BookSnapshot | null {
    return app.read().book.snapshot;
  }

  function ov(): UrlOverrides {
    return app.read().book.overrides;
  }

  function rows(): OpenOrder[] {
    return app.read().wallet.openOrders;
  }

  function ui(): OrdersDomain {
    return app.read().orders;
  }

  function market(): MarketInfo | null {
    return snap()?.market ?? null;
  }

  function quant(): Quant | null {
    const m = market();
    const book = snap();
    if (!m) return null;
    return {
      lotSize: m.lot_size,
      tickSize: m.tick_size,
      baseDec: tokenDecimals(book?.tokens.base, ov().baseDec),
      quoteDec: tokenDecimals(book?.tokens.quote, ov().quoteDec),
      tickMin: m.tick_min,
      tickMax: m.tick_max,
      minLots: m.min_order_lots,
    };
  }

  function find(n: bigint): OpenOrder | undefined {
    return rows().find((r) => r.nonce === n);
  }

  function deltaText(d: TokenDelta): string {
    const book = snap();
    const overrides = ov();
    const base = tokenLabel(book?.tokens.base, overrides.baseSym, book?.base ?? null);
    const quote = tokenLabel(book?.tokens.quote, overrides.quoteSym, book?.quote ?? null);
    const bd = tokenDecimals(book?.tokens.base, overrides.baseDec);
    const qd = tokenDecimals(book?.tokens.quote, overrides.quoteDec);
    const fmt = (n: bigint, dec: number, sym: string) => {
      const sign = n < 0n ? "−" : "+";
      return `${sign}${formatAtoms(n < 0n ? -n : n, dec)} ${sym}`;
    };
    return `${fmt(d.base, bd, base)} · ${fmt(d.quote, qd, quote)}`;
  }

  function settlePreview(o: OpenOrder): TokenDelta {
    const m = market();
    if (!m) return { base: 0n, quote: 0n };
    return settleAtoms(o, m.lot_size, m.tick_size);
  }

  function renderOrders(): void {
    if (!rootEl) return;
    cache.write("orders", rootEl, html());
    if (!bound) {
      bind(rootEl);
      bound = true;
    }
  }

  function phaseStrip(o: OrdersDomain): string {
    if (!o.phase) return "";
    return `<p class="ticket-strip ticket-cta" data-role="ostrip">${esc(o.phase)}${o.lastHash ? ` ${txLink(o.lastHash)}` : ""}</p>`;
  }

  function html(): string {
    const list = rows();
    const o = ui();
    const inForm = ordersBusy(o.phase) && !!(o.replaceOf || o.confirmSettle);
    const headStrip = o.phase && !inForm ? phaseStrip(o) : "";
    if (!list.length) {
      return `<section class="orders"><h3>open orders</h3>${headStrip}<p class="wallet-muted">— no open orders</p></section>`;
    }
    const m = market();
    const book = snap();
    const latest = book?.latestLedger ?? 0;
    const body = list
      .map((r) => {
        const side = r.isBid ? "bid" : "ask";
        const human = book && m ? priceOf(r.tick, book, ov()) : "";
        const stale = isStaleGeneration(r.generation, levelGeneration(book, r.isBid, r.tick));
        const age = r.restedLedger != null && latest ? latest - r.restedLedger : null;
        const key = r.nonce.toString();
        const checked = o.selected.includes(key) ? "checked" : "";
        if (o.replaceOf === key) {
          return `<li class="order-row order-form" data-nonce="${key}">${replaceForm(r)}</li>`;
        }
        if (o.confirmSettle === key) {
          return `<li class="order-row order-form" data-nonce="${key}">${settleForm(r)}</li>`;
        }
        return `<li class="order-row" data-nonce="${key}">
          <label class="order-check"><input type="checkbox" data-act="sel" data-nonce="${key}" ${checked} /></label>
          <div class="order-main">
            <div>${esc(side)} ${r.tick}${human ? ` · ${esc(human)}` : ""} · ${esc(countLabel(r.qtyLots, "lot"))}</div>
            <div class="wallet-muted">filled <span data-live="filled">${esc(formatInt(r.filledLots))}</span> · refund <span data-live="refund">${esc(formatInt(r.refundLots))}</span>${age != null ? ` · <span data-live="age">${esc(countLabel(age, "ledger"))}</span>` : ""}${r.archived ? " · archived" : ""}${r.unavailable ? " · read failed, showing last known state" : ""}</div>
            ${stale ? `<p class="wallet-muted">queue swept since this order rested — settle will return filled + refund</p>` : ""}
            <div class="wallet-actions">
              <button type="button" data-act="settle-ask" data-nonce="${key}">settle</button>
              <button type="button" data-act="replace-ask" data-nonce="${key}">replace</button>
            </div>
          </div>
        </li>`;
      })
      .join("");
    const nsel = liveSelected().length;
    const plan = nsel >= 2 ? batchPlan() : null;
    const batchFunds = plan ? validateReplace(plan.net, walletBalances(app.read())) : { ok: true as const };
    const batch =
      plan && nsel >= 2
        ? `<div class="order-batch">
            <label>± ticks <input class="wallet-input" data-field="offset" inputmode="numeric" value="${o.batchOffset}" /></label>
            <p class="wallet-muted">${esc(plan.text)}</p>
            ${!batchFunds.ok ? `<p class="wallet-status">${esc(batchFunds.reason)}</p>` : ""}
            <button type="button" data-act="batch" ${nsel > MAX_REPLACE_BATCH || !batchFunds.ok ? "disabled" : ""}>replace selected</button>
          </div>`
        : nsel === 1
          ? `<p class="wallet-muted">select 2 or more to batch</p>`
          : "";
    return `<section class="orders">
      <h3>open orders</h3>
      ${headStrip}
      <ul class="orders-list">${body}</ul>
      ${batch}
    </section>`;
  }

  function settleForm(o: OpenOrder): string {
    const d = settlePreview(o);
    const st = ui();
    const rent = o.archived ? `restore rent ~ ${formatAtoms(ARCHIVE_RENT_STROOPS, 7)} XLM` : "";
    const actions = ordersBusy(st.phase)
      ? phaseStrip(st)
      : `<div class="wallet-actions">
        <button type="button" data-act="settle-go" data-nonce="${o.nonce.toString()}">confirm settle</button>
        <button type="button" data-act="settle-cancel">cancel</button>
      </div>`;
    return `<div class="wallet-confirm">
      <p>claim ${esc(deltaText(d))}${rent ? ` · ${esc(rent)} (1,100,000 stroops)` : ""}</p>
      ${actions}
    </div>`;
  }

  function replaceForm(order: OpenOrder): string {
    const m = market();
    const book = snap();
    const st = ui();
    const net = m ? replaceNet(order, st.replaceBid, st.replaceTick, st.replaceLots, m.lot_size, m.tick_size) : { base: 0n, quote: 0n };
    const crossed = st.replacePostOnly && wouldCross(book, st.replaceBid, st.replaceTick);
    const funds = validateReplace(net, walletBalances(app.read()));
    const planned =
      book?.base && book.quote
        ? keysForReplace(opts.getMarket(), "00".repeat(32), order.nonce, order.isBid, order.tick, st.replaceBid, st.replaceTick, addrToHex(book.base), addrToHex(book.quote))
        : null;
    // Distinct tokens keep four balance keys. Same split as keysForReplace when base != quote.
    let rw = 11;
    let ro = 2;
    if (planned) {
      rw = 0;
      ro = 0;
      for (const k of planned) {
        if (accessOf(k) === "rw") rw += 1;
        else ro += 1;
      }
    }
    const fee = estimatePaddedFee({ rw, ro }, 0n, m?.level_cap);
    const rent = order.archived ? `restore rent ~ ${formatAtoms(ARCHIVE_RENT_STROOPS, 7)} XLM` : "";
    const qn = quant();
    const overrides = ov();
    const bsym = tokenLabel(book?.tokens.base, overrides.baseSym, book?.base ?? null);
    const qsym = tokenLabel(book?.tokens.quote, overrides.quoteSym, book?.quote ?? null);
    const line = qn
      ? `= tick ${st.replaceTick} · ${countLabel(st.replaceLots, "lot")} (${lotsToQty(st.replaceLots, qn)} ${bsym})`
      : "";
    const actions = ordersBusy(st.phase)
      ? phaseStrip(st)
      : `<div class="wallet-actions">
        <button type="button" data-act="replace-go" data-nonce="${order.nonce.toString()}" ${crossed || !funds.ok ? "disabled" : ""}>replace</button>
        <button type="button" data-act="replace-cancel">cancel</button>
      </div>`;
    return `<div class="wallet-confirm">
      <label>price · ${esc(qsym)} per ${esc(bsym)}
        <div class="ticket-step">
          <button type="button" data-act="rprice-dec" aria-label="one tick down">−</button>
          <input class="wallet-input" data-field="rprice" inputmode="decimal" step="${qn ? esc(oneTickPriceStep(qn)) : "any"}" value="${esc(st.replacePriceStr)}" />
          <button type="button" data-act="rprice-inc" aria-label="one tick up">+</button>
        </div>
      </label>
      <label>quantity · ${esc(bsym)}
        <div class="ticket-step">
          <button type="button" data-act="rqty-dec" aria-label="one lot down">−</button>
          <input class="wallet-input" data-field="rqty" inputmode="decimal" step="${qn ? esc(oneLotQtyStep(qn)) : "any"}" value="${esc(st.replaceQtyStr)}" />
          <button type="button" data-act="rqty-inc" aria-label="one lot up">+</button>
        </div>
      </label>
      <p class="wallet-muted">${esc(line)}</p>
      <label class="ticket-flag"><input type="checkbox" data-field="rbid" ${st.replaceBid ? "checked" : ""} /> bid</label>
      <label class="ticket-flag"><input type="checkbox" data-field="rpo" ${st.replacePostOnly ? "checked" : ""} /> post-only</label>
      <p class="wallet-muted">net ${esc(deltaText(net))} · padded fee ~ ${esc(formatInt(fee))} stroops (${esc(formatAtoms(fee, 7))} XLM)${rent ? ` · ${esc(rent)} (1,100,000 stroops)` : ""}</p>
      ${crossed ? `<p class="wallet-status">${typedErrorHtml("Crossed")}</p>` : ""}
      ${!funds.ok ? `<p class="wallet-status"${funds.title ? ` title="${esc(funds.title)}"` : ""}>${esc(funds.reason)}</p>` : ""}
      ${actions}
    </div>`;
  }

  function batchPlan(): { text: string; net: TokenDelta } {
    const m = market();
    const st = ui();
    if (!m) return { text: "", net: { base: 0n, quote: 0n } };
    const chosen = liveSelected();
    const mid = midTick(snap());
    const planned = batchRequoteTicks(chosen, mid, st.batchOffset);
    const net = sumDeltas(planned.map((p) => replaceNet(p.order, p.order.isBid, p.newTick, p.order.qtyLots, m.lot_size, m.tick_size)));
    return { text: `requote ±${st.batchOffset} around ${mid}: net ${deltaText(net)}`, net };
  }

  // A settled order keeps its nonce in `selected` until the trader unticks it,
  // and the batch panel used to count those: two ticks, one live order, an
  // enabled button that submitted nothing. Only live rows count.
  function liveSelected(): OpenOrder[] {
    const sel = ui().selected;
    return rows().filter((r) => sel.includes(r.nonce.toString()));
  }

  function bind(root: HTMLElement): void {
    root.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
      if (!t || !root.contains(t)) return;
      const act = t.dataset.act;
      if (act === "settle-ask") {
        app.update((s) => {
          clearDoneOrdersPhase(s);
          s.orders.confirmSettle = t.dataset.nonce ?? "0";
          s.orders.replaceOf = null;
        });
      } else if (act === "settle-cancel") {
        app.update((s) => {
          clearDoneOrdersPhase(s);
          s.orders.confirmSettle = null;
        });
      } else if (act === "settle-go") {
        const n = ui().confirmSettle;
        if (n != null) void runSettle(BigInt(n));
      } else if (act === "replace-ask") {
        const n = BigInt(t.dataset.nonce ?? "0");
        const o = find(n);
        if (!o) return;
        const qn = quant();
        app.update((s) => {
          clearDoneOrdersPhase(s);
          s.orders.replaceOf = n.toString();
          s.orders.confirmSettle = null;
          s.orders.replaceTick = o.tick;
          s.orders.replaceLots = o.qtyLots;
          s.orders.replaceBid = o.isBid;
          if (qn) {
            s.orders.replacePriceStr = tickToPrice(o.tick, qn);
            s.orders.replaceQtyStr = lotsToQty(o.qtyLots, qn);
          }
        });
      } else if (act === "replace-cancel") {
        app.update((s) => {
          clearDoneOrdersPhase(s);
          s.orders.replaceOf = null;
        });
      } else if (act === "rprice-dec" || act === "rprice-inc") {
        const qn = quant();
        if (!qn) return;
        const dir = act === "rprice-inc" ? 1 : -1;
        app.update((s) => {
          s.orders.replaceTick = stepTick(s.orders.replaceTick, dir, qn);
          s.orders.replacePriceStr = tickToPrice(s.orders.replaceTick, qn);
        });
      } else if (act === "rqty-dec" || act === "rqty-inc") {
        const qn = quant();
        if (!qn) return;
        const dir = act === "rqty-inc" ? 1 : -1;
        app.update((s) => {
          s.orders.replaceLots = stepLots(s.orders.replaceLots, dir, qn);
          s.orders.replaceQtyStr = lotsToQty(s.orders.replaceLots, qn);
        });
      } else if (act === "replace-go") {
        const n = ui().replaceOf;
        if (n != null) void runReplace(BigInt(n));
      } else if (act === "batch") {
        void runBatch();
      }
    });
    root.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement;
      const act = t.dataset.act;
      const field = t.dataset.field;
      if (act === "sel") {
        const n = t.dataset.nonce ?? "";
        app.update((s) => {
          clearDoneOrdersPhase(s);
          if (t.checked) {
            if (s.orders.selected.length >= MAX_REPLACE_BATCH) {
              // Cap rejection cannot be state-driven: the regenerated html is
              // byte-identical, so the cache skips the write and the box would
              // stay visually checked. Revert the DOM property directly (A5
              // audit MUST-FIX).
              t.checked = false;
              return;
            }
            if (!s.orders.selected.includes(n)) s.orders.selected.push(n);
          } else {
            s.orders.selected = s.orders.selected.filter((x) => x !== n);
          }
        });
      } else if (field === "rbid") {
        const qn = quant();
        const d = parseDecimal(ui().replacePriceStr);
        app.update((s) => {
          s.orders.replaceBid = t.checked;
          if (qn && d) s.orders.replaceTick = priceToTick(d, qn, t.checked).tick;
        });
      } else if (field === "rpo") {
        app.update((s) => {
          s.orders.replacePostOnly = t.checked;
        });
      }
    });
    root.addEventListener("input", (e) => {
      const t = e.target as HTMLInputElement;
      const field = t.dataset.field;
      if (field === "rprice") {
        const qn = quant();
        const d = parseDecimal(t.value);
        app.update((s) => {
          s.orders.replacePriceStr = t.value;
          s.orders.replaceTick = qn && d ? priceToTick(d, qn, s.orders.replaceBid).tick : 0;
        });
      } else if (field === "rqty") {
        const qn = quant();
        const d = parseDecimal(t.value);
        app.update((s) => {
          s.orders.replaceQtyStr = t.value;
          s.orders.replaceLots = qn && d ? qtyToLots(d, qn) : 0n;
        });
      } else if (field === "offset") {
        app.update((s) => {
          s.orders.batchOffset = Math.max(0, Number(t.value) || 0);
        });
      }
    });
  }

  async function runSettle(nonce: bigint): Promise<void> {
    const secret = opts.getSecret();
    const pub = opts.getPublic();
    const o = find(nonce);
    const book = snap();
    if (!secret || !pub || !o || !book?.base || !book.quote || !app.read().wallet.account?.exists) return;
    app.update((s) => {
      s.orders.phase = "settling";
      s.orders.lastHash = "";
    });
    const res = await submitSettle(opts.rpc, {
      contract: opts.contract,
      secret,
      owner: pub,
      market: opts.getMarket(),
      nonce,
      tokens: padTokens(book),
      base: addrToHex(book.base),
      quote: addrToHex(book.quote),
      levelCap: market()?.level_cap,
    });
    finish("settle", res, nonce);
  }

  async function runReplace(nonce: bigint): Promise<void> {
    const secret = opts.getSecret();
    const pub = opts.getPublic();
    const o = find(nonce);
    const book = snap();
    const st = ui();
    if (!secret || !pub || !o || !book?.base || !book.quote) return;
    if (st.replacePostOnly && wouldCross(book, st.replaceBid, st.replaceTick)) {
      app.update((s) => {
        s.orders.phase = plainError("Crossed");
      });
      return;
    }
    app.update((s) => {
      s.orders.phase = "replacing";
      s.orders.lastHash = "";
    });
    const res = await submitReplace(opts.rpc, {
      contract: opts.contract,
      secret,
      owner: pub,
      market: opts.getMarket(),
      nonce,
      isBid: st.replaceBid,
      tick: st.replaceTick,
      qtyLots: st.replaceLots,
      tokens: padTokens(book),
      base: addrToHex(book.base),
      quote: addrToHex(book.quote),
      levelCap: market()?.level_cap,
    });
    finish("replace", res);
  }

  async function runBatch(): Promise<void> {
    const secret = opts.getSecret();
    const pub = opts.getPublic();
    const m = market();
    const book = snap();
    if (!secret || !pub || !m || !book?.base || !book.quote) return;
    const chosen = liveSelected().slice(0, MAX_REPLACE_BATCH);
    if (chosen.length < 2) return;
    const mid = midTick(book);
    const planned = batchRequoteTicks(chosen, mid, ui().batchOffset);
    app.update((s) => {
      s.orders.phase = "batch replace";
      s.orders.lastHash = "";
    });
    const items = planned.map((p) => ({
      nonce: p.order.nonce,
      isBid: p.order.isBid,
      tick: p.newTick,
      qtyLots: p.order.qtyLots,
    }));
    const res = await submitReplaceBatch(opts.rpc, {
      contract: opts.contract,
      secret,
      owner: pub,
      market: opts.getMarket(),
      items,
      tokens: padTokens(book),
      base: addrToHex(book.base),
      quote: addrToHex(book.quote),
      levelCap: market()?.level_cap,
    });
    finish("replace_batch", res);
  }

  function finish(action: string, res: EngineResult, settled?: bigint): void {
    if (res.kind === "ok") {
      app.update((s) => {
        s.orders.phase = "confirmed";
        s.orders.lastHash = res.hash;
        s.orders.confirmSettle = null;
        s.orders.replaceOf = null;
      });
      opts.onLog(action, res.hash);
      if (settled != null) {
        const pub = opts.getPublic();
        if (pub) dropNonce(pub, opts.contract, opts.getMarket(), settled);
      }
      opts.onRefresh();
    } else if (res.kind === "typed") {
      app.update((s) => {
        s.orders.phase = plainError(res.errorName);
        s.orders.lastHash = res.hash ?? "";
      });
      opts.onLog(`${action} ${res.errorName}`, res.hash);
    } else {
      app.update((s) => {
        s.orders.phase = res.kind === "footprint" ? "footprint" : "message" in res && res.message ? res.message : res.kind;
        s.orders.lastHash = res.hash ?? "";
      });
      opts.onLog(`${action} failed`, res.hash);
    }
    queueMicrotask(() => {
      rootEl?.querySelector("[data-role=ostrip]")?.scrollIntoView?.({ block: "nearest" });
    });
  }

  app.register(
    "orders",
    () => renderOrders(),
    () => {
      const v = app.read().versions;
      return `${v.book}|${v.wallet}|${v.orders}`;
    },
  );

  return {
    draw(root) {
      rootEl = root;
      renderOrders();
    },
  };
}
