import { formatInt } from "./decode";
import { createRpc, walkDepth, pollEvents, listMarkets, mockSnapshot, type BookSnapshot, type ListedMarket } from "./book";
import { clearPanes, render, renderMeta, type EventState, type MarketViewState, type OwnTicks } from "./view/market";
import { esc, type UrlOverrides } from "./view/format";
import { mountWallet, type WalletHandle } from "./wallet/pane";
import "./style.css";

const DEFAULT_CONTRACT = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO";
const DEFAULT_RPC = "https://soroban-testnet.stellar.org";
const DEFAULT_PAIR = ["XLM", "USDC"] as const;
const MAX_EVENTS = 500;
const MARKETS_TTL_MS = 120000;

const q = new URLSearchParams(location.search);
const contract = q.get("contract") || DEFAULT_CONTRACT;
let market: number | null = q.get("market") != null ? Number(q.get("market")) : null;
let marketList: ListedMarket[] = [];
const rpcUrl = q.get("rpc") || DEFAULT_RPC;
const depth = Number(q.get("depth") ?? 12);
const mock = q.get("mock") === "1";
const overrides: UrlOverrides = {
  baseSym: q.get("base_sym"),
  quoteSym: q.get("quote_sym"),
  baseDec: q.get("base_dec") != null ? Number(q.get("base_dec")) : null,
  quoteDec: q.get("quote_dec") != null ? Number(q.get("quote_dec")) : null,
};

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

function rpcHost(): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return rpcUrl;
  }
}

function formatRpcError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return `RPC ${rpcHost()}: ${msg}`;
}

function isTestnetRpc(): boolean {
  try {
    return new URL(rpcUrl).host.includes("testnet");
  } catch {
    return false;
  }
}

let lastGood: BookSnapshot | null = null;
let lastOkAt = 0;
let lastError = "";
let eventState: EventState = { cursor: null, seen: new Set(), historyFrom: null, events: [] };
let knownBase: string | null = null;
let knownQuote: string | null = null;
let eventsLoading = false;
let marketsLoadedAt = 0;
let requestRefresh = () => {};
let wallet: WalletHandle | null = null;
let ownTicks: OwnTicks = { bid: new Set(), ask: new Set() };

function notifyWallet(book: BookSnapshot): void {
  wallet?.onBook(book);
}

function viewState(): MarketViewState {
  return {
    contract,
    market,
    marketList,
    overrides,
    isTestnet: isTestnetRpc(),
    eventState,
    eventsLoading,
    onSwitchMarket: switchMarket,
    ownTicks,
  };
}

function setFresh(): void {
  const el = $("fresh");
  const text = $("fresh-text");
  const now = Date.now();
  if (!lastGood && !lastError) {
    el.className = "fresh";
    text.textContent = "loading…";
    return;
  }
  if (lastError && !lastGood) {
    el.className = "fresh err";
    text.innerHTML = `<span class="err-text">${esc(lastError)}</span>`;
    return;
  }
  const ago = lastOkAt ? Math.max(0, Math.round((now - lastOkAt) / 1000)) : 0;
  const ledger = formatInt(lastGood!.latestLedger);
  let cls = "fresh";
  if (lastError) cls += " err";
  else if (ago > 15) cls += " stale";
  el.className = cls;
  const err = lastError ? ` <span class="err-text">${esc(lastError)}</span>` : "";
  text.innerHTML = `ledger ${ledger} · ${ago} s ago${err}`;
}

function mergeEvents(incoming: EventState["events"]): void {
  const byId = new Map(eventState.events.map((e) => [e.id, e]));
  for (const e of incoming) byId.set(e.id, e);
  eventState.events = [...byId.values()]
    .sort((a, b) => {
      const ld = (b.ledger || 0) - (a.ledger || 0);
      if (ld) return ld;
      return String(b.id).localeCompare(String(a.id));
    })
    .slice(0, MAX_EVENTS);
  eventState.seen = new Set(eventState.events.map((e) => e.id).filter((id): id is string => Boolean(id)));
}

function pickDefaultMarket(list: ListedMarket[]): number {
  const hit = list.find((m) => m.baseSym === DEFAULT_PAIR[0] && m.quoteSym === DEFAULT_PAIR[1]);
  if (hit) return hit.id;
  return list.length ? list[0].id : 0;
}

async function ensureMarkets(rpc: ReturnType<typeof createRpc>): Promise<void> {
  if (marketList.length && Date.now() - marketsLoadedAt < MARKETS_TTL_MS) return;
  const res = await listMarkets(rpc, { contract });
  marketList = res.markets;
  marketsLoadedAt = Date.now();
  if (market == null) market = pickDefaultMarket(marketList);
  renderMeta(viewState());
}

