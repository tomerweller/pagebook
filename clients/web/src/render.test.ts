/**
 * @vitest-environment jsdom
 */
import { expect, test } from "vitest";
import { mockSnapshot, type BookSnapshot, type Rpc } from "./book";
import { MarkupCache } from "./view/stable";
import { createOrders, type OpenOrder } from "./wallet/orders";
import { createTicket } from "./wallet/ticket";
import type { UrlOverrides } from "./view/format";
import { createStore } from "./store";
import { emptyEventState, emptyOwnTicks, registerMarketView, type AppState } from "./view/market";

const emptyOv: UrlOverrides = { baseSym: null, quoteSym: null, baseDec: null, quoteDec: null };

function stubRpc(sims: { n: number }): Rpc {
  return {
    getLatestLedger: async () => ({ sequence: 1 }),
    getLedgerEntries: async () => ({ entries: [] }),
    getEvents: async () => ({ events: [] }),
    getNetwork: async () => ({ passphrase: "Test SDF Network ; September 2015" }),
    sendTransaction: async () => ({ status: "PENDING" }),
    getTransaction: async () => ({ status: "NOT_FOUND" }),
    simulateTransaction: async () => {
      sims.n += 1;
      return { error: "Error(Contract, #9)" };
    },
  } as unknown as Rpc;
}

function ticketOpts(rpc: Rpc) {
  return {
    rpc,
    contract: "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO",
    getSecret: () => null,
    getPublic: () => "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    getMarket: () => 1,
    onRefresh: () => {},
    onRested: () => {},
    onLog: () => {},
  };
}

function bareBook(): BookSnapshot {
  const b = mockSnapshot();
  return { ...b, tokens: { base: null, quote: null }, base: null, quote: null };
}

function namedBook(): BookSnapshot {
  const b = mockSnapshot();
  return {
    ...b,
    tokens: {
      base: { symbol: "XLM", decimals: 7, name: "native" },
      quote: { symbol: "USDC", decimals: 7, name: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    },
  };
}

test("late token metadata updates BUY text and price label", () => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const t = createTicket(ticketOpts(stubRpc({ n: 0 })));
  t.draw(root);
  t.setLive(bareBook(), null, [], emptyOv);
  expect(root.querySelector("[data-act=place]")?.textContent).toMatch(/\?/);
  t.setLive(namedBook(), null, [], emptyOv);
  expect(root.querySelector("[data-act=place]")?.textContent).toMatch(/XLM/);
  const priceLabel = root.querySelector("[data-field=price]")?.closest("label")?.textContent ?? "";
  expect(priceLabel).toMatch(/USDC/);
  expect(priceLabel).toMatch(/XLM/);
  root.remove();
});

test("SELL click while price is focused flips side classes and CTA", () => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const t = createTicket(ticketOpts(stubRpc({ n: 0 })));
  t.draw(root);
  t.setLive(namedBook(), null, [], emptyOv);
  const price = root.querySelector<HTMLInputElement>("[data-field=price]");
  expect(price).toBeTruthy();
  price!.focus();
  expect(document.activeElement).toBe(price);
  root.querySelector<HTMLButtonElement>("[data-act=sell]")!.click();
  expect(root.querySelector("[data-act=sell]")?.className).toMatch(/on ask/);
  expect(root.querySelector("[data-act=buy]")?.className).not.toMatch(/on bid/);
  expect(root.querySelector("[data-act=place]")?.textContent).toMatch(/SELL/);
  root.remove();
});

test("scroll-blocked MarkupCache retries and stays truthful", () => {
  const node = document.createElement("div");
  document.body.appendChild(node);
  const c = new MarkupCache();
  const htmlA = "<div class=\"s\"><p>a</p></div>";
  const htmlB = "<div class=\"s\"><p>b</p></div>";
  expect(c.write("trades", node, htmlA)).toBe("html");
  expect(c.get("trades")).toBe(node.innerHTML);
  const inner = node.querySelector(".s") as HTMLElement;
  Object.defineProperty(inner, "scrollTop", { value: 8, configurable: true });
  expect(c.write("trades", node, htmlB)).toBe("patch");
  expect(c.get("trades")).toBe(htmlA);
  expect(node.innerHTML).toBe(htmlA);
  Object.defineProperty(inner, "scrollTop", { value: 0, configurable: true });
  expect(c.write("trades", node, htmlB)).toBe("html");
  expect(c.get("trades")).toBe(node.innerHTML);
  node.remove();
});

test("orders panel picks up late token symbols", () => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const orders = createOrders(ticketOpts(stubRpc({ n: 0 })));
  const row: OpenOrder = {
    nonce: 1n,
    isBid: true,
    tick: 99,
    qtyLots: 2n,
    filledLots: 0n,
    refundLots: 0n,
    generation: 1,
    seq: 0,
    archived: false,
  };
  const bare = bareBook();
  orders.setLive(bare, null, [row], emptyOv);
  orders.draw(root);
  root.querySelector<HTMLButtonElement>("[data-act=replace-ask]")!.click();
  expect(root.textContent ?? "").not.toMatch(/PBA/);
  const named = mockSnapshot();
  orders.setLive(named, null, [row], emptyOv);
  expect(root.textContent ?? "").toMatch(/PBA/);
  root.remove();
});

