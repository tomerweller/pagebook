/**
 * @vitest-environment jsdom
 */
import { expect, test } from "vitest";
import { mockSnapshot, type Rpc } from "../book";
import type { QuoteOpts } from "../engine/quote";
import type { PlaceFlags } from "../engine/submit";
import { createStore } from "../store";
import type { UrlOverrides } from "../view/format";
import { emptyBookDomain, type AppState } from "../view/market";
import { emptyOrdersDomain } from "./orders";
import { emptyWalletDomain } from "./pane";
import {
  createTicket,
  emptyTicketDomain,
  type TicketEngine,
  type TradeIntent,
} from "./ticket";

const emptyOv: UrlOverrides = { baseSym: null, quoteSym: null, baseDec: null, quoteDec: null };

const testId = {
  name: "t",
  publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  secret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHW4",
};

const otherId = {
  name: "u",
  publicKey: "GBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHKY",
  secret: "SBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADYK",
};

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

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function namedBook() {
  const b = mockSnapshot();
  return {
    ...b,
    tokens: {
      base: { symbol: "XLM", decimals: 7, name: "native" },
      quote: { symbol: "USDC", decimals: 7, name: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    },
  };
}

function quoteResult(opts: QuoteOpts, filledLots: bigint) {
  return {
    quoted: {
      market: opts.market,
      ownSide: opts.isBid,
      limitTick: opts.limitTick,
      startTick: opts.limitTick,
      crossed: [],
      taker: "00",
      nonce: opts.nonce,
      base: "00",
      quote: "00",
    },
    sim: { raw: {} },
    filledLots,
    quoteAtoms: filledLots * 10n,
  };
}

function liveStore(): ReturnType<typeof createStore<AppState>> {
  const store = createStore<AppState>(emptyApp());
  const book = namedBook();
  store.update((s) => {
    s.wallet.enabled = true;
    s.wallet.active = testId;
    s.wallet.account = { exists: true, balance: 10n ** 10n, spendable: 10n ** 10n, sequence: 1n, numSubEntries: 0 };
    s.wallet.trustlines = [
      {
        asset: { type: "credit", code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
        exists: true,
        balance: 10n ** 12n,
      },
    ];
    s.book.snapshot = book;
    s.book.market = 0;
    s.ticket.tick = 50;
    s.ticket.lots = 4n;
    s.ticket.priceStr = "50";
    s.ticket.qtyStr = "4";
    s.ticket.sideLocked = true;
  });
  return store;
}

function makeTicket(
  store: ReturnType<typeof createStore<AppState>>,
  engine: TicketEngine,
  extra?: { onRested?: (nonce: bigint, intent: TradeIntent) => void; onLog?: (text: string, hash?: string) => void },
) {
  return createTicket({
    store,
    rpc: {} as Rpc,
    contract: store.read().book.contract,
    getSecret: () => testId.secret,
    getPublic: () => store.read().wallet.active?.publicKey ?? null,
    getMarket: () => store.read().book.market ?? 0,
    onRefresh: () => {},
    onRested: extra?.onRested ?? (() => {}),
    onLog: extra?.onLog ?? (() => {}),
    engine,
  });
}

test("preview out of order keeps the later quote", async () => {
  const store = liveStore();
  const sims: { opts: QuoteOpts; d: ReturnType<typeof deferred<ReturnType<typeof quoteResult>>> }[] = [];
  const t = makeTicket(store, {
    simulatePlace: async (_rpc, opts) => {
      const d = deferred<ReturnType<typeof quoteResult>>();
      sims.push({ opts, d });
      return d.promise;
    },
    allocNonce: async () => 1n,
    submitPlace: async () => ({ kind: "ok", hash: "h" }),
  });

  store.update((s) => {
    s.ticket.lots = 2n;
  });
  const first = t.preview();
  store.update((s) => {
    s.ticket.lots = 3n;
  });
  const second = t.preview();
  expect(sims.length).toBe(2);

  sims[1].d.resolve(quoteResult(sims[1].opts, 3n));
  await second;
  const secondPreview = store.read().ticket.preview;
  expect(secondPreview.kind).toBe("ok");
  if (secondPreview.kind === "ok") expect(secondPreview.filledLots).toBe(3n);

  sims[0].d.resolve(quoteResult(sims[0].opts, 2n));
  await first;
  const firstPreview = store.read().ticket.preview;
  expect(firstPreview.kind).toBe("ok");
  if (firstPreview.kind === "ok") expect(firstPreview.filledLots).toBe(3n);
});

test("valid-to-invalid edit during a quote leaves preview idle", async () => {
  const store = liveStore();
  const sim = deferred<ReturnType<typeof quoteResult>>();
  const t = makeTicket(store, {
    simulatePlace: async (_rpc, opts) => sim.promise.then(() => quoteResult(opts, 1n)),
    allocNonce: async () => 1n,
    submitPlace: async () => ({ kind: "ok", hash: "h" }),
  });

  const inflight = t.preview();
  store.update((s) => {
    s.ticket.qtyStr = "0";
    s.ticket.lots = 0n;
  });
  await t.preview();
  sim.resolve(quoteResult({ market: 0, isBid: true, limitTick: 50, qty: 4n, contract: "", source: "", sequence: "", taker: "", nonce: 1n, base: "", quote: "" }, 1n));
  await inflight;
  expect(store.read().ticket.preview.kind).toBe("idle");
});

test("market switch during a quote drops the result", async () => {
  const store = liveStore();
  const sim = deferred<ReturnType<typeof quoteResult>>();
  const t = makeTicket(store, {
    simulatePlace: async (_rpc, opts) => sim.promise.then(() => quoteResult(opts, 1n)),
    allocNonce: async () => 1n,
    submitPlace: async () => ({ kind: "ok", hash: "h" }),
  });

  const inflight = t.preview();
  store.update((s) => {
    s.book.market = 1;
  });
  sim.resolve(quoteResult({ market: 0, isBid: true, limitTick: 50, qty: 4n, contract: "", source: "", sequence: "", taker: "", nonce: 1n, base: "", quote: "" }, 1n));
  await inflight;
  expect(store.read().ticket.preview.kind).toBe("loading");
});

test("account switch during a quote drops the result", async () => {
  const store = liveStore();
  const sim = deferred<ReturnType<typeof quoteResult>>();
  const t = makeTicket(store, {
    simulatePlace: async (_rpc, opts) => sim.promise.then(() => quoteResult(opts, 1n)),
    allocNonce: async () => 1n,
    submitPlace: async () => ({ kind: "ok", hash: "h" }),
  });

  const inflight = t.preview();
  store.update((s) => {
    s.wallet.active = otherId;
  });
  sim.resolve(quoteResult({ market: 0, isBid: true, limitTick: 50, qty: 4n, contract: "", source: "", sequence: "", taker: "", nonce: 1n, base: "", quote: "" }, 1n));
  await inflight;
  expect(store.read().ticket.preview.kind).toBe("loading");
});

test("submit threads one intent through nonce, quote, and place", async () => {
  const store = liveStore();
  store.update((s) => {
    s.book.market = 7;
    s.ticket.tick = 50;
    s.ticket.lots = 4n;
    s.ticket.isBid = true;
    s.ticket.flags = { post_only: false, fill_or_kill: false, no_rest: false };
  });

  type Seen = { market: number; tick?: number; lots?: bigint; flags?: PlaceFlags };
  const seen: { alloc: Seen[]; sim: Seen[]; place: Seen[] } = { alloc: [], sim: [], place: [] };
  const nonceD = deferred<bigint>();
  const simD = deferred<ReturnType<typeof quoteResult>>();
  const placeD = deferred<{ kind: "ok"; hash: string }>();
  let rested: { nonce: bigint; intent: TradeIntent } | null = null;
  const logs: string[] = [];

  const t = makeTicket(
    store,
    {
      allocNonce: async (_rpc, _c, market) => {
        seen.alloc.push({ market });
        return nonceD.promise;
      },
      simulatePlace: async (_rpc, opts) => {
        seen.sim.push({ market: opts.market, tick: opts.limitTick, lots: opts.qty });
        return simD.promise.then(() => quoteResult(opts, 0n));
      },
      submitPlace: async (_rpc, opts) => {
        seen.place.push({ market: opts.market, tick: opts.limitTick, lots: opts.qtyLots, flags: opts.flags });
        return placeD.promise;
      },
    },
    {
      onRested: (nonce, intent) => {
        rested = { nonce, intent };
      },
      onLog: (text) => {
        logs.push(text);
      },
    },
  );

  const done = t.submit();
  expect(seen.alloc.length).toBe(1);
  store.update((s) => {
    s.ticket.tick = 90;
    s.ticket.lots = 9n;
    s.book.market = 8;
  });
  nonceD.resolve(42n);
  for (let i = 0; i < 20 && seen.sim.length === 0; i++) await Promise.resolve();
  expect(seen.sim.length).toBe(1);
  store.update((s) => {
    s.ticket.tick = 91;
    s.ticket.lots = 10n;
    s.book.market = 9;
  });
  simD.resolve(quoteResult({ market: 7, isBid: true, limitTick: 50, qty: 4n, contract: "", source: "", sequence: "", taker: "", nonce: 42n, base: "", quote: "" }, 0n));
  for (let i = 0; i < 20 && seen.place.length === 0; i++) await Promise.resolve();
  expect(seen.place.length).toBe(1);
  store.update((s) => {
    s.ticket.tick = 92;
    s.ticket.lots = 11n;
    s.book.market = 10;
  });
  placeD.resolve({ kind: "ok", hash: "abc" });
  await done;

  expect(seen.alloc).toEqual([{ market: 7 }]);
  expect(seen.sim).toEqual([{ market: 7, tick: 50, lots: 4n }]);
  expect(seen.place).toEqual([
    { market: 7, tick: 50, lots: 4n, flags: { post_only: false, fill_or_kill: false, no_rest: false } },
  ]);
  expect(rested).toBeTruthy();
  expect(rested!.intent.market).toBe(7);
  expect(rested!.nonce).toBe(42n);
  expect(logs.some((l) => l === "place bid 50")).toBe(true);
  expect(store.read().ticket.phase).toBe("confirmed");
  expect(store.read().book.market).toBe(10);
});
