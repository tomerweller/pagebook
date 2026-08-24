import { expect, test } from "vitest";
import {
  lotsToQty,
  minLotLabel,
  parseDecimal,
  priceToTick,
  qtyToLots,
  stepLots,
  stepTick,
  tickToPrice,
  type Quant,
} from "./units";

const m1: Quant = {
  lotSize: 100_000_000n,
  tickSize: 1_000n,
  baseDec: 7,
  quoteDec: 7,
  tickMin: 1,
  tickMax: 4_194_304,
  minLots: 1n,
};

const m0: Quant = {
  lotSize: 1n,
  tickSize: 1n,
  baseDec: 7,
  quoteDec: 7,
  tickMin: 1,
  tickMax: 4_194_304,
  minLots: 1n,
};

test("parseDecimal is exact (no float artifacts)", () => {
  expect(parseDecimal("0.20079")).toEqual({ num: 20079n, den: 100000n });
  expect(parseDecimal("30")).toEqual({ num: 30n, den: 1n });
  expect(parseDecimal("0.0000005")).toEqual({ num: 5n, den: 10_000_000n });
  expect(parseDecimal("")).toBeNull();
  expect(parseDecimal("x")).toBeNull();
});

test("market 1: 0.20079 → tick 20079, 30 → 3 lots", () => {
  const p = parseDecimal("0.20079")!;
  expect(priceToTick(p, m1, true)).toEqual({ tick: 20079, snapped: false });
  expect(qtyToLots(parseDecimal("30")!, m1)).toBe(3n);
});

test("market 0: 100 → tick 100, 0.0000005 → 5 lots", () => {
  expect(priceToTick(parseDecimal("100")!, m0, true)).toEqual({ tick: 100, snapped: false });
  expect(qtyToLots(parseDecimal("0.0000005")!, m0)).toBe(5n);
});

test("bid floors, ask ceils", () => {
  const between = parseDecimal("0.200795")!;
  expect(priceToTick(between, m1, true).tick).toBe(20079);
  expect(priceToTick(between, m1, false).tick).toBe(20080);
  expect(priceToTick(between, m1, true).snapped).toBe(true);
  expect(priceToTick(parseDecimal("0.20079")!, m1, false).snapped).toBe(false);
});

test("zero lots and out-of-band", () => {
  expect(qtyToLots(parseDecimal("5")!, m1)).toBe(0n);
  expect(minLotLabel(m1, "XLM")).toBe("min 1 lot = 10 XLM");
  expect(priceToTick(parseDecimal("0")!, m1, true).tick).toBe(0);
  const hi = priceToTick(parseDecimal("100")!, m1, true).tick;
  expect(hi).toBeGreaterThanOrEqual(m1.tickMax);
});

test("round-trip tick → price → tick for ladder ticks", () => {
  const ticks = [1, 2, 99, 100, 19000, 20079, 20080, 4194303];
  for (const q of [m1, m0]) {
    for (const t of ticks) {
      if (t >= q.tickMax) continue;
      const s = tickToPrice(t, q);
      const back = priceToTick(parseDecimal(s)!, q, true);
      expect(back.tick, `${t} ${s}`).toBe(t);
      expect(back.snapped).toBe(false);
    }
  }
});

test("lotsToQty formats market 1 lot size", () => {
  expect(lotsToQty(3n, m1)).toBe("30");
  expect(lotsToQty(5n, m0)).toBe("0.0000005");
});

test("stepTick stays inside the band", () => {
  expect(stepTick(1, -1, m1)).toBe(1);
  expect(stepTick(1, 1, m1)).toBe(2);
  expect(stepTick(m1.tickMax - 1, 1, m1)).toBe(m1.tickMax - 1);
  expect(stepTick(m1.tickMax, 1, m1)).toBe(m1.tickMax - 1);
  expect(stepTick(0, -1, m1)).toBe(1);
});

test("stepLots never drops below minLots", () => {
  expect(stepLots(1n, -1, m1)).toBe(1n);
  expect(stepLots(1n, 1, m1)).toBe(2n);
  expect(stepLots(0n, 1, m1)).toBe(1n);
  expect(stepLots(0n, -1, m1)).toBe(1n);
});
