import { expect, test, vi } from "vitest";
import { createStore } from "./store";
import src from "./main.ts?raw";
import marketSrc from "./view/market.ts?raw";
import paneSrc from "./wallet/pane.ts?raw";
import ordersSrc from "./wallet/orders.ts?raw";
import ticketSrc from "./wallet/ticket.ts?raw";

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
  store.subscribe("loop", () => {
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

function assertNoDirectWrites(text: string): void {
  expect(text).not.toMatch(/\.innerHTML\s*=/);
  expect(text).not.toMatch(/\.textContent\s*=/);
  expect(text).not.toMatch(/\.className\s*=/);
  expect(text).not.toMatch(/\.setAttribute\s*\(/);
  expect(text).not.toMatch(/\.classList\./);
  expect(text).not.toMatch(/insertAdjacentHTML/);
}

test("main.ts has no direct element writes", () => {
  assertNoDirectWrites(src);
});

test("ticket.ts and orders.ts have no direct element writes", () => {
  assertNoDirectWrites(ticketSrc);
  assertNoDirectWrites(ordersSrc);
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

test("nested set and mutating methods bump domain versions", () => {
  const store = createStore({
    book: { eventState: { cursor: null as string | null } },
    wallet: { log: [] as string[] },
    orders: { selected: [] as string[] },
    versions: { book: 0, wallet: 0, orders: 0 },
  });
  store.update((s) => {
    s.wallet.log.unshift("a");
  });
  expect(store.read().versions.wallet).toBe(1);
  expect(store.read().wallet.log).toEqual(["a"]);
  store.update((s) => {
    s.orders.selected.push("n");
  });
  expect(store.read().versions.orders).toBe(1);
  expect(store.read().orders.selected).toEqual(["n"]);
  store.update((s) => {
    s.book.eventState.cursor = "c";
  });
  expect(store.read().versions.book).toBe(1);
  expect(store.read().book.eventState.cursor).toBe("c");
});

test("hand-enumerated market/wallet/orders keys are gone", () => {
  expect(marketSrc).not.toMatch(/function marketKey/);
  expect(paneSrc).not.toMatch(/function walletKey/);
  expect(ordersSrc).not.toMatch(/function structKey/);
  expect(ordersSrc).not.toMatch(/function liveKey/);
  expect(ticketSrc).not.toMatch(/\bdraw\b/);
  expect(ticketSrc).not.toMatch(/paintChrome/);
  expect(ticketSrc).not.toMatch(/drawnSyms/);
  expect(ticketSrc).not.toMatch(/setLive/);
});

test("update that throws still bumps versions and schedules a pass", async () => {
  const store = createStore({ book: { n: 0 }, versions: { book: 0 } });
  let passes = 0;
  store.register("count", () => {
    passes += 1;
  });
  expect(() => {
    store.update((s) => {
      s.book.n = 1;
      throw new Error("boom");
    });
  }).toThrow("boom");
  expect(store.read().book.n).toBe(1);
  expect(store.read().versions.book).toBe(1);
  expect(passes).toBe(0);
  await Promise.resolve();
  expect(passes).toBe(1);
});

test("update during a view throws and later views still run", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const store = createStore({ book: { n: 0 }, versions: { book: 0 } });
  const seen: string[] = [];
  store.register("bad", () => {
    seen.push("bad");
    store.update((s) => {
      s.book.n = 1;
    });
  });
  store.register("good", () => {
    seen.push("good");
  });
  store.update(() => {});
  await Promise.resolve();
  expect(seen).toEqual(["bad", "good"]);
  expect(err).toHaveBeenCalledTimes(1);
  expect(err.mock.calls[0][0]).toBe("[render] bad");
  expect(String(err.mock.calls[0][1])).toMatch(/\[store\] update during view bad/);
  expect(store.read().book.n).toBe(0);
  expect(store.read().versions.book).toBe(0);
  err.mockRestore();
});

test("subscribe runs before views and views see the mutation", async () => {
  const store = createStore({ book: { n: 0 }, versions: { book: 0 } });
  let seen = -1;
  store.subscribe("eff", () => {
    store.update((s) => {
      s.book.n = 7;
    });
  });
  store.register("view", () => {
    seen = store.read().book.n;
  });
  store.update(() => {});
  await Promise.resolve();
  expect(seen).toBe(7);
});

test("keyed effect skips when its key is unchanged", async () => {
  const store = createStore({ k: 1 });
  let n = 0;
  store.subscribe(
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

const srcFiles = import.meta.glob("./**/*.ts", { eager: true, query: "?raw", import: "default" }) as Record<
  string,
  string
>;

test("non-test sources do not mutate through read()", () => {
  const mut =
    /\.read\(\)(?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[[^\]]+\])*\s*(?:\+\+|--|\+=|-=|=(?![=>])|\.(?:push|pop|shift|unshift|splice|sort|reverse|add|delete|clear|set)\s*\()/;
  for (const [path, text] of Object.entries(srcFiles)) {
    if (/\.test\.ts$/.test(path)) continue;
    expect(text, path).not.toMatch(mut);
  }
});
