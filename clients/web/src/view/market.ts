import { formatInt, formatAtoms } from "../decode";
import type { BookEvent, BookSnapshot, FilledEvent, ListedMarket, RestedEvent, SettledEvent, SweptEvent, TopChangedEvent } from "../book";
import {
  contractLink,
  esc,
  fmtTime,
  midSpread,
  priceOf,
  shortAddr,
  tokenDecimals,
  tokenLabel,
  type UrlOverrides,
} from "./format";

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
  eventsLoading: boolean;
  onSwitchMarket: (id: number) => void;
  ownTicks?: OwnTicks;
};

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

export function renderMeta(state: MarketViewState): void {
  const { market, marketList, contract, isTestnet } = state;
  const opts = marketList.length
    ? marketList
        .map((m) => `<option value="${m.id}"${m.id === market ? " selected" : ""}>${esc(marketLabel(m))} · ${m.id}</option>`)
        .join("")
    : `<option value="${market ?? 0}" selected>market ${market ?? 0}</option>`;
  $("meta").innerHTML = `<label>market <select id="market-select" aria-label="market">${opts}</select></label> · ${contractLink(contract, isTestnet)}`;
  $("market-select").addEventListener("change", (e) => state.onSwitchMarket(Number((e.target as HTMLSelectElement).value)));
}

export function render(book: BookSnapshot, state: MarketViewState): void {
  const baseSym = tokenLabel(book.tokens?.base, state.overrides.baseSym, book.base);
  const quoteSym = tokenLabel(book.tokens?.quote, state.overrides.quoteSym, book.quote);
  $("pair").textContent = `${baseSym} / ${quoteSym}`;
  renderMeta(state);

  const bid = book.bestBid;
  const ask = book.bestAsk;
  const { spread, mid, pct, ticks } = midSpread(bid, ask, book, state.overrides);
  const last = (state.eventState.events || []).find((e): e is FilledEvent => e.name === "filled");
  const staleBid = bid.stale ? `<span class="badge">stale best</span>` : "";
  const staleAsk = ask.stale ? `<span class="badge">stale best</span>` : "";
  $("kpis").innerHTML = `
    <div class="kpi bid"><span class="l">best bid</span><span class="v">${bid.empty ? "—" : esc(priceOf(bid.tick, book, state.overrides))}${staleBid}</span></div>
    <div class="kpi ask"><span class="l">best ask</span><span class="v">${ask.empty ? "—" : esc(priceOf(ask.tick, book, state.overrides))}${staleAsk}</span></div>
    <div class="kpi"><span class="l">spread</span><span class="v" title="${ticks == null ? "" : `${esc(ticks)} ticks`}">${spread == null ? "—" : `${esc(spread)} (${esc(pct)})`}</span></div>
    <div class="kpi"><span class="l">mid</span><span class="v">${mid == null ? "—" : esc(mid)}</span></div>
    <div class="kpi"><span class="l">last</span><span class="v">${last ? `${esc(priceOf(last.tick, book, state.overrides))} × ${esc(formatInt(last.lots))} lots` : "—"}</span></div>`;

  $("ladder").innerHTML =
    sideHtml("bids", book.bids, book, book.moreBids, state.overrides, state.ownTicks) +
    sideHtml("asks", book.asks, book, book.moreAsks, state.overrides, state.ownTicks);
  $("trades").innerHTML = tradesHtml(book, state);
  $("activity").innerHTML = activityHtml(state);
  $("history-note").textContent = state.eventState.historyFrom
    ? `history from ledger ${formatInt(state.eventState.historyFrom)}`
    : "";
  $("facts").innerHTML = factsHtml(book, baseSym, quoteSym, state);
}

