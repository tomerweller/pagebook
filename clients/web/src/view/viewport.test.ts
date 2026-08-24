/**
 * @vitest-environment jsdom
 */
import { expect, test } from "vitest";
import { assertInSheetViewport, inSheetViewport, stubRect } from "./viewport";

test("below-the-fold strip fails the viewport helper", () => {
  const sheet = document.createElement("div");
  const strip = document.createElement("p");
  stubRect(sheet, { top: 399, left: 0, width: 375, height: 413 });
  stubRect(strip, { top: 950, left: 8, width: 350, height: 17 });
  expect(inSheetViewport(strip, sheet)).toBe(false);
  expect(() => assertInSheetViewport(strip, sheet)).toThrow(/below the fold/);
});

test("strip inside the sheet viewport passes", () => {
  const sheet = document.createElement("div");
  const strip = document.createElement("p");
  stubRect(sheet, { top: 399, left: 0, width: 375, height: 413 });
  stubRect(strip, { top: 714, left: 8, width: 350, height: 61 });
  expect(inSheetViewport(strip, sheet)).toBe(true);
  assertInSheetViewport(strip, sheet);
});
