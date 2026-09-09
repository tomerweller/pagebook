import { expect, test } from "vitest";
import { createRequestGate } from "../request";
import { createStore } from "../store";
import { emptyBookDomain, type AppState } from "../view/market";
import type { UrlOverrides } from "../view/format";
import { emptyOrdersDomain } from "./orders";
import type { OpenOrder } from "./orders";
import { emptyWalletDomain } from "./pane";
import { emptyTicketDomain } from "./ticket";
import { refreshBalances, refreshOrders, type OrderInput } from "./refresh";
import type { AccountState } from "./account";

const emptyOv: UrlOverrides = { baseSym: null, quoteSym: null, baseDec: null, quoteDec: null };

const idA = {
  name: "a",
  publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  secret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHW4",
};
const idB = {
  name: "b",
  publicKey: "GBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHKY",
  secret: "SBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADYK",
};

function emptyApp(): AppState {
  return {
    book: emptyBookDomain({ contract: "C", overrides: emptyOv, isTestnet: true, market: 0 }),
    wallet: emptyWalletDomain(null),
    orders: emptyOrdersDomain(),
    ticket: emptyTicketDomain(),
    versions: { book: 0, wallet: 0, orders: 0, ticket: 0 },
  };
}

function funded(): AccountState {
  return { exists: true, balance: 10n ** 10n, spendable: 10n ** 10n, sequence: 1n, numSubEntries: 0 };
}

function row(tick: number): OpenOrder {
  return {
    nonce: BigInt(tick),
    isBid: true,
    tick,
    qtyLots: 1n,
    filledLots: 0n,
    refundLots: 0n,
    generation: 1,
    seq: 0,
    archived: false,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function liveWallet(store: ReturnType<typeof createStore<AppState>>, id = idA, market = 0): void {
  store.update((s) => {
    s.wallet.enabled = true;
    s.wallet.active = id;
    s.wallet.account = funded();
    s.book.market = market;
  });
}

test("out-of-order order loads keep the later account", async () => {
  const store = createStore<AppState>(emptyApp());
  liveWallet(store, idA, 0);
  const gate = createRequestGate<OrderInput>();
  const loads: ReturnType<typeof deferred<OpenOrder[]>>[] = [];
  const deps = {
    loadOpenOrders: async () => {
      const d = deferred<OpenOrder[]>();
      loads.push(d);
      return d.promise;
    },
  };

  const first = refreshOrders(store, gate, deps);
  store.update((s) => {
    s.wallet.active = idB;
  });
  const afterSwitch = store.read().versions.wallet;
  const second = refreshOrders(store, gate, deps);
  expect(loads.length).toBe(2);

  loads[1].resolve([row(22)]);
  await second;
  expect(store.read().versions.wallet).toBe(afterSwitch + 1);
  loads[0].resolve([row(11)]);
  await first;
  expect(store.read().versions.wallet).toBe(afterSwitch + 1);
  expect(store.read().wallet.openOrders.map((o) => o.tick)).toEqual([22]);
  expect([...store.read().book.ownTicks.bid]).toEqual([22]);
});

test("market A to B to A keeps the third request's rows", async () => {
  const store = createStore<AppState>(emptyApp());
  liveWallet(store, idA, 0);
  const gate = createRequestGate<OrderInput>();
  const loads: ReturnType<typeof deferred<OpenOrder[]>>[] = [];
  const deps = {
    loadOpenOrders: async () => {
      const d = deferred<OpenOrder[]>();
      loads.push(d);
      return d.promise;
    },
  };

  const firstA = refreshOrders(store, gate, deps);
  store.update((s) => {
    s.book.market = 1;
  });
  const forB = refreshOrders(store, gate, deps);
  store.update((s) => {
    s.book.market = 0;
  });
  const before = store.read().versions.wallet;
  const secondA = refreshOrders(store, gate, deps);
  expect(loads.length).toBe(3);

  loads[1].resolve([row(2)]);
  await forB;
  expect(store.read().versions.wallet).toBe(before);
  loads[2].resolve([row(3)]);
  await secondA;
  expect(store.read().versions.wallet).toBe(before + 1);
  loads[0].resolve([row(1)]);
  await firstA;
  expect(store.read().versions.wallet).toBe(before + 1);
  expect(store.read().wallet.openOrders.map((o) => o.tick)).toEqual([3]);
});

test("removed identity drops an in-flight balance load", async () => {
  const store = createStore<AppState>(emptyApp());
  liveWallet(store, idA, 0);
  const gate = createRequestGate<string>();
  const accLoad = deferred<AccountState>();

  const inflight = refreshBalances(store, gate, {
    readAccount: async () => accLoad.promise,
    readTrustlines: async () => [],
    credits: () => [],
  });
  store.update((s) => {
    s.wallet.active = null;
  });
  const afterRemove = store.read().versions.wallet;
  const early = await refreshBalances(store, gate, {
    readAccount: async () => funded(),
    readTrustlines: async () => [],
    credits: () => [],
  });
  expect(early).toBe(false);
  expect(store.read().versions.wallet).toBe(afterRemove + 1);
  accLoad.resolve(funded());
  expect(await inflight).toBe(false);
  expect(store.read().versions.wallet).toBe(afterRemove + 1);
  expect(store.read().wallet.account).toBeNull();
});
