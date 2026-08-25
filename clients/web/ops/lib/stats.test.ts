import { expect, test } from "vitest";
import { percentiles, round2 } from "./stats";

test("percentiles match Python stress._q interpolation", () => {
  expect(percentiles([])).toBeNull();
  expect(percentiles([4])).toEqual({ min: 4, p50: 4, p95: 4, max: 4 });
  expect(percentiles([1, 2])).toEqual({ min: 1, p50: 1.5, p95: 1.95, max: 2 });
  expect(percentiles([1, 2, 3])).toEqual({ min: 1, p50: 2, p95: 2.9, max: 3 });
  const v = [10, 20, 30, 40, 50];
  expect(percentiles(v)).toEqual({ min: 10, p50: 30, p95: 48, max: 50 });
  expect(round2(1.234)).toBe(1.23);
  expect(round2(1.235)).toBe(1.24);
});