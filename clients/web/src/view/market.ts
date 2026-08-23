import { formatInt, formatAtoms } from "../decode";
import type { BookEvent, BookSnapshot, FilledEvent, ListedMarket, RestedEvent, SettledEvent, SweptEvent, TopChangedEvent } from "../book";
import {
  contractLink,
  countLabel,
  esc,
  lotsToBase,
  fmtTime,
  midSpread,
  priceOf,
  shortAddr,
  tokenDecimals,
  tokenLabel,
  type UrlOverrides,
} from "./format";
import { MarkupCache } from "./stable";
import type { Store } from "../store";
import type { WalletDomain } from "../wallet/pane";
import type { OrdersDomain } from "../wallet/orders";
import type { TicketDomain } from "../wallet/ticket";

const paneCache = new MarkupCache();

export type EventState = {
  cursor: string | null;
  seen: Set<string>;
  historyFrom: number | null;
  events: BookEvent[];
};

export type OwnTicks = { bid: Set<number>; ask: Set<number> };

export type MarketViewState = {
  contract: string;
  market: number | null;
  marketList: ListedMarket[];
  overrides: UrlOverrides;
  isTestnet: boolean;
  eventState: EventState;
  onSwitchMarket: (id: number) => void;
  ownTicks?: OwnTicks;
};

export type BookDomain = {
  snapshot: BookSnapshot | null;
  eventState: EventState;
  marketList: ListedMarket[];
  market: number | null;
  lastOkAt: number;
  lastError: string;
  knownBase: string | null;
  knownQuote: string | null;
  marketsLoadedAt: number;
  ownTicks: OwnTicks;
  overrides: UrlOverrides;
  contract: string;
  isTestnet: boolean;
};

export type AppState = {
  book: BookDomain;
  wallet: WalletDomain;
  orders: OrdersDomain;
  ticket: TicketDomain;
  versions: { book: number; wallet: number; orders: number; ticket: number };
};

export function emptyBookDomain(
  partial: Partial<BookDomain> & Pick<BookDomain, "contract" | "overrides" | "isTestnet">,
): BookDomain {
  return {
    snapshot: null,
    eventState: emptyEventState(),
    marketList: [],
    market: null,
    lastOkAt: 0,
    lastError: "",
    knownBase: null,
    knownQuote: null,
    marketsLoadedAt: 0,
    ownTicks: emptyOwnTicks(),
    ...partial,
  };
}

export function emptyEventState(): EventState {
  return { cursor: null, seen: new Set(), historyFrom: null, events: [] };
}

