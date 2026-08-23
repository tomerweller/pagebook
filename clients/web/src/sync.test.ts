import { expect, test } from "vitest";
import { mockSnapshot } from "./book";
import { createStore } from "./store";
import { refreshBookAndEvents } from "./sync";
import { emptyBookDomain, type AppState } from "./view/market";
import { emptyWalletDomain } from "./wallet/pane";
import { emptyOrdersDomain } from "./wallet/orders";
import type { UrlOverrides } from "./view/format";

const emptyOv: UrlOverrides = { baseSym: null, quoteSym: null, baseDec: null, quoteDec: null };

function emptyApp(): AppState {
  return {
    book: emptyBookDomain({ contract: "C", overrides: emptyOv, isTestnet: true, market: 0 }),
    wallet: emptyWalletDomain(null),
    orders: emptyOrdersDomain(),
    versions: { book: 0, wallet: 0, orders: 0 },
  };
}

test("book update lands even when events poll rejects", async () => {
  const store = createStore<AppState>(emptyApp());
  const snap = mockSnapshot();
  await refreshBookAndEvents(store, 0, {
    walk: async () => snap,
    poll: async () => {
      throw new Error("events down");
    },
    formatError: (e) => (e instanceof Error ? e.message : String(e)),
  });
  expect(store.read().book.snapshot).toBe(snap);
  expect(store.read().book.lastError).toBe("events down");
});

test("poll failure after market switch does not stamp lastError", async () => {
  const store = createStore<AppState>(emptyApp());
  let rejectPoll!: (e: Error) => void;
  const done = refreshBookAndEvents(store, 0, {
    walk: async () => mockSnapshot(),
    poll: () =>
      new Promise((_, rej) => {
        rejectPoll = rej;
      }),
    formatError: (e) => (e instanceof Error ? e.message : String(e)),
  });
  await Promise.resolve();
  store.update((s) => {
    s.book.market = 1;
    s.book.lastError = "";
  });
  rejectPoll(new Error("events down"));
  await done;
  expect(store.read().book.lastError).toBe("");
});
