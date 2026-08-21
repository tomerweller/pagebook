import * as StellarSdk from "@stellar/stellar-sdk";
import type { BookEvent, BookSnapshot, MarketInfo, Rpc } from "../book";
import { formatAtoms, formatInt } from "../decode";
import { addrToHex } from "../engine/clientKeys";
import { keysForReplace, keysForSettle, MAX_REPLACE_BATCH, type WindowSpec } from "../engine/pad";
import { simulate } from "../engine/quote";
import { submitReplace, submitReplaceBatch, submitSettle, type ClassicToken, type EngineResult } from "../engine/submit";
import { estimatePaddedFee } from "../engine/txdata";
import { orderKey } from "../keys";
import { countLabel, esc, priceOf, tokenDecimals, tokenLabel, txLink, type UrlOverrides } from "../view/format";
import { parseAssetFromSacName, type AccountState } from "./account";
import { NETWORK_PASSPHRASE } from "./network";
import { plainError, typedErrorHtml } from "./ticket";

const STORAGE_KEY = "pagebook.orders.v1";
const MAX_ROWS = 20;
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
  restedLedger?: number;
};

export type TokenDelta = { base: bigint; quote: bigint };

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

export function sumDeltas(parts: TokenDelta[]): TokenDelta {
  return parts.reduce((a, p) => ({ base: a.base + p.base, quote: a.quote + p.quote }), { base: 0n, quote: 0n });
}

export function batchRequoteTicks(orders: OpenOrder[], mid: number, offset: number): { order: OpenOrder; newTick: number }[] {
  return orders.map((o) => ({
    order: o,
    newTick: Math.max(1, o.isBid ? mid - offset : mid + offset),
  }));
}

