/**
 * @vitest-environment jsdom
 */
import { expect, test } from "vitest";
import { mockSnapshot } from "../book";
import { createStore } from "../store";
import { midSpread } from "./format";
import { emptyBookDomain, registerMarketView, resetPaneCache, syncNarrowFolds, type AppState } from "./market";
import { emptyWalletDomain } from "../wallet/pane";
import { emptyOrdersDomain } from "../wallet/orders";
import { emptyTicketDomain } from "../wallet/ticket";

const emptyOv = { baseSym: null, quoteSym: null, baseDec: null, quoteDec: null };

function emptyApp(): AppState {
  return {
    book: emptyBookDomain({
      market: 0,
      overrides: emptyOv,
      contract: "C",
      isTestnet: true,
    }),
    wallet: emptyWalletDomain(null),
    orders: emptyOrdersDomain(),
    ticket: emptyTicketDomain(),
    versions: { book: 0, wallet: 0, orders: 0, ticket: 0 },
  };
}

function mount(): void {
  document.body.innerHTML = `
    <h1 class="pair-title" id="meta"><span id="pair">-- / --</span></h1>
    <div id="fresh"><span id="fresh-text"></span></div>
    <div id="kpis"></div>
    <div id="ladder"></div>
    <ol class="tape" id="trades"></ol>
    <p id="history-note"></p>
    <div>
      <h2>activity</h2>
      <div class="panel"><ol class="tape activity" id="activity"></ol></div>
    </div>
    <section>
      <h2>market</h2>
      <dl class="facts" id="facts"></dl>
    </section>
  `;
}

async function paint(): Promise<HTMLElement> {
  mount();
  resetPaneCache();
  const store = createStore<AppState>(emptyApp());
  registerMarketView(store, { onSwitchMarket: () => {} });
  const snap = mockSnapshot();
  store.update((s) => {
    s.book.snapshot = snap;
    s.book.eventState.events = snap.events;
    s.book.lastOkAt = Date.now();
  });
  await Promise.resolve();
  return document.getElementById("ladder")!;
}

test("center-out book puts best ask above the spread and best bid below", async () => {
  const ladder = await paint();
  const narrow = ladder.querySelector(".book-narrow")!;
  const spread = narrow.querySelector(".spread-row")!;
  const above = spread.previousElementSibling!.querySelectorAll(".row");
  const below = spread.nextElementSibling!.querySelectorAll(".row");
  expect(above[above.length - 1].getAttribute("data-tick")).toBe("101");
  expect(above[above.length - 1].getAttribute("data-side")).toBe("ask");
  expect(below[0].getAttribute("data-tick")).toBe("99");
  expect(below[0].getAttribute("data-side")).toBe("bid");
  expect(above[0].getAttribute("data-tick")).toBe("104");
});

test("narrow book uses PRICE · AMOUNT · DEPTH in both halves", async () => {
  const ladder = await paint();
  const cols = [...ladder.querySelector(".book-narrow .cols")!.querySelectorAll("span")].map((s) =>
    s.textContent?.replace(/\s+/g, " ").trim(),
  );
  expect(cols[0]?.toLowerCase().startsWith("price")).toBe(true);
  expect(cols[1]?.toLowerCase().startsWith("amount")).toBe(true);
  expect(cols[2]?.toLowerCase().startsWith("depth")).toBe(true);
  const askRow = ladder.querySelector(".book-narrow .asks .row")!;
  const bidRow = ladder.querySelector(".book-narrow .bids .row")!;
  expect(askRow.querySelector("span")?.classList.contains("price")).toBe(true);
  expect(bidRow.querySelector("span")?.classList.contains("price")).toBe(true);
});

test("spread row matches midSpread output", async () => {
  const snap = mockSnapshot();
  const ms = midSpread(snap.bestBid, snap.bestAsk, snap, emptyOv);
  await paint();
  const text = document.querySelector(".spread-row")!.textContent ?? "";
  expect(text).toContain(`spread ${ms.spread}`);
  expect(text).toContain(ms.pct!);
  expect(text).toContain(`mid ${ms.mid}`);
});

test("activity content is visible at wide with no details wrapper", async () => {
  await paint();
  expect(document.querySelector("#activity")?.closest("details")).toBeNull();
  expect(document.querySelector("#facts")?.closest("details")).toBeNull();
  expect(document.getElementById("activity")!.innerHTML.length).toBeGreaterThan(0);
  expect(document.getElementById("facts")!.innerHTML.length).toBeGreaterThan(0);
});

test("activity and market facts wrap in closed details only when narrow", async () => {
  await paint();
  syncNarrowFolds(true);
  const folds = [...document.querySelectorAll<HTMLDetailsElement>("details.fold")];
  expect(folds.length).toBe(2);
  expect(folds.every((d) => !d.hasAttribute("open") && !d.open)).toBe(true);
  expect(document.querySelector("#activity")?.closest("details.fold")).toBeTruthy();
  expect(document.querySelector("#facts")?.closest("details.fold")).toBeTruthy();
  syncNarrowFolds(false);
  expect(document.querySelector("#activity")?.closest("details")).toBeNull();
});

test("tape keeps hash in the detail tooltip and marks the hash column", async () => {
  await paint();
  const row = document.querySelector("#trades li:not(.empty)")!;
  const detail = row.querySelector(".detail")!;
  const tx = row.querySelector(".tx")!;
  expect(tx.querySelector("a")).toBeTruthy();
  expect(detail.getAttribute("title") ?? "").toMatch(/[a-f0-9]{8,}/i);
});

test("edge chip appears for an own ask beyond the window and leaves when in-window", async () => {
  mount();
  resetPaneCache();
  const store = createStore<AppState>(emptyApp());
  registerMarketView(store, { onSwitchMarket: () => {} });
  const snap = mockSnapshot();
  const far = {
    nonce: 9n,
    isBid: false,
    tick: 200,
    qtyLots: 1n,
    filledLots: 0n,
    refundLots: 0n,
    generation: 1,
    seq: 0,
    archived: false,
  };
  store.update((s) => {
    s.book.snapshot = snap;
    s.book.eventState.events = snap.events;
    s.book.lastOkAt = Date.now();
    s.wallet.openOrders = [far];
  });
  await Promise.resolve();
  const chip = document.querySelector(".own-chip.above");
  expect(chip?.textContent).toMatch(/1 ask above/);
  expect(chip?.getAttribute("data-own-chip")).toBe("9");
  store.update((s) => {
    s.wallet.openOrders = [{ ...far, tick: 102 }];
  });
  await Promise.resolve();
  expect(document.querySelector(".own-chip.above")).toBeNull();
});

test("tape own-marking uses session hashes not resting ticks", async () => {
  mount();
  resetPaneCache();
  const store = createStore<AppState>(emptyApp());
  registerMarketView(store, { onSwitchMarket: () => {} });
  const snap = mockSnapshot();
  const ownHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  store.update((s) => {
    s.book.snapshot = snap;
    s.book.eventState.events = snap.events;
    s.book.lastOkAt = Date.now();
    s.book.ownTicks = { bid: new Set([100]), ask: new Set() };
  });
  await Promise.resolve();
  expect(document.querySelector("#trades li.own")).toBeNull();
  store.update((s) => {
    s.wallet.ownHashes.add(ownHash);
  });
  await Promise.resolve();
  const mine = [...document.querySelectorAll("#trades li")].filter((li) => li.classList.contains("own"));
  expect(mine.length).toBeGreaterThan(0);
  expect(mine[0].querySelector(".tx a")?.getAttribute("href") ?? "").toContain(ownHash);
});
