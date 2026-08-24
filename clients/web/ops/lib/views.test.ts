import { expect, test } from "vitest";
import { parseLevel, parseOrder } from "./views";

test("parseLevel throws on a null or absent native", () => {
  expect(() => parseLevel(null)).toThrow(/empty Level view/);
  expect(() => parseLevel(undefined)).toThrow(/empty Level view/);
  expect(parseLevel({ generation: 1, open_lots: 4 }).open_lots).toBe(4);
});

test("parseOrder throws on a null native rather than fabricating zeros", () => {
  expect(() => parseOrder(null)).toThrow(/empty Order view/);
  expect(() => parseOrder(undefined)).toThrow(/empty Order view/);
  expect(parseOrder({ tick: 10, filled_lots: 3 }).filled_lots).toBe(3);
});
