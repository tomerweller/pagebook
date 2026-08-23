import { expect, test } from "vitest";
import {
  decodeLevel,
  decodeBitmap,
  hexToBytes,
  formatInt,
  formatAtoms,
  ticksToPrice,
  LEVEL_BYTES,
  BITMAP_BYTES,
} from "./decode";
import fixtures from "./fixtures.json";

test("empty level", () => {
  const lvl = decodeLevel(hexToBytes(fixtures.emptyLevel));
  expect(lvl).toBeTruthy();
  expect(hexToBytes(fixtures.emptyLevel).length).toBe(LEVEL_BYTES);
  expect(lvl!.generation).toBe(0);
  expect(lvl!.head_seq).toBe(0);
  expect(lvl!.tail_seq).toBe(0);
  expect(lvl!.head_consumed_lots).toBe(0n);
  expect(lvl!.open_lots).toBe(0n);
  expect(lvl!.slots.length).toBe(32);
  expect(lvl!.slots.every((s) => s === 0n)).toBe(true);
});

test("occupied level", () => {
  const lvl = decodeLevel(hexToBytes(fixtures.occupiedLevel));
  expect(lvl).toBeTruthy();
  expect(lvl!.generation).toBe(3);
  expect(lvl!.head_seq).toBe(5);
  expect(lvl!.tail_seq).toBe(9);
  expect(lvl!.head_consumed_lots).toBe(7n);
  expect(lvl!.open_lots).toBe(123456789012n);
  expect(lvl!.slots[0]).toBe(10n);
  expect(lvl!.slots[1]).toBe(20n);
  expect(lvl!.slots[2]).toBe(30n);
  expect(lvl!.slots[3]).toBe(40n);
  expect(lvl!.slots[4]).toBe(0n);
  expect(lvl!.slots[31]).toBe(1n << 40n);
});

test("bitmap bits", () => {
  const bytes = hexToBytes(fixtures.bitmap);
  expect(bytes.length).toBe(BITMAP_BYTES);
  const bm = decodeBitmap(bytes);
  expect(bm).toBeTruthy();
  expect(bm!.bit(0)).toBe(true);
  expect(bm!.bit(7)).toBe(true);
  expect(bm!.bit(8)).toBe(true);
  expect(bm!.bit(2047)).toBe(true);
  expect(bm!.bit(1)).toBe(false);
  expect([...bm!.setBits()]).toEqual([0, 7, 8, 2047]);
  expect([...bm!.setBits(true)]).toEqual([2047, 8, 7, 0]);
});

test("reject bad packed values", () => {
  expect(decodeLevel(new Uint8Array(285))).toBeNull();
  const badLevel = hexToBytes(fixtures.emptyLevel);
  badLevel[0] = 2;
  expect(decodeLevel(badLevel)).toBeNull();
  expect(decodeBitmap(new Uint8Array(10))).toBeNull();
});

test("format integers without floats", () => {
  expect(formatInt(0n)).toBe("0");
  expect(formatInt(123456789012n)).toBe("123,456,789,012");
  expect(formatInt(-1000n)).toBe("-1,000");
  expect(formatAtoms(12340000000n, 7)).toBe("1,234");
  expect(formatAtoms(15000000n, 7)).toBe("1.5");
  expect(formatAtoms(7n, 7)).toBe("0.0000007");
  expect(ticksToPrice(99, 1, 1, 7, 7)).toBe("99");
  expect(ticksToPrice(1, 1, 2, 0, 0)).toBe("0.5");
});

test("prices pad to the market's tick precision", () => {
  // market 1 quantization: tick 1000, lot 1e8, 7/7 decimals -> 5 decimals
  expect(ticksToPrice(19800, 1000n, 100000000n, 7, 7)).toBe("0.19800");
  expect(ticksToPrice(20000, 1000n, 100000000n, 7, 7)).toBe("0.20000");
  expect(ticksToPrice(19839, 1000n, 100000000n, 7, 7)).toBe("0.19839");
  // market 0 quantization: tick 1, lot 1, 7/7 -> step 1, no padding
  expect(ticksToPrice(100, 1n, 1n, 7, 7)).toBe("100");
});
