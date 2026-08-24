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
import { emptyBookDomain, registerMarketView, type AppState } from "./view/market";
import { emptyWalletDomain, mountWallet } from "./wallet/pane";
import { emptyOrdersDomain } from "./wallet/orders";
import { emptyTicketDomain } from "./wallet/ticket";
import { assertInSheetViewport, stubRect } from "./view/viewport";

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

const testId = {
  name: "t",
  publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  secret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHW4",
};

function ticketOpts(rpc: Rpc, store: ReturnType<typeof createStore<AppState>>) {
  return {
    store,
    rpc,
    contract: "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO",
    getSecret: () => null,
    getPublic: () => testId.publicKey,
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

function liveWallet(store: ReturnType<typeof createStore<AppState>>): void {
  store.update((s) => {
    s.wallet.enabled = true;
    s.wallet.active = testId;
  });
}

test("late token metadata updates BUY text and price label", async () => {
  const store = createStore<AppState>(emptyApp());
  const root = document.createElement("div");
  document.body.appendChild(root);
  const t = createTicket(ticketOpts(stubRpc({ n: 0 }), store));
  t.attach(root);
  liveWallet(store);
  store.update((s) => {
    s.book.snapshot = bareBook();
  });
  await flush();
  expect(root.querySelector("[data-act=place]")?.textContent).toMatch(/\?/);
  store.update((s) => {
    s.book.snapshot = namedBook();
  });
  await flush();
  expect(root.querySelector("[data-act=place]")?.textContent).toMatch(/XLM/);
  const priceLabel = root.querySelector("[data-field=price]")?.closest("label")?.textContent ?? "";
  expect(priceLabel).toMatch(/USDC/);
  expect(priceLabel).toMatch(/XLM/);
  root.remove();
});

test("SELL click while price is focused flips side classes and CTA", async () => {
  const store = createStore<AppState>(emptyApp());
  const root = document.createElement("div");
  document.body.appendChild(root);
  const t = createTicket(ticketOpts(stubRpc({ n: 0 }), store));
  t.attach(root);
  liveWallet(store);
  store.update((s) => {
    s.book.snapshot = namedBook();
  });
  await flush();
  const price = root.querySelector<HTMLInputElement>("[data-field=price]");
  expect(price).toBeTruthy();
  price!.focus();
  expect(document.activeElement).toBe(price);
  root.querySelector<HTMLButtonElement>("[data-act=sell]")!.click();
  await flush();
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
  Object.defineProperty(inner, "scrollTop", { value: 8, configurable: true, writable: true });
  expect(c.write("trades", node, htmlB)).toBe("html");
  expect(c.get("trades")).toBe(htmlB);
  expect(node.innerHTML).toBe(htmlB);
  node.remove();
});

function sampleOrder(nonce = 1n): OpenOrder {
  return {
    nonce,
    isBid: true,
    tick: 99,
    qtyLots: 2n,
    filledLots: 0n,
    refundLots: 0n,
    generation: 1,
    seq: 0,
    archived: false,
  };
}

async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function mountOrders(store: ReturnType<typeof createStore<AppState>>) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const orders = createOrders({ ...ticketOpts(stubRpc({ n: 0 }), store), getMarket: () => 0 });
  orders.draw(root);
  return root;
}

test("orders panel picks up late token symbols", async () => {
  const store = createStore<AppState>(emptyApp());
  const root = mountOrders(store);
  const row = sampleOrder();
  store.update((s) => {
    s.book.snapshot = bareBook();
    s.wallet.openOrders = [row];
  });
  await flush();
  root.querySelector<HTMLButtonElement>("[data-act=replace-ask]")!.click();
  await flush();
  expect(root.textContent ?? "").not.toMatch(/PBA/);
  store.update((s) => {
    s.book.snapshot = mockSnapshot();
  });
  await flush();
  expect(root.textContent ?? "").toMatch(/PBA/);
  root.remove();
});

test("orders replace price keeps focus and caret across paint", async () => {
  const store = createStore<AppState>(emptyApp());
  const root = mountOrders(store);
  store.update((s) => {
    s.book.snapshot = mockSnapshot();
    s.wallet.openOrders = [sampleOrder(7n)];
  });
  await flush();
  root.querySelector<HTMLButtonElement>("[data-act=replace-ask]")!.click();
  await flush();
  const input = root.querySelector<HTMLInputElement>("[data-field=rprice]");
  expect(input).toBeTruthy();
  input!.focus();
  input!.value = "12.5";
  input!.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  const typed = root.querySelector<HTMLInputElement>("[data-field=rprice]")!;
  typed.focus();
  typed.setSelectionRange(2, 2);
  store.update((s) => {
    s.book.snapshot = { ...mockSnapshot(), latestLedger: mockSnapshot().latestLedger + 1 };
  });
  await flush();
  const again = root.querySelector<HTMLInputElement>("[data-field=rprice]");
  expect(document.activeElement).toBe(again);
  expect(again?.selectionStart).toBe(2);
  expect(again?.value).toBe("12.5");
  root.remove();
});

test("typing in replace price updates net preview while focused", async () => {
  const store = createStore<AppState>(emptyApp());
  const root = mountOrders(store);
  store.update((s) => {
    s.book.snapshot = mockSnapshot();
    s.wallet.openOrders = [sampleOrder(7n)];
  });
  await flush();
  root.querySelector<HTMLButtonElement>("[data-act=replace-ask]")!.click();
  await flush();
  const input = root.querySelector<HTMLInputElement>("[data-field=rprice]");
  input!.focus();
  input!.value = "50";
  input!.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  expect(document.activeElement).toBe(root.querySelector("[data-field=rprice]"));
  expect(root.textContent ?? "").toMatch(/tick 50/);
  root.remove();
});

function liveTicket(sims: { n: number }) {
  const store = createStore<AppState>(emptyApp());
  const root = document.createElement("div");
  document.body.appendChild(root);
  const t = createTicket(ticketOpts(stubRpc(sims), store));
  t.attach(root);
  const book = namedBook();
  const acc = { exists: true, balance: 10n ** 10n, spendable: 10n ** 10n, sequence: 1n, numSubEntries: 0 };
  const usdc = {
    asset: { type: "credit" as const, code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    exists: true,
    balance: 10n ** 12n,
  };
  liveWallet(store);
  store.update((s) => {
    s.book.snapshot = book;
    s.wallet.account = acc;
    s.wallet.trustlines = [usdc];
  });
  return { root, t, book, acc, usdc, store };
}

test("idle ticket does not simulate on an unchanged book", async () => {
  const sims = { n: 0 };
  const { root, store, book, acc, usdc } = liveTicket(sims);
  await new Promise((r) => setTimeout(r, 500));
  const afterFirst = sims.n;
  expect(afterFirst).toBeGreaterThan(0);
  store.update((s) => {
    s.book.snapshot = { ...book, latestLedger: book.latestLedger + 1 };
    s.wallet.account = acc;
    s.wallet.trustlines = [usdc];
  });
  store.update((s) => {
    s.book.snapshot = { ...book, latestLedger: book.latestLedger + 2 };
    s.wallet.account = acc;
    s.wallet.trustlines = [usdc];
  });
  await new Promise((r) => setTimeout(r, 500));
  expect(sims.n).toBe(afterFirst);
  root.remove();
});

test("best-ask size change re-runs preview", async () => {
  const sims = { n: 0 };
  const { root, store, book, acc, usdc } = liveTicket(sims);
  await new Promise((r) => setTimeout(r, 500));
  const afterFirst = sims.n;
  expect(afterFirst).toBeGreaterThan(0);
  const asks = book.asks.map((r, i) => (i === 0 ? { ...r, open_lots: r.open_lots + 3n } : r));
  store.update((s) => {
    s.book.snapshot = { ...book, asks, latestLedger: book.latestLedger + 1 };
    s.wallet.account = acc;
    s.wallet.trustlines = [usdc];
  });
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

function emptyApp(): AppState {
  return {
    book: emptyBookDomain({
      market: 0,
      overrides: emptyOv,
      contract: "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO",
      isTestnet: true,
    }),
    wallet: emptyWalletDomain(null),
    orders: emptyOrdersDomain(),
    ticket: emptyTicketDomain(),
    versions: { book: 0, wallet: 0, orders: 0, ticket: 0 },
  };
}

test("book update renders ladder and kpis via store", async () => {
  mountShell();
  const store = createStore<AppState>(emptyApp());
  registerMarketView(store, {
    onSwitchMarket: () => {},
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

test("wallet section renders from a store mutation", async () => {
  document.body.innerHTML = `<aside id="wallet"></aside>`;
  const store = createStore<AppState>(emptyApp());
  mountWallet({
    store,
    el: document.getElementById("wallet")!,
    rpc: stubRpc({ n: 0 }),
    getMarket: () => 0,
    onRefresh: () => {},
  });
  await flush();
  expect(document.querySelector("[data-act=toggle]")).toBeTruthy();
  store.update((s) => {
    s.wallet.booted = true;
    s.wallet.enabled = true;
    s.wallet.status = "hello from store";
  });
  await Promise.resolve();
  expect(document.querySelector(".wallet-status")?.textContent).toBe("hello from store");
});

test("provisioning status line appears and disappears via store", async () => {
  document.body.innerHTML = `<aside id="wallet"></aside>`;
  const store = createStore<AppState>(emptyApp());
  mountWallet({
    store,
    el: document.getElementById("wallet")!,
    rpc: stubRpc({ n: 0 }),
    getMarket: () => 0,
    onRefresh: () => {},
  });
  await flush();
  const id = {
    name: "t",
    publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    secret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHW4",
  };
  store.update((s) => {
    s.wallet.booted = true;
    s.wallet.enabled = true;
    s.wallet.active = id;
    s.wallet.identities = [id];
    s.wallet.account = { exists: false, balance: 0n, spendable: 0n, sequence: 0n, numSubEntries: 0 };
    s.wallet.provisionStatus = "funding…";
  });
  await Promise.resolve();
  expect(document.querySelector("[data-role=provision]")?.textContent).toBe("funding…");
  store.update((s) => {
    s.wallet.provisionStatus = "";
  });
  await Promise.resolve();
  expect(document.querySelector("[data-role=provision]")).toBeNull();
});

test("reveal secret paints immediately while the button is focused", async () => {
  document.body.innerHTML = `<aside id="wallet"></aside>`;
  const store = createStore<AppState>(emptyApp());
  mountWallet({
    store,
    el: document.getElementById("wallet")!,
    rpc: stubRpc({ n: 0 }),
    getMarket: () => 0,
    onRefresh: () => {},
  });
  await flush();
  const id = {
    name: "t",
    publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    secret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHW4",
  };
  store.update((s) => {
    s.wallet.booted = true;
    s.wallet.enabled = true;
    s.wallet.active = id;
    s.wallet.identities = [id];
    s.wallet.account = { exists: true, balance: 1n, spendable: 1n, sequence: 1n, numSubEntries: 0 };
    s.wallet.keysOpen = true;
  });
  await flush();
  const btn = document.querySelector<HTMLButtonElement>("[data-act=reveal]");
  expect(btn).toBeTruthy();
  btn!.focus();
  btn!.click();
  await flush();
  expect(document.querySelector(".wallet-secret")?.textContent).toMatch(/SAAA/);
});

test("batch-cap rejection unchecks the box even when html is unchanged", async () => {
  // A5 audit MUST-FIX: state-only rejection is skipped by the cache because
  // the regenerated html is byte-identical; the handler must revert the DOM
  // property itself.
  const store = createStore<AppState>(emptyApp());
  const root = mountOrders(store);
  const rows = Array.from({ length: 41 }, (_, i) => sampleOrder(BigInt(1000 + i)));
  store.update((s) => {
    s.book.snapshot = mockSnapshot();
    s.wallet.openOrders = rows;
    s.orders.selected = rows.slice(0, 40).map((r) => r.nonce.toString());
  });
  await flush();
  const boxes = [...root.querySelectorAll<HTMLInputElement>('input[data-act="sel"]')];
  const extra = boxes.find((b) => !b.checked);
  if (!extra) throw new Error("fixture needs an unselected row");
  extra.checked = true;
  extra.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
  expect(extra.checked).toBe(false);
});

function mockSheet(matches: boolean): void {
  window.matchMedia = ((q: string) =>
    ({
      matches: String(q).includes("960") ? matches : false,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }) as MediaQueryList) as typeof window.matchMedia;
}

test("narrow ladder tap opens the sheet and prefills", async () => {
  mockSheet(true);
  document.body.innerHTML = `<aside id="wallet"></aside>`;
  const store = createStore<AppState>(emptyApp());
  const w = mountWallet({
    store,
    el: document.getElementById("wallet")!,
    rpc: stubRpc({ n: 0 }),
    getMarket: () => 0,
    onRefresh: () => {},
  });
  await flush();
  store.update((s) => {
    s.wallet.booted = true;
    s.wallet.enabled = true;
    s.wallet.active = testId;
    s.wallet.identities = [testId];
    s.wallet.collapsed = true;
    s.wallet.account = { exists: true, balance: 10n ** 10n, spendable: 10n ** 10n, sequence: 1n, numSubEntries: 0 };
    s.book.snapshot = namedBook();
  });
  await flush();
  w.prefillFromLadder("ask", 101);
  await flush();
  expect(store.read().wallet.collapsed).toBe(false);
  expect(store.read().ticket.isBid).toBe(true);
  expect(store.read().ticket.tick).toBe(101);
  expect(store.read().ticket.sideLocked).toBe(true);
  expect(document.querySelector("[data-field=qty]")).toBeTruthy();
  expect(document.querySelector("details.id-fold")).toBeTruthy();
});

test("narrow tap with no identity opens the intro", async () => {
  mockSheet(true);
  document.body.innerHTML = `<aside id="wallet"></aside>`;
  const store = createStore<AppState>(emptyApp());
  const w = mountWallet({
    store,
    el: document.getElementById("wallet")!,
    rpc: stubRpc({ n: 0 }),
    getMarket: () => 0,
    onRefresh: () => {},
  });
  await flush();
  store.update((s) => {
    s.wallet.booted = true;
    s.wallet.enabled = true;
    s.wallet.active = null;
    s.wallet.collapsed = true;
  });
  await flush();
  let scrolled = false;
  const ident = document.querySelector<HTMLElement>("[data-sec=identity]")!;
  ident.scrollIntoView = () => {
    scrolled = true;
  };
  w.prefillFromLadder("ask", 101);
  await flush();
  expect(store.read().wallet.collapsed).toBe(false);
  expect(document.querySelector("[data-act=generate]")).toBeTruthy();
  expect(store.read().ticket.tick).toBe(1);
  expect(scrolled).toBe(true);
});

test("confirmed phase replaces the place CTA", async () => {
  const { root, store } = liveTicket({ n: 0 });
  await flush();
  store.update((s) => {
    s.ticket.phase = "confirmed";
    s.ticket.phaseDetail = "took 1 lots";
    s.ticket.lastHash = "abcd";
  });
  await flush();
  expect(root.querySelector("[data-act=place]")).toBeNull();
  expect(root.querySelector("[data-role=strip]")?.textContent).toMatch(/confirmed/);
  root.querySelector<HTMLElement>("[data-act=status-ack]")!.click();
  await flush();
  expect(root.querySelector("[data-act=place]")).toBeTruthy();
  root.remove();
});

test("replace form swaps the order row in place", async () => {
  const store = createStore<AppState>(emptyApp());
  const root = mountOrders(store);
  store.update((s) => {
    s.book.snapshot = mockSnapshot();
    s.wallet.openOrders = [sampleOrder(7n)];
  });
  await flush();
  root.querySelector<HTMLButtonElement>("[data-act=replace-ask]")!.click();
  await flush();
  const row = root.querySelector(".order-row");
  expect(row?.querySelector("[data-field=rprice]")).toBeTruthy();
  expect(row?.querySelector(".order-main")).toBeNull();
  expect(row?.classList.contains("order-form")).toBe(true);
  root.remove();
});

test("zero quote defaults the ticket to SELL", async () => {
  const store = createStore<AppState>(emptyApp());
  const root = document.createElement("div");
  document.body.appendChild(root);
  createTicket(ticketOpts(stubRpc({ n: 0 }), store)).attach(root);
  liveWallet(store);
  store.update((s) => {
    s.book.snapshot = namedBook();
    s.wallet.account = { exists: true, balance: 10n ** 10n, spendable: 10n ** 10n, sequence: 1n, numSubEntries: 0 };
    s.wallet.trustlines = [
      {
        asset: { type: "credit", code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
        exists: true,
        balance: 0n,
      },
    ];
  });
  await flush();
  expect(store.read().ticket.isBid).toBe(false);
  expect(root.querySelector("[data-act=place]")?.textContent).toMatch(/SELL/);
  root.remove();
});

function stubSheetAndStrip(sheet: Element, strip: Element, stripTop: number): void {
  stubRect(sheet, { top: 399, left: 0, width: 375, height: 413 });
  stubRect(strip, { top: stripTop, left: 8, width: 350, height: 48 });
}

test("price stepper moves one tick", async () => {
  const { root, store } = liveTicket({ n: 0 });
  await flush();
  const before = store.read().ticket.tick;
  root.querySelector<HTMLButtonElement>("[data-act=price-inc]")!.click();
  await flush();
  expect(store.read().ticket.tick).toBe(before + 1);
  root.querySelector<HTMLButtonElement>("[data-act=price-dec]")!.click();
  await flush();
  expect(store.read().ticket.tick).toBe(before);
  root.remove();
});

test("focused qty stepper updates the visible input", async () => {
  const { root, store } = liveTicket({ n: 0 });
  await flush();
  const qty = root.querySelector<HTMLInputElement>("[data-field=qty]")!;
  qty.focus();
  const before = qty.value;
  root.querySelector<HTMLButtonElement>("[data-act=qty-inc]")!.click();
  await flush();
  const again = root.querySelector<HTMLInputElement>("[data-field=qty]")!;
  expect(again.value).not.toBe(before);
  expect(store.read().ticket.lots).toBe(2n);
  again.focus();
  again.value = "7.5";
  store.update((s) => {
    const snap = s.book.snapshot!;
    s.book.snapshot = { ...snap, latestLedger: snap.latestLedger + 1 };
  });
  await flush();
  expect(root.querySelector<HTMLInputElement>("[data-field=qty]")!.value).toBe("7.5");
  root.remove();
});

test("orders phase clears so the next form has buttons", async () => {
  const store = createStore<AppState>(emptyApp());
  const root = mountOrders(store);
  store.update((s) => {
    s.book.snapshot = mockSnapshot();
    s.wallet.openOrders = [sampleOrder(7n), sampleOrder(8n)];
    s.orders.phase = "confirmed";
    s.orders.lastHash = "deadbeef";
  });
  await flush();
  expect(root.querySelector("[data-role=ostrip]")?.textContent).toMatch(/confirmed/);
  const list = root.querySelector(".orders-list")!;
  const strip = root.querySelector("[data-role=ostrip]")!;
  expect(strip.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  root.querySelector<HTMLButtonElement>("[data-act=settle-ask]")!.click();
  await flush();
  expect(root.querySelector("[data-act=settle-go]")).toBeTruthy();
  expect(root.querySelector("[data-act=settle-cancel]")).toBeTruthy();
  expect(store.read().orders.phase).toBe("");
  root.remove();
});

test("empty orders list keeps the confirmation strip", async () => {
  const store = createStore<AppState>(emptyApp());
  const root = mountOrders(store);
  store.update((s) => {
    s.book.snapshot = mockSnapshot();
    s.wallet.openOrders = [];
    s.orders.phase = "confirmed";
    s.orders.lastHash = "cafebabe";
  });
  await flush();
  expect(root.textContent ?? "").toMatch(/no open orders/);
  expect(root.querySelector("[data-role=ostrip]")?.textContent).toMatch(/confirmed/);
  root.remove();
});

test("ticket confirmation sits in the sheet viewport", async () => {
  const { root, store } = liveTicket({ n: 0 });
  const sheet = document.createElement("div");
  sheet.className = "wallet-body";
  sheet.append(root);
  document.body.appendChild(sheet);
  store.update((s) => {
    s.ticket.phase = "confirmed";
    s.ticket.phaseDetail = "took 1 lots";
    s.ticket.lastHash = "abcd";
  });
  await flush();
  const strip = root.querySelector("[data-role=strip]")!;
  expect(strip.classList.contains("ticket-cta")).toBe(true);
  stubSheetAndStrip(sheet, strip, 714);
  assertInSheetViewport(strip, sheet);
  stubSheetAndStrip(sheet, strip, 950);
  expect(() => assertInSheetViewport(strip, sheet)).toThrow(/below the fold/);
  sheet.remove();
});

test("orders confirmation sits in the sheet viewport", async () => {
  const store = createStore<AppState>(emptyApp());
  const root = mountOrders(store);
  const sheet = document.createElement("div");
  sheet.className = "wallet-body";
  sheet.append(root);
  document.body.appendChild(sheet);
  store.update((s) => {
    s.book.snapshot = mockSnapshot();
    s.wallet.openOrders = [sampleOrder(7n)];
    s.orders.phase = "confirmed";
    s.orders.lastHash = "abcd";
  });
  await flush();
  const strip = root.querySelector("[data-role=ostrip]")!;
  const list = root.querySelector(".orders-list")!;
  expect(strip.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  stubSheetAndStrip(sheet, strip, 420);
  assertInSheetViewport(strip, sheet);
  stubSheetAndStrip(sheet, strip, 950);
  expect(() => assertInSheetViewport(strip, sheet)).toThrow(/below the fold/);
  sheet.remove();
});