test("orders replace price keeps focus and caret across paint", () => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const orders = createOrders(ticketOpts(stubRpc({ n: 0 })));
  const row: OpenOrder = {
    nonce: 7n,
    isBid: true,
    tick: 99,
    qtyLots: 2n,
    filledLots: 0n,
    refundLots: 0n,
    generation: 1,
    seq: 0,
    archived: false,
  };
  orders.setLive(mockSnapshot(), null, [row], emptyOv);
  orders.draw(root);
  root.querySelector<HTMLButtonElement>("[data-act=replace-ask]")!.click();
  const input = root.querySelector<HTMLInputElement>("[data-field=rprice]");
  expect(input).toBeTruthy();
  input!.focus();
  input!.value = "12.5";
  input!.dispatchEvent(new Event("input", { bubbles: true }));
  input!.setSelectionRange(2, 2);
  orders.setLive(mockSnapshot(), null, [row], emptyOv);
  const again = root.querySelector<HTMLInputElement>("[data-field=rprice]");
  expect(document.activeElement).toBe(again);
  expect(again?.selectionStart).toBe(2);
  expect(again?.value).toBe("12.5");
  root.remove();
});

function liveTicket(sims: { n: number }) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const t = createTicket(ticketOpts(stubRpc(sims)));
  t.draw(root);
  const book = namedBook();
  const acc = { exists: true, balance: 10n ** 10n, spendable: 10n ** 10n, sequence: 1n, numSubEntries: 0 };
  const usdc = {
    asset: { type: "credit" as const, code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    exists: true,
    balance: 10n ** 12n,
  };
  return { root, t, book, acc, usdc };
}

test("idle ticket does not simulate on an unchanged book", async () => {
  const sims = { n: 0 };
  const { root, t, book, acc, usdc } = liveTicket(sims);
  t.setLive(book, acc, [usdc], emptyOv);
  await new Promise((r) => setTimeout(r, 500));
  const afterFirst = sims.n;
  expect(afterFirst).toBeGreaterThan(0);
  t.setLive({ ...book, latestLedger: book.latestLedger + 1 }, acc, [usdc], emptyOv);
  t.setLive({ ...book, latestLedger: book.latestLedger + 2 }, acc, [usdc], emptyOv);
  await new Promise((r) => setTimeout(r, 500));
  expect(sims.n).toBe(afterFirst);
  root.remove();
});

test("best-ask size change re-runs preview", async () => {
  const sims = { n: 0 };
  const { root, t, book, acc, usdc } = liveTicket(sims);
  t.setLive(book, acc, [usdc], emptyOv);
  await new Promise((r) => setTimeout(r, 500));
  const afterFirst = sims.n;
  expect(afterFirst).toBeGreaterThan(0);
  const asks = book.asks.map((r, i) => (i === 0 ? { ...r, open_lots: r.open_lots + 3n } : r));
  t.setLive({ ...book, asks, latestLedger: book.latestLedger + 1 }, acc, [usdc], emptyOv);
  await new Promise((r) => setTimeout(r, 500));
  expect(sims.n).toBeGreaterThan(afterFirst);
  root.remove();
});

function mountShell(): void {
  document.body.innerHTML = `
    <h1 id="pair">-- / --</h1>
    <div id="meta"></div>
    <div id="fresh"><span id="fresh-text"></span></div>
    <div id="kpis"></div>
    <div id="ladder"></div>
    <ol id="trades"></ol>
    <p id="history-note"></p>
    <ol id="activity"></ol>
    <dl id="facts"></dl>
  `;
}

function emptyBookDomain(): AppState["book"] {
  return {
    snapshot: null,
    eventState: emptyEventState(),
    marketList: [],
    market: 0,
    lastOkAt: 0,
    lastError: "",
    eventsLoading: false,
    knownBase: null,
    knownQuote: null,
    marketsLoadedAt: 0,
    ownTicks: emptyOwnTicks(),
    overrides: emptyOv,
    contract: "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO",
    isTestnet: true,
  };
}

test("book update renders ladder and kpis via store", async () => {
  mountShell();
  const store = createStore<AppState>({ book: emptyBookDomain() });
  registerMarketView(store, {
    onSwitchMarket: () => {},
    onBook: () => {},
    onEvents: () => {},
  });
  const snap = mockSnapshot();
  store.update((s) => {
    s.book.snapshot = snap;
    s.book.lastOkAt = Date.now();
    s.book.eventState.events = snap.events;
    s.book.eventState.historyFrom = snap.historyFrom;
  });
  await Promise.resolve();
  expect(document.getElementById("kpis")!.innerHTML).toMatch(/best bid/);
  expect(document.getElementById("ladder")!.innerHTML).toMatch(/data-tick/);
  expect(document.getElementById("pair")!.textContent).not.toBe("-- / --");
});
