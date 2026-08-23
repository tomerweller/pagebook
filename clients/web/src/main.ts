import { createRpc, walkDepth, pollEvents, listMarkets, mockSnapshot, type BookEvent, type ListedMarket } from "./book";
import {
  emptyEventState,
  emptyOwnTicks,
  registerMarketView,
  type AppState,
} from "./view/market";
import type { UrlOverrides } from "./view/format";
import { mountWallet, type WalletHandle } from "./wallet/pane";
import { createStore } from "./store";
import "./style.css";

const DEFAULT_CONTRACT = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO";
const DEFAULT_RPC = "https://soroban-testnet.stellar.org";
const DEFAULT_PAIR = ["XLM", "USDC"] as const;
const MAX_EVENTS = 500;
const MARKETS_TTL_MS = 120000;

const q = new URLSearchParams(location.search);
const contract = q.get("contract") || DEFAULT_CONTRACT;
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

const store = createStore<AppState>({
  book: {
    snapshot: null,
    eventState: emptyEventState(),
    marketList: [],
    market: q.get("market") != null ? Number(q.get("market")) : null,
    lastOkAt: 0,
    lastError: "",
    eventsLoading: false,
    knownBase: null,
    knownQuote: null,
    marketsLoadedAt: 0,
    ownTicks: emptyOwnTicks(),
    overrides,
    contract,
    isTestnet: isTestnetRpc(),
  },
});

let wallet: WalletHandle | null = null;
let requestRefresh = () => {};

registerMarketView(store, {
  onSwitchMarket: switchMarket,
  onBook: (book) => wallet?.onBook(book),
  onEvents: (events) => wallet?.onEvents(events),
});

function mergeEvents(into: AppState["book"]["eventState"], incoming: BookEvent[]): void {
  const byId = new Map(into.events.map((e) => [e.id, e]));
  for (const e of incoming) byId.set(e.id, e);
  into.events = [...byId.values()]
    .sort((a, b) => {
      const ld = (b.ledger || 0) - (a.ledger || 0);
      if (ld) return ld;
      return String(b.id).localeCompare(String(a.id));
    })
    .slice(0, MAX_EVENTS);
  into.seen = new Set(into.events.map((e) => e.id).filter((id): id is string => Boolean(id)));
}

function pickDefaultMarket(list: ListedMarket[]): number {
  const hit = list.find((m) => m.baseSym === DEFAULT_PAIR[0] && m.quoteSym === DEFAULT_PAIR[1]);
  if (hit) return hit.id;
  return list.length ? list[0].id : 0;
}

async function ensureMarkets(rpc: ReturnType<typeof createRpc>): Promise<void> {
  const cur = store.read().book;
  if (cur.marketList.length && Date.now() - cur.marketsLoadedAt < MARKETS_TTL_MS) return;
  const res = await listMarkets(rpc, { contract });
  store.update((s) => {
    s.book.marketList = res.markets;
    s.book.marketsLoadedAt = Date.now();
    if (s.book.market == null) s.book.market = pickDefaultMarket(res.markets);
  });
}

function switchMarket(id: number): void {
  if (id === store.read().book.market) return;
  store.update((s) => {
    s.book.market = id;
    s.book.eventState = emptyEventState();
    s.book.eventsLoading = false;
    s.book.knownBase = null;
    s.book.knownQuote = null;
    s.book.snapshot = null;
    s.book.lastOkAt = 0;
    s.book.lastError = "";
  });
  const url = new URL(location.href);
  url.searchParams.set("market", String(id));
  history.replaceState(null, "", url);
  requestRefresh();
}

async function refresh(rpc: ReturnType<typeof createRpc>): Promise<void> {
  await ensureMarkets(rpc);
  const forMarket = store.read().book.market;
  const known = store.read().book;
  const book = await walkDepth(rpc, {
    contract,
    market: forMarket ?? 0,
    depth,
    base: known.knownBase,
    quote: known.knownQuote,
  });
  if (store.read().book.market !== forMarket) return;
  const ev = await pollEvents(rpc, {
    contract,
    market: forMarket ?? 0,
    latestLedger: book.latestLedger,
    cursor: known.eventState.cursor,
    seen: known.eventState.seen,
    historyFrom: known.eventState.historyFrom,
  });
  if (store.read().book.market !== forMarket) return;
  store.update((s) => {
    s.book.knownBase = book.base || s.book.knownBase;
    s.book.knownQuote = book.quote || s.book.knownQuote;
    s.book.snapshot = book;
    s.book.lastOkAt = Date.now();
    s.book.lastError = "";
    s.book.eventsLoading = false;
    s.book.eventState.cursor = ev.cursor;
    if (ev.historyFrom != null) s.book.eventState.historyFrom = ev.historyFrom;
    mergeEvents(s.book.eventState, ev.events);
  });
}

if (mock) {
  const snap = mockSnapshot();
  store.update((s) => {
    s.book.market = 0;
    s.book.marketList = [
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
    s.book.eventState.events = snap.events;
    s.book.eventState.historyFrom = snap.historyFrom;
    s.book.snapshot = snap;
    s.book.lastOkAt = Date.now();
  });
  setInterval(() => store.update(() => {}), 1000);
  wallet = mountWallet({
    el: $("wallet"),
    rpc: createRpc(rpcUrl),
    seed: q.get("seed"),
    contract,
    getMarket: () => store.read().book.market ?? 0,
    overrides,
    onRefresh: () => requestRefresh(),
    onOwnTicks: (t) => {
      store.update((s) => {
        s.book.ownTicks = t;
      });
    },
  });
  store.update(() => {});
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
      }
      delay = 2000;
    } catch (e) {
      store.update((s) => {
        s.book.lastError = formatRpcError(e);
      });
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
  setInterval(() => store.update(() => {}), 1000);
  wallet = mountWallet({
    el: $("wallet"),
    rpc,
    seed: q.get("seed"),
    contract,
    getMarket: () => store.read().book.market ?? 0,
    overrides,
    onRefresh: () => requestRefresh(),
    onOwnTicks: (t) => {
      store.update((s) => {
        s.book.ownTicks = t;
      });
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