export function emptyOwnTicks(): OwnTicks {
  return { bid: new Set(), ask: new Set() };
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

function marketLabel(m: ListedMarket): string {
  const b = m.baseSym || shortAddr(m.base);
  const qs = m.quoteSym || shortAddr(m.quote);
  return `${b} / ${qs}`;
}

export function renderFresh(book: BookDomain, now = Date.now()): void {
  const el = $("fresh");
  const text = $("fresh-text");
  if (!book.snapshot && !book.lastError) {
    el.className = "fresh";
    text.textContent = "loading…";
    return;
  }
  if (book.lastError && !book.snapshot) {
    el.className = "fresh err";
    text.innerHTML = `<span class="err-text">${esc(book.lastError)}</span>`;
    return;
  }
  const ago = book.lastOkAt ? Math.max(0, Math.round((now - book.lastOkAt) / 1000)) : 0;
  const ledger = formatInt(book.snapshot!.latestLedger);
  let cls = "fresh";
  if (book.lastError) cls += " err";
  else if (ago > 15) cls += " stale";
  el.className = cls;
  const err = book.lastError ? ` <span class="err-text">${esc(book.lastError)}</span>` : "";
  text.innerHTML = `ledger ${ledger} · ${ago} s ago${err}`;
}

export function registerMarketView(
  store: Store<AppState>,
  opts: {
    onSwitchMarket: (id: number) => void;
  },
): void {
  store.register("fresh", () => renderFresh(store.read().book), () => {
    const s = store.read();
    const ago = s.book.lastOkAt ? Math.round((Date.now() - s.book.lastOkAt) / 1000) : 0;
    return `${s.versions.book}|${ago}`;
  });
  store.register(
    "market",
    () => {
      const app = store.read();
      const snap = app.book.snapshot;
      if (!snap) {
        $("pair").textContent = "-- / --";
        renderMeta(viewStateFrom(app, opts.onSwitchMarket));
        clearPanes();
        return;
      }
      render(snap, viewStateFrom(app, opts.onSwitchMarket));
    },
    () => store.read().versions.book,
  );
}

function viewStateFrom(app: AppState, onSwitchMarket: (id: number) => void): MarketViewState {
  return {
    contract: app.book.contract,
    market: app.book.market,
    marketList: app.book.marketList,
    overrides: app.book.overrides,
    isTestnet: app.book.isTestnet,
    eventState: app.book.eventState,
    onSwitchMarket,
    ownTicks: app.book.ownTicks,
  };
}

export function renderMeta(state: MarketViewState): void {
  const { market, marketList, contract, isTestnet } = state;
  const opts = marketList.length
    ? marketList
        .map((m) => `<option value="${m.id}"${m.id === market ? " selected" : ""}>${esc(marketLabel(m))} · ${m.id}</option>`)
        .join("")
    : `<option value="${market ?? 0}" selected>market ${market ?? 0}</option>`;
  const html = `<label>market <select id="market-select" aria-label="market">${opts}</select></label> · ${contractLink(contract, isTestnet)}`;
  const action = paneCache.write("meta", $("meta"), html);
  if (action === "html") {
    $("market-select").addEventListener("change", (e) => state.onSwitchMarket(Number((e.target as HTMLSelectElement).value)));
  }
}

export function render(book: BookSnapshot, state: MarketViewState): void {
  const baseSym = tokenLabel(book.tokens?.base, state.overrides.baseSym, book.base);
  const quoteSym = tokenLabel(book.tokens?.quote, state.overrides.quoteSym, book.quote);
  const pair = `${baseSym} / ${quoteSym}`;
  if ($("pair").textContent !== pair) $("pair").textContent = pair;
  renderMeta(state);

  const bid = book.bestBid;
  const ask = book.bestAsk;
  const { spread, mid, pct, ticks } = midSpread(bid, ask, book, state.overrides);
  const last = (state.eventState.events || []).find((e): e is FilledEvent => e.name === "filled");
  const staleBid = bid.stale ? `<span class="badge">stale best</span>` : "";
  const staleAsk = ask.stale ? `<span class="badge">stale best</span>` : "";
  const lastSide = last ? (last.taker === "buy" ? "bid" : "ask") : "";
  paneCache.write(
    "kpis",
    $("kpis"),
    `
    <div class="kpi bid"><span class="l">best bid</span><span class="v">${bid.empty ? "—" : esc(priceOf(bid.tick, book, state.overrides))}${staleBid}</span></div>
    <div class="kpi ask"><span class="l">best ask</span><span class="v">${ask.empty ? "—" : esc(priceOf(ask.tick, book, state.overrides))}${staleAsk}</span></div>
    <div class="kpi"><span class="l">spread</span><span class="v" title="${ticks == null ? "" : `${esc(ticks)} ticks`}">${spread == null ? "—" : esc(spread)}</span>${pct ? `<span class="sub">(${esc(pct)})</span>` : ""}</div>
    <div class="kpi"><span class="l">mid</span><span class="v">${mid == null ? "—" : esc(mid)}</span></div>
    <div class="kpi ${lastSide}"><span class="l">last</span><span class="v">${last ? `<span title="${esc(countLabel(last.lots, "lot"))}">${esc(priceOf(last.tick, book, state.overrides))} × ${esc(lotsToBase(last.lots, book, state.overrides))} ${esc(baseSym)}</span>` : "—"}</span></div>`,
  );

  paneCache.write(
    "ladder",
    $("ladder"),
    sideHtml("bids", book.bids, book, book.moreBids, state.overrides, state.ownTicks) +
      sideHtml("asks", book.asks, book, book.moreAsks, state.overrides, state.ownTicks),
  );
  paneCache.write("trades", $("trades"), tradesHtml(book, state));
  paneCache.write("activity", $("activity"), activityHtml(state));
  const note = state.eventState.historyFrom ? `history from ledger ${formatInt(state.eventState.historyFrom)}` : "";
  if ($("history-note").textContent !== note) $("history-note").textContent = note;
  paneCache.write("facts", $("facts"), factsHtml(book, baseSym, quoteSym, state));
}

function sideHtml(
  name: string,
  rows: BookSnapshot["bids"],
  book: BookSnapshot,
  more: boolean,
  overrides: UrlOverrides,
  own?: OwnTicks,
): string {
  const bsym = tokenLabel(book.tokens?.base, overrides.baseSym, book.base);
  const qsym = tokenLabel(book.tokens?.quote, overrides.quoteSym, book.quote);
  let cum = 0n;
  const withCum = rows.map((r) => {
    cum += r.open_lots;
    return { ...r, cum };
  });
  const max = cum;
  const body = withCum.length
    ? withCum
        .map((r) => {
          const w = max > 0n ? Number((r.cum * 1000n) / max) / 10 : 0;
          const side = name === "bids" ? "bid" : "ask";
          const mine = own && (side === "bid" ? own.bid.has(r.tick) : own.ask.has(r.tick));
          const price = `<span class="price" title="tick ${r.tick}">${esc(priceOf(r.tick, book, overrides))}${mine ? `<i class="own-dot ${side}"></i>` : ""}</span>`;
          const amount = `<span title="${esc(countLabel(r.open_lots, "lot"))} · ${esc(countLabel(r.queue, "order"))} queued">${esc(lotsToBase(r.open_lots, book, overrides))}${r.queue > 1 ? ` <i class="q">·${r.queue}</i>` : ""}</span>`;
          const depth = `<span title="${esc(countLabel(r.cum, "lot"))} cumulative">${esc(lotsToBase(r.cum, book, overrides))}</span>`;
          const cells = side === "bid" ? depth + amount + price : price + amount + depth;
          return `<div class="row${mine ? " own" : ""}" data-tick="${r.tick}" data-side="${side}">
            <i class="rowbar" style="width:${w}%"></i>${cells}
          </div>`;
        })
        .join("")
    : `<div class="empty">— no ${name} in window</div>`;
  return `<div class="side ${name}">
    <h3>${name}</h3>
    <div class="cols">${
      name === "bids"
        ? `<span>depth<i class="unit"> · ${esc(bsym)}</i></span><span>amount<i class="unit"> · ${esc(bsym)}</i></span><span>price<i class="unit"> · ${esc(qsym)}</i></span>`
        : `<span>price<i class="unit"> · ${esc(qsym)}</i></span><span>amount<i class="unit"> · ${esc(bsym)}</i></span><span>depth<i class="unit"> · ${esc(bsym)}</i></span>`
    }</div>
    ${body}
    ${more ? `<div class="note">more levels beyond the read window</div>` : ""}
  </div>`;
}

function txLink(hash: string): string {
  if (!hash) return "";
  const short = `${hash.slice(0, 6)}…`;
  return `<a href="https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(hash)}">${esc(short)}</a>`;
}

function tradesHtml(book: BookSnapshot, state: MarketViewState): string {
  const rows = (state.eventState.events || []).filter((e): e is FilledEvent => e.name === "filled").slice(0, 80);
  if (!rows.length) return `<li class="empty">— no trades yet</li>`;
  const qdec = tokenDecimals(book.tokens?.quote, state.overrides.quoteDec);
  const qsym = tokenLabel(book.tokens?.quote, state.overrides.quoteSym, book.quote);
  const bsym = tokenLabel(book.tokens?.base, state.overrides.baseSym, book.base);
  return rows
    .map((e) => {
      const side = e.taker === "buy" ? "buy" : "sell";
      const t = fmtTime(e.ledgerClosedAt);
      const mine = state.ownTicks && (state.ownTicks.bid.has(e.tick) || state.ownTicks.ask.has(e.tick));
      return `<li${mine ? ` class="own"` : ""}>
        <span title="${esc(t.title)}">${esc(t.text)}</span>
        <span class="${side}">${side}${mine ? `<i class="own-dot ${e.is_bid ? "bid" : "ask"}"></i>` : ""}</span>
        <span class="detail ${side}" title="${esc(countLabel(e.lots, "lot"))} · ${esc(formatInt(e.quote))} quote atoms">${esc(priceOf(e.tick, book, state.overrides))} × ${esc(lotsToBase(e.lots, book, state.overrides))} ${esc(bsym)} · ${esc(formatAtoms(e.quote, qdec))} ${esc(qsym)}</span>
        <span title="ledger ${formatInt(e.ledger)}">${txLink(e.txHash)}</span>
      </li>`;
    })
    .join("");
}

function shortNonce(n: string | number | bigint): string {
  const s = String(n);
  return s.length <= 4 ? s : `…${s.slice(-4)}`;
}

function evClass(name: string, isBid?: boolean): string {
  if (name === "rested") return `ev-rested ${isBid ? "bid" : "ask"}`;
  if (name === "settled") return "ev-settled";
  if (name === "swept") return "ev-swept";
  if (name === "top_changed") return "ev-top_changed";
  return "";
}

function activityHtml(state: MarketViewState): string {
  const names = new Set(["rested", "settled", "swept", "top_changed"]);
  const rows = (state.eventState.events || []).filter((e) => names.has(e.name)).slice(0, 80);
  if (!rows.length) return `<li class="empty">— no activity yet</li>`;
  let prevTime = "";
  return rows
    .map((e) => {
      let detail = "";
      let side: boolean | undefined;
      if (e.name === "rested") {
        const ev = e as RestedEvent;
        side = ev.is_bid;
        detail = `${ev.is_bid ? "bid" : "ask"} ${ev.tick} · ${shortAddr(ev.owner)} #${shortNonce(ev.nonce)}`;
      } else if (e.name === "settled") {
        const ev = e as SettledEvent;
        detail = `filled ${formatInt(ev.filled_lots)} · refunded ${formatInt(ev.refunded_lots)} · ${shortAddr(ev.owner)} #${shortNonce(ev.nonce)}`;
      } else if (e.name === "swept") {
        const ev = e as SweptEvent;
        side = ev.is_bid;
        detail = `${ev.is_bid ? "bid" : "ask"} ${ev.tick} g${ev.generation}`;
      } else if (e.name === "top_changed") {
        const ev = e as TopChangedEvent;
        side = ev.is_bid;
        detail = `${ev.is_bid ? "bids" : "asks"} ${ev.old} → ${ev.newTick}`;
      }
      const t = fmtTime(e.ledgerClosedAt);
      const timeText = t.text === prevTime ? "" : t.text;
      prevTime = t.text;
      const fullNonce =
        e.name === "rested" || e.name === "settled" ? String((e as RestedEvent | SettledEvent).nonce) : "";
      return `<li>
        <span title="${esc(t.title)}">${esc(timeText)}</span>
        <span class="${evClass(e.name, side)}">${esc(e.name)}</span>
        <span class="detail" title="${esc(fullNonce ? `${detail} · #${fullNonce}` : detail)}">${esc(detail)}</span>
      </li>`;
    })
    .join("");
}

function fact(dt: string, dd: string, wide = false): string {
  return `<div${wide ? ` class="wide"` : ""}><dt>${esc(dt)}</dt><dd>${dd}</dd></div>`;
}

function factsHtml(book: BookSnapshot, baseSym: string, quoteSym: string, state: MarketViewState): string {
  const m = book.market;
  if (!m) return `<div class="empty">no Market entry</div>`;
  const bd = tokenDecimals(book.tokens?.base, state.overrides.baseDec);
  const qd = tokenDecimals(book.tokens?.quote, state.overrides.quoteDec);
  const vaultB = book.vault.base == null ? "—" : `${formatAtoms(book.vault.base, bd)} ${baseSym}`;
  const vaultQ = book.vault.quote == null ? "—" : `${formatAtoms(book.vault.quote, qd)} ${quoteSym}`;
  const feeB = `${formatAtoms(book.fees.base, bd)} ${baseSym}`;
  const feeQ = `${formatAtoms(book.fees.quote, qd)} ${quoteSym}`;
  return [
    fact("base", `${esc(baseSym)} ${contractLink(m.base, state.isTestnet)}`),
    fact("quote", `${esc(quoteSym)} ${contractLink(m.quote, state.isTestnet)}`),
    fact("lot_size", formatInt(m.lot_size)),
    fact("tick_size", formatInt(m.tick_size)),
    fact("tick_band", `[${formatInt(m.tick_min)}, ${formatInt(m.tick_max)})`),
    fact("taker_fee_bps", formatInt(m.taker_fee_bps)),
    fact("order_lots", `${formatInt(m.min_order_lots)} / ${formatInt(m.max_order_lots)}`),
    fact("max_levels_crossed", formatInt(m.max_levels_crossed)),
    fact("max_slots_scanned", formatInt(m.max_slots_scanned)),
    fact("inline_slots / page_slots / max_pages", `${m.inline_slots} / ${m.page_slots} / ${m.max_pages}`),
    fact("paused", book.paused ? "yes" : "no"),
    fact("vault_base", `<span title="${esc(book.vault.base == null ? "" : `${formatInt(book.vault.base)} atoms`)}">${esc(vaultB)}</span>`),
    fact("vault_quote", `<span title="${esc(book.vault.quote == null ? "" : `${formatInt(book.vault.quote)} atoms`)}">${esc(vaultQ)}</span>`),
    fact("fees_base", `<span title="${esc(formatInt(book.fees.base))} atoms">${esc(feeB)}</span>`),
    fact("fees_quote", `<span title="${esc(formatInt(book.fees.quote))} atoms">${esc(feeQ)}</span>`),
  ].join("");
}

export function clearPanes(): void {
  paneCache.forget();
  $("kpis").innerHTML = "";
  $("ladder").innerHTML = "";
  $("trades").innerHTML = "";
  $("activity").innerHTML = "";
  $("facts").innerHTML = "";
  $("history-note").textContent = "";
}