function resetMarketState(): void {
  eventState = { cursor: null, seen: new Set(), historyFrom: null, events: [] };
  eventsLoading = false;
  knownBase = null;
  knownQuote = null;
  lastGood = null;
  lastOkAt = 0;
  lastError = "";
}

function switchMarket(id: number): void {
  if (id === market) return;
  market = id;
  const url = new URL(location.href);
  url.searchParams.set("market", String(id));
  history.replaceState(null, "", url);
  resetMarketState();
  clearPanes();
  renderMeta(viewState());
  setFresh();
  requestRefresh();
}

async function refresh(rpc: ReturnType<typeof createRpc>): Promise<void> {
  await ensureMarkets(rpc);
  const forMarket = market;
  const book = await walkDepth(rpc, {
    contract,
    market: market ?? 0,
    depth,
    base: knownBase,
    quote: knownQuote,
  });
  if (market !== forMarket) return;
  knownBase = book.base || knownBase;
  knownQuote = book.quote || knownQuote;
  lastGood = book;
  lastOkAt = Date.now();
  lastError = "";
  if (!eventState.events.length && !eventState.cursor) eventsLoading = true;
  render(book, viewState());
  setFresh();
  notifyWallet(book);
  try {
    const ev = await pollEvents(rpc, {
      contract,
      market: market ?? 0,
      latestLedger: book.latestLedger,
      cursor: eventState.cursor,
      seen: eventState.seen,
      historyFrom: eventState.historyFrom,
    });
    if (market !== forMarket) return;
    eventState.cursor = ev.cursor;
    if (ev.historyFrom != null) eventState.historyFrom = ev.historyFrom;
    mergeEvents(ev.events);
  } finally {
    if (market === forMarket) eventsLoading = false;
  }
  render(book, viewState());
  setFresh();
  wallet?.onEvents(eventState.events);
  notifyWallet(book);
}

if (mock) {
  const snap = mockSnapshot();
  market = 0;
  marketList = [
    {
      id: 0,
      base: snap.base!,
      quote: snap.quote!,
      market: snap.market!,
      baseMeta: snap.tokens.base,
      quoteMeta: snap.tokens.quote,
      baseSym: "PBA",
      quoteSym: "PBB",
    },
  ];
  eventState.events = snap.events;
  eventState.historyFrom = snap.historyFrom;
  lastGood = snap;
  lastOkAt = Date.now();
  render(snap, viewState());
  setFresh();
  setInterval(setFresh, 1000);
  wallet = mountWallet({
    el: $("wallet"),
    rpc: createRpc(rpcUrl),
    seed: q.get("seed"),
    contract,
    getMarket: () => market ?? 0,
    overrides,
    onRefresh: () => requestRefresh(),
    onOwnTicks: (t) => {
      ownTicks = t;
      if (lastGood) render(lastGood, viewState());
    },
  });
  notifyWallet(snap);
} else {
  const rpc = createRpc(rpcUrl);
  let delay = 2000;
  let lastSeq = 0;
  let didFirst = false;
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  let inflight = false;
  let forced = false;

  requestRefresh = () => {
    forced = true;
    if (tickTimer != null) clearTimeout(tickTimer);
    tickTimer = null;
    tick();
  };

  function schedule(ms: number) {
    if (tickTimer != null) clearTimeout(tickTimer);
    tickTimer = setTimeout(tick, ms);
  }

  async function tick() {
    if (inflight) return;
    inflight = true;
    tickTimer = null;
    try {
      const latest = await rpc.getLatestLedger();
      const seq = latest.sequence;
      if (!didFirst || seq !== lastSeq || forced) {
        forced = false;
        lastSeq = seq;
        await refresh(rpc);
        didFirst = true;
      } else {
        setFresh();
      }
      delay = 2000;
    } catch (e) {
      lastError = formatRpcError(e);
      setFresh();
      delay = Math.min(delay * 2, 10000);
    } finally {
      inflight = false;
      schedule(forced ? 0 : document.hidden && didFirst ? 5000 : delay);
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      if (tickTimer != null) clearTimeout(tickTimer);
      tickTimer = null;
      tick();
    }
  });
  setFresh();
  setInterval(setFresh, 1000);
  wallet = mountWallet({
    el: $("wallet"),
    rpc,
    seed: q.get("seed"),
    contract,
    getMarket: () => market ?? 0,
    overrides,
    onRefresh: () => requestRefresh(),
    onOwnTicks: (t) => {
      ownTicks = t;
      if (lastGood) render(lastGood, viewState());
    },
  });
  $("ladder").addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest("[data-tick]");
    if (!row) return;
    const side = row.getAttribute("data-side");
    const tickN = Number(row.getAttribute("data-tick"));
    if ((side === "bid" || side === "ask") && Number.isFinite(tickN)) wallet?.prefillFromLadder(side, tickN);
  });
  tick();
}
