import { expect, test } from "vitest";
import { createStore } from "./store";
import src from "./main.ts?raw";

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

test("main.ts has no direct element writes", () => {
  expect(src).not.toMatch(/\.innerHTML\s*=/);
  expect(src).not.toMatch(/\.textContent\s*=/);
  expect(src).not.toMatch(/\.className\s*=/);
});
