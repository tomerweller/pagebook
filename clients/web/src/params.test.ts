import { expect, test } from "vitest";
import { decimalsParam, depthParam, intParam, marketParam } from "./params";

test("intParam takes plain integers in range and nothing else", () => {
  expect(intParam("7", { min: 0, max: 10 })).toBe(7);
  expect(intParam(" 7 ", { min: 0, max: 10 })).toBe(7);
  expect(intParam("-1", { min: -2, max: 10 })).toBe(-1);
  expect(intParam("abc", { min: 0, max: 10 })).toBeNull();
  expect(intParam("", { min: 0, max: 10 })).toBeNull();
  expect(intParam("1.5", { min: 0, max: 10 })).toBeNull();
  expect(intParam("1e3", { min: 0, max: 10_000 })).toBeNull();
  expect(intParam("0x10", { min: 0, max: 100 })).toBeNull();
  expect(intParam("11", { min: 0, max: 10 })).toBeNull();
  expect(intParam("-1", { min: 0, max: 10 })).toBeNull();
  expect(intParam(null, { min: 0, max: 10 })).toBeNull();
  expect(intParam("9007199254740993", { min: 0, max: Number.MAX_SAFE_INTEGER })).toBeNull();
});

test("depth falls back to 12 rather than walking with NaN", () => {
  expect(depthParam(null)).toBe(12);
  expect(depthParam("abc")).toBe(12);
  expect(depthParam("")).toBe(12);
  expect(depthParam("0")).toBe(12);
  expect(depthParam("-4")).toBe(12);
  expect(depthParam("999")).toBe(12);
  expect(depthParam("24")).toBe(24);
});

test("a bad market id reads as absent, so the default market is picked", () => {
  expect(marketParam("abc")).toBeNull();
  expect(marketParam("-1")).toBeNull();
  expect(marketParam("1.2")).toBeNull();
  expect(marketParam("0")).toBe(0);
  expect(marketParam("3")).toBe(3);
});

test("decimals stay inside a token's plausible range", () => {
  expect(decimalsParam("7")).toBe(7);
  expect(decimalsParam("0")).toBe(0);
  expect(decimalsParam("19")).toBeNull();
  expect(decimalsParam("-2")).toBeNull();
  expect(decimalsParam("two")).toBeNull();
});
