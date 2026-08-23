import { expect, test, vi } from "vitest";
import { createStore } from "./store";
import src from "./main.ts?raw";
import marketSrc from "./view/market.ts?raw";
import paneSrc from "./wallet/pane.ts?raw";
import ordersSrc from "./wallet/orders.ts?raw";

test("N updates in one microtask coalesce to one renderAll", async () => {
  const store = createStore({ n: 0 });
  let passes = 0;
  store.register("count", () => {
    passes += 1;
  });
  store.update((s) => {
    s.n += 1;
  });
  store.update((s) => {
    s.n += 1;
  });
  store.update((s) => {
    s.n += 1;
  });
  expect(passes).toBe(0);
  expect(store.read().n).toBe(3);
  await Promise.resolve();
  expect(passes).toBe(1);
});

test("loop guard stops unbounded self-updates", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const store = createStore({ n: 0 });
  let passes = 0;
  store.register("loop", () => {
    passes += 1;
    store.update((s) => {
      s.n += 1;
    });
  });
  store.update(() => {});
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(passes).toBe(10);
  expect(err).toHaveBeenCalled();
  err.mockRestore();
});

test("throwing view does not starve later views", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const store = createStore({ n: 0 });
  const seen: string[] = [];
  store.register("bad", () => {
    seen.push("bad");
    throw new Error("boom");
  });
  store.register("good", () => {
    seen.push("good");
  });
  store.update(() => {});
  await Promise.resolve();
  expect(seen).toEqual(["bad", "good"]);
  err.mockRestore();
});

test("keyFn skips unchanged views", async () => {
  const store = createStore({ k: 1 });
  let n = 0;
  store.register(
    "keyed",
    () => {
      n += 1;
    },
    () => store.read().k,
  );
  store.update(() => {});
  await Promise.resolve();
  expect(n).toBe(1);
  store.update(() => {});
  await Promise.resolve();
  expect(n).toBe(1);
  store.update((s) => {
    s.k = 2;
  });
  await Promise.resolve();
  expect(n).toBe(2);
});

test("main.ts has no direct element writes", () => {
  expect(src).not.toMatch(/\.innerHTML\s*=/);
  expect(src).not.toMatch(/\.textContent\s*=/);
  expect(src).not.toMatch(/\.className\s*=/);
  expect(src).not.toMatch(/\.setAttribute\s*\(/);
  expect(src).not.toMatch(/\.classList\./);
  expect(src).not.toMatch(/insertAdjacentHTML/);
});

test("mutating a domain re-renders only its keyed view", async () => {
  const store = createStore({
    book: { n: 0 },
    wallet: { n: 0 },
    versions: { book: 0, wallet: 0 },
  });
  let bookRuns = 0;
  let walletRuns = 0;
  store.register("book", () => {
    bookRuns += 1;
  }, () => store.read().versions.book);
  store.register("wallet", () => {
    walletRuns += 1;
  }, () => store.read().versions.wallet);
  store.update((s) => {
    s.book.n = 1;
  });
  await Promise.resolve();
  expect(bookRuns).toBe(1);
  expect(walletRuns).toBe(1);
  store.update((s) => {
    s.book.n = 2;
  });
  await Promise.resolve();
  expect(bookRuns).toBe(2);
  expect(walletRuns).toBe(1);
  expect(store.read().versions.book).toBe(2);
  expect(store.read().versions.wallet).toBe(0);
});

test("throwing keyed view retries on the same key", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const store = createStore({ book: { n: 0 }, versions: { book: 0 } });
  let throws = true;
  let n = 0;
  store.register(
    "k",
    () => {
      if (throws) throw new Error("boom");
      n += 1;
    },
    () => store.read().versions.book,
  );
  store.update((s) => {
    s.book.n = 1;
  });
  await Promise.resolve();
  expect(n).toBe(0);
  throws = false;
  store.update(() => {});
  await Promise.resolve();
  expect(n).toBe(1);
  err.mockRestore();
});

test("hand-enumerated market/wallet/orders keys are gone", () => {
  expect(marketSrc).not.toMatch(/function marketKey/);
  expect(paneSrc).not.toMatch(/function walletKey/);
  expect(ordersSrc).not.toMatch(/function structKey/);
  expect(ordersSrc).not.toMatch(/function liveKey/);
});