export async function readOrderView(
  rpc: Rpc,
  contract: string,
  source: string,
  sequence: string,
  market: number,
  owner: string,
  nonce: bigint,
): Promise<OpenOrder | null> {
  const live = await rpc.getLedgerEntries(orderKey(contract, market, owner, nonce));
  const entry = live.entries?.[0];
  if (!entry) return null;
  const archived = isArchivedEntry(entry.liveUntilLedgerSeq, live.latestLedger ?? 0);
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
    if (sim.error || !sim.results?.[0]?.xdr) return archived ? placeholderArchived(nonce) : null;
    const native = StellarSdk.scValToNative(StellarSdk.xdr.ScVal.fromXDR(sim.results[0].xdr, "base64")) as Record<string, unknown>;
    return {
      nonce,
      isBid: !!native.is_bid,
      tick: Number(native.tick),
      qtyLots: BigInt(String(native.qty_lots ?? 0)),
      filledLots: BigInt(String(native.filled_lots ?? 0)),
      refundLots: BigInt(String(native.refund_lots ?? 0)),
      generation: Number(native.generation ?? 0),
      seq: Number(native.seq ?? 0),
      archived,
    };
  } catch {
    return archived ? placeholderArchived(nonce) : null;
  }
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
): Promise<OpenOrder[]> {
  const set = new Set<string>([...loadNonces(owner, contract, market), ...extraNonces].map((n) => n.toString()));
  const rows: OpenOrder[] = [];
  for (const n of [...set].map((s) => BigInt(s))) {
    if (rows.length >= MAX_ROWS) break;
    const info = await readOrderView(rpc, contract, source, sequence, market, owner, n);
    if (info) {
      info.restedLedger = restedLedgerOf(events, owner, n);
      rows.push(info);
    } else dropNonce(owner, contract, market, n);
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

const EMPTY_WINDOW: WindowSpec = { consume: [], append: { first: 0, last: 1 } };

export type OrdersHandle = {
  draw(root: HTMLElement): void;
  setLive(book: BookSnapshot | null, account: AccountState | null, rows: OpenOrder[], overrides: UrlOverrides): void;
};

export function createOrders(opts: {
  rpc: Rpc;
  contract: string;
  getSecret: () => string | null;
  getPublic: () => string | null;
  getMarket: () => number;
  onRefresh: () => void;
  onLog: (text: string, hash?: string) => void;
}): OrdersHandle {
  let book: BookSnapshot | null = null;
  let account: AccountState | null = null;
  let rows: OpenOrder[] = [];
  let overrides: UrlOverrides = { baseSym: null, quoteSym: null, baseDec: null, quoteDec: null };
  let selected = new Set<string>();
  let confirmSettle: bigint | null = null;
  let replaceOf: bigint | null = null;
  let replaceTick = 1;
  let replaceLots = 1n;
  let replaceBid = true;
  let replacePostOnly = true;
  let batchOffset = 15;
  let phase = "";
  let lastHash = "";
  let rootEl: HTMLElement | null = null;

  function market(): MarketInfo | null {
    return book?.market ?? null;
  }

  function find(n: bigint): OpenOrder | undefined {
    return rows.find((r) => r.nonce === n);
  }

  function deltaText(d: TokenDelta): string {
    const m = market();
    const base = tokenLabel(book?.tokens.base, overrides.baseSym, book?.base ?? null);
    const quote = tokenLabel(book?.tokens.quote, overrides.quoteSym, book?.quote ?? null);
    const bd = tokenDecimals(book?.tokens.base, overrides.baseDec);
    const qd = tokenDecimals(book?.tokens.quote, overrides.quoteDec);
    const fmt = (n: bigint, dec: number, sym: string) => {
      const sign = n < 0n ? "−" : "+";
      return `${sign}${formatAtoms(n < 0n ? -n : n, dec)} ${sym}`;
    };
    void m;
    return `${fmt(d.base, bd, base)} · ${fmt(d.quote, qd, quote)}`;
  }

  function settlePreview(o: OpenOrder): TokenDelta {
    const m = market();
    if (!m) return { base: 0n, quote: 0n };
    return settleAtoms(o, m.lot_size, m.tick_size);
  }

  function paint(): void {
    if (!rootEl) return;
    rootEl.innerHTML = html();
    bind(rootEl);
  }

  function html(): string {
    if (!rows.length) return `<section class="orders"><h3>open orders</h3><p class="wallet-muted">— no open orders</p></section>`;
    const m = market();
    const latest = book?.latestLedger ?? 0;
    const body = rows
      .map((r) => {
        const side = r.isBid ? "bid" : "ask";
        const human = book && m ? priceOf(r.tick, book, overrides) : "";
        const stale = isStaleGeneration(r.generation, levelGeneration(book, r.isBid, r.tick));
        const age = r.restedLedger != null && latest ? latest - r.restedLedger : null;
        const checked = selected.has(r.nonce.toString()) ? "checked" : "";
        const expand = replaceOf === r.nonce ? replaceForm(r) : "";
        const settleBox = confirmSettle === r.nonce ? settleForm(r) : "";
        return `<li class="order-row" data-nonce="${r.nonce.toString()}">
          <label class="order-check"><input type="checkbox" data-act="sel" data-nonce="${r.nonce.toString()}" ${checked} /></label>
          <div class="order-main">
            <div>${esc(side)} ${r.tick}${human ? ` · ${esc(human)}` : ""} · ${esc(countLabel(r.qtyLots, "lot"))}</div>
            <div class="wallet-muted">filled ${esc(formatInt(r.filledLots))} · refund ${esc(formatInt(r.refundLots))}${age != null ? ` · ${esc(countLabel(age, "ledger"))}` : ""}${r.archived ? " · archived" : ""}</div>
            ${stale ? `<p class="wallet-muted">queue swept since this order rested — settle will return filled + refund</p>` : ""}
            <div class="wallet-actions">
              <button type="button" data-act="settle-ask" data-nonce="${r.nonce.toString()}">settle</button>
              <button type="button" data-act="replace-ask" data-nonce="${r.nonce.toString()}">replace</button>
            </div>
            ${settleBox}${expand}
          </div>
        </li>`;
      })
      .join("");
    const nsel = selected.size;
    const batch =
      nsel >= 2
        ? `<div class="order-batch">
            <label>offset <input class="wallet-input" data-field="offset" inputmode="numeric" value="${batchOffset}" /></label>
            <p class="wallet-muted">${batchPreview()}</p>
            <button type="button" data-act="batch" ${nsel > MAX_REPLACE_BATCH ? "disabled" : ""}>replace selected</button>
          </div>`
        : nsel === 1
          ? `<p class="wallet-muted">select 2 or more to batch</p>`
          : "";
    const strip = phase ? `<p class="ticket-strip">${esc(phase)}${lastHash ? ` ${txLink(lastHash)}` : ""}</p>` : "";
    return `<section class="orders">
      <h3>open orders</h3>
      <ul class="orders-list">${body}</ul>
      ${batch}
      ${strip}
    </section>`;
  }

  function settleForm(o: OpenOrder): string {
    const d = settlePreview(o);
    const rent = o.archived ? `restore rent ~ ${formatAtoms(ARCHIVE_RENT_STROOPS, 7)} XLM` : "";
    return `<div class="wallet-confirm">
      <p>claim ${esc(deltaText(d))}${rent ? ` · ${esc(rent)} (1,100,000 stroops)` : ""}</p>
      <div class="wallet-actions">
        <button type="button" data-act="settle-go" data-nonce="${o.nonce.toString()}">settle</button>
        <button type="button" data-act="settle-cancel">cancel</button>
      </div>
    </div>`;
  }

  function replaceForm(o: OpenOrder): string {
    const m = market();
    const net = m ? replaceNet(o, replaceBid, replaceTick, replaceLots, m.lot_size, m.tick_size) : { base: 0n, quote: 0n };
    const crossed = replacePostOnly && wouldCross(book, replaceBid, replaceTick);
    const keys = book?.base && book.quote
      ? keysForReplace(opts.getMarket(), "00".repeat(32), o.nonce, o.isBid, o.tick, o.seq, replaceBid, replaceTick, 0, "00".repeat(32), "00".repeat(32)).keys.length
      : 8;
    const fee = estimatePaddedFee(keys);
    const rent = o.archived ? `restore rent ~ ${formatAtoms(ARCHIVE_RENT_STROOPS, 7)} XLM` : "";
    return `<div class="wallet-confirm">
      <label>tick <input class="wallet-input" data-field="rtick" value="${replaceTick}" /></label>
      <label>lots <input class="wallet-input" data-field="rlots" value="${replaceLots.toString()}" /></label>
      <label class="ticket-flag"><input type="checkbox" data-field="rbid" ${replaceBid ? "checked" : ""} /> bid</label>
      <label class="ticket-flag"><input type="checkbox" data-field="rpo" ${replacePostOnly ? "checked" : ""} /> post-only</label>
      <p class="wallet-muted">net ${esc(deltaText(net))} · padded fee ~ ${esc(formatInt(fee))} stroops (${esc(formatAtoms(fee, 7))} XLM)${rent ? ` · ${esc(rent)} (1,100,000 stroops)` : ""}</p>
      ${crossed ? `<p class="wallet-status">${typedErrorHtml("Crossed")}</p>` : ""}
      <div class="wallet-actions">
        <button type="button" data-act="replace-go" data-nonce="${o.nonce.toString()}" ${crossed ? "disabled" : ""}>replace</button>
        <button type="button" data-act="replace-cancel">cancel</button>
      </div>
    </div>`;
  }

  function batchPreview(): string {
    const m = market();
    if (!m) return "";
    const chosen = rows.filter((r) => selected.has(r.nonce.toString()));
    const mid = midTick(book);
    const planned = batchRequoteTicks(chosen, mid, batchOffset);
    const net = sumDeltas(planned.map((p) => replaceNet(p.order, p.order.isBid, p.newTick, p.order.qtyLots, m.lot_size, m.tick_size)));
    return `requote ±${batchOffset} around ${mid}: net ${deltaText(net)}`;
  }

  function bind(root: HTMLElement): void {
    root.querySelectorAll("[data-act=sel]").forEach((el) => {
      el.addEventListener("change", () => {
        const n = (el as HTMLInputElement).dataset.nonce ?? "";
        if ((el as HTMLInputElement).checked) {
          if (selected.size >= MAX_REPLACE_BATCH) return;
          selected.add(n);
        } else selected.delete(n);
        paint();
      });
    });
    root.querySelectorAll("[data-act=settle-ask]").forEach((el) => {
      el.addEventListener("click", () => {
        confirmSettle = BigInt((el as HTMLElement).dataset.nonce ?? "0");
        replaceOf = null;
        paint();
      });
    });
    root.querySelector("[data-act=settle-cancel]")?.addEventListener("click", () => {
      confirmSettle = null;
      paint();
    });
    root.querySelector("[data-act=settle-go]")?.addEventListener("click", () => {
      const n = confirmSettle;
      if (n != null) void runSettle(n);
    });
    root.querySelectorAll("[data-act=replace-ask]").forEach((el) => {
      el.addEventListener("click", () => {
        const n = BigInt((el as HTMLElement).dataset.nonce ?? "0");
        const o = find(n);
        if (!o) return;
        replaceOf = n;
        confirmSettle = null;
        replaceTick = o.tick;
        replaceLots = o.qtyLots;
        replaceBid = o.isBid;
        paint();
      });
    });
    root.querySelector("[data-act=replace-cancel]")?.addEventListener("click", () => {
      replaceOf = null;
      paint();
    });
    root.querySelector("[data-field=rtick]")?.addEventListener("input", (e) => {
      replaceTick = Number((e.target as HTMLInputElement).value) || 0;
      paint();
    });
    root.querySelector("[data-field=rlots]")?.addEventListener("input", (e) => {
      try {
        replaceLots = BigInt((e.target as HTMLInputElement).value || "0");
      } catch {
        replaceLots = 0n;
      }
      paint();
    });
    root.querySelector("[data-field=rbid]")?.addEventListener("change", (e) => {
      replaceBid = (e.target as HTMLInputElement).checked;
      paint();
    });
    root.querySelector("[data-field=rpo]")?.addEventListener("change", (e) => {
      replacePostOnly = (e.target as HTMLInputElement).checked;
      paint();
    });
    root.querySelector("[data-act=replace-go]")?.addEventListener("click", () => {
      if (replaceOf != null) void runReplace(replaceOf);
    });
    root.querySelector("[data-field=offset]")?.addEventListener("input", (e) => {
      batchOffset = Math.max(0, Number((e.target as HTMLInputElement).value) || 0);
      paint();
    });
    root.querySelector("[data-act=batch]")?.addEventListener("click", () => {
      void runBatch();
    });
  }

  async function runSettle(nonce: bigint): Promise<void> {
    const secret = opts.getSecret();
    const pub = opts.getPublic();
    const o = find(nonce);
    if (!secret || !pub || !o || !book?.base || !book.quote || !account?.exists) return;
    phase = "settling";
    lastHash = "";
    paint();
    const keys = keysForSettle(
      opts.getMarket(),
      addrToHex(pub),
      nonce,
      o.isBid,
      o.tick,
      o.seq,
      addrToHex(book.base),
      addrToHex(book.quote),
    );
    const res = await submitSettle(opts.rpc, {
      contract: opts.contract,
      secret,
      owner: pub,
      market: opts.getMarket(),
      nonce,
      padKeys: keys,
      tokens: padTokens(book),
    });
    finish("settle", res, nonce);
  }

  async function runReplace(nonce: bigint): Promise<void> {
    const secret = opts.getSecret();
    const pub = opts.getPublic();
    const o = find(nonce);
    if (!secret || !pub || !o || !book?.base || !book.quote) return;
    if (replacePostOnly && wouldCross(book, replaceBid, replaceTick)) {
      phase = plainError("Crossed");
      paint();
      return;
    }
    phase = "replacing";
    lastHash = "";
    paint();
    const { keys } = keysForReplace(
      opts.getMarket(),
      addrToHex(pub),
      nonce,
      o.isBid,
      o.tick,
      o.seq,
      replaceBid,
      replaceTick,
      0,
      addrToHex(book.base),
      addrToHex(book.quote),
    );
    const res = await submitReplace(opts.rpc, {
      contract: opts.contract,
      secret,
      owner: pub,
      market: opts.getMarket(),
      nonce,
      isBid: replaceBid,
      tick: replaceTick,
      qtyLots: replaceLots,
      window: EMPTY_WINDOW,
      padKeys: keys,
      tokens: padTokens(book),
    });
    finish("replace", res);
  }

  async function runBatch(): Promise<void> {
    const secret = opts.getSecret();
    const pub = opts.getPublic();
    const m = market();
    if (!secret || !pub || !m || !book?.base || !book.quote) return;
    const chosen = rows.filter((r) => selected.has(r.nonce.toString())).slice(0, MAX_REPLACE_BATCH);
    if (chosen.length < 2) return;
    const mid = midTick(book);
    const planned = batchRequoteTicks(chosen, mid, batchOffset);
    phase = "batch replace";
    lastHash = "";
    paint();
    const items = planned.map((p) => ({
      nonce: p.order.nonce,
      isBid: p.order.isBid,
      tick: p.newTick,
      qtyLots: p.order.qtyLots,
      window: EMPTY_WINDOW,
    }));
    const padKeys = planned.flatMap((p) =>
      keysForReplace(
        opts.getMarket(),
        addrToHex(pub),
        p.order.nonce,
        p.order.isBid,
        p.order.tick,
        p.order.seq,
        p.order.isBid,
        p.newTick,
        0,
        addrToHex(book!.base!),
        addrToHex(book!.quote!),
      ).keys,
    );
    const res = await submitReplaceBatch(opts.rpc, {
      contract: opts.contract,
      secret,
      owner: pub,
      market: opts.getMarket(),
      items,
      padKeys,
      tokens: padTokens(book),
    });
    finish("replace_batch", res);
  }

  function finish(action: string, res: EngineResult, settled?: bigint): void {
    if (res.kind === "ok") {
      phase = "confirmed";
      lastHash = res.hash;
      opts.onLog(action, res.hash);
      confirmSettle = null;
      replaceOf = null;
      if (settled != null) {
        const pub = opts.getPublic();
        if (pub) dropNonce(pub, opts.contract, opts.getMarket(), settled);
      }
      opts.onRefresh();
    } else if (res.kind === "typed") {
      phase = plainError(res.errorName);
      lastHash = res.hash ?? "";
      opts.onLog(`${action} ${res.errorName}`, res.hash);
    } else {
      phase = res.kind === "footprint" ? "footprint" : res.message;
      lastHash = res.hash ?? "";
      opts.onLog(`${action} failed`, res.hash);
    }
    paint();
  }

  return {
    draw(root) {
      rootEl = root;
      paint();
    },
    setLive(nextBook, nextAccount, nextRows, nextOverrides) {
      book = nextBook;
      account = nextAccount;
      rows = nextRows;
      overrides = nextOverrides;
      if (rootEl) paint();
    },
  };
}