function sideHtml(
  name: string,
  rows: BookSnapshot["bids"],
  book: BookSnapshot,
  more: boolean,
  overrides: UrlOverrides,
  own?: OwnTicks,
): string {
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
          return `<div class="row${mine ? " own" : ""}" data-tick="${r.tick}" data-side="${side}">
            <span>${r.tick}${mine ? `<i class="own-dot ${side}"></i>` : ""}</span>
            <span>${esc(priceOf(r.tick, book, overrides))}</span>
            <span>${esc(formatInt(r.open_lots))}</span>
            <span>${r.queue}</span>
            <span class="bar"><i style="width:${w}%"></i> ${esc(formatInt(r.cum))}</span>
          </div>`;
        })
        .join("")
    : `<div class="empty">empty</div>`;
  return `<div class="side ${name}">
    <h3>${name}</h3>
    <div class="cols"><span>tick</span><span>price</span><span>lots</span><span>q</span><span>cum</span></div>
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
  if (state.eventsLoading && !(state.eventState.events || []).length) {
    return `<li class="empty">loading trades…</li>`;
  }
  const rows = (state.eventState.events || []).filter((e): e is FilledEvent => e.name === "filled").slice(0, 80);
  if (!rows.length) return `<li class="empty">no trades in window</li>`;
  const qdec = tokenDecimals(book.tokens?.quote, state.overrides.quoteDec);
  const qsym = tokenLabel(book.tokens?.quote, state.overrides.quoteSym, book.quote);
  return rows
    .map((e) => {
      const side = e.taker === "buy" ? "buy" : "sell";
      const t = fmtTime(e.ledgerClosedAt);
      const mine = state.ownTicks && (state.ownTicks.bid.has(e.tick) || state.ownTicks.ask.has(e.tick));
      return `<li${mine ? ` class="own"` : ""}>
        <span title="${esc(t.title)}">${esc(t.text)}</span>
        <span class="${side}">${side}${mine ? `<i class="own-dot ${e.is_bid ? "bid" : "ask"}"></i>` : ""}</span>
        <span title="${esc(formatInt(e.quote))} atoms">${e.tick} × ${esc(formatInt(e.lots))} · ${esc(formatAtoms(e.quote, qdec))} ${esc(qsym)}</span>
        <span>${formatInt(e.ledger)} ${txLink(e.txHash)}</span>
      </li>`;
    })
    .join("");
}

function activityHtml(state: MarketViewState): string {
  if (state.eventsLoading && !(state.eventState.events || []).length) {
    return `<li class="empty">loading trades…</li>`;
  }
  const names = new Set(["rested", "settled", "swept", "top_changed"]);
  const rows = (state.eventState.events || []).filter((e) => names.has(e.name)).slice(0, 80);
  if (!rows.length) return `<li class="empty">no activity in window</li>`;
  return rows
    .map((e) => {
      let detail = "";
      if (e.name === "rested") {
        const ev = e as RestedEvent;
        detail = `${shortAddr(ev.owner)} #${ev.nonce} · ${ev.is_bid ? "bid" : "ask"} ${ev.tick} · g${ev.generation} s${ev.seq}`;
      } else if (e.name === "settled") {
        const ev = e as SettledEvent;
        detail = `${shortAddr(ev.owner)} #${ev.nonce} · filled ${formatInt(ev.filled_lots)} · refunded ${formatInt(ev.refunded_lots)}`;
      } else if (e.name === "swept") {
        const ev = e as SweptEvent;
        detail = `${ev.is_bid ? "bid" : "ask"} ${ev.tick} g${ev.generation}`;
      } else if (e.name === "top_changed") {
        const ev = e as TopChangedEvent;
        detail = `${ev.is_bid ? "bids" : "asks"} ${ev.old} → ${ev.newTick}`;
      }
      const t = fmtTime(e.ledgerClosedAt);
      return `<li>
        <span title="${esc(t.title)}">${esc(t.text)}</span>
        <span>${esc(e.name)}</span>
        <span class="detail" title="${esc(detail)}">${esc(detail)}</span>
      </li>`;
    })
    .join("");
}

function fact(dt: string, dd: string): string {
  return `<div><dt>${esc(dt)}</dt><dd>${dd}</dd></div>`;
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
    fact("tick band", `[${formatInt(m.tick_min)}, ${formatInt(m.tick_max)})`),
    fact("taker fee", `${formatInt(m.taker_fee_bps)} bps`),
    fact("order lots", `${formatInt(m.min_order_lots)} / ${formatInt(m.max_order_lots)}`),
    fact("max levels crossed", formatInt(m.max_levels_crossed)),
    fact("max slots scanned", formatInt(m.max_slots_scanned)),
    fact("inline / page / max pages", `${m.inline_slots} / ${m.page_slots} / ${m.max_pages}`),
    fact("paused", book.paused ? "yes" : "no"),
    fact(
      "vault",
      `<span title="${esc(book.vault.base == null ? "" : `${formatInt(book.vault.base)} atoms`)}">${esc(vaultB)}</span> · <span title="${esc(book.vault.quote == null ? "" : `${formatInt(book.vault.quote)} atoms`)}">${esc(vaultQ)}</span>`,
    ),
    fact(
      "fees accrued",
      `<span title="${esc(formatInt(book.fees.base))} atoms">${esc(feeB)}</span> · <span title="${esc(formatInt(book.fees.quote))} atoms">${esc(feeQ)}</span>`,
    ),
  ].join("");
}

export function clearPanes(): void {
  $("kpis").innerHTML = "";
  $("ladder").innerHTML = "";
  $("trades").innerHTML = "";
  $("activity").innerHTML = "";
  $("facts").innerHTML = "";
  $("history-note").textContent = "";
}
