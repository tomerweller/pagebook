import * as StellarSdk from "@stellar/stellar-sdk";
import { expect, test } from "vitest";
import {
  parseLevel,
  decodeBitmap,
  formatInt,
  formatAtoms,
  ticksToPrice,
  BITMAP_BYTES,
} from "./decode";

const xdr = StellarSdk.xdr;

/// A `Level` ScVal as the contract stores it: a symbol-keyed map with u32 /
/// u64 fields and a vec of u64 slots holding the whole queue (ADR-037).
function levelScVal(fields: {
  generation: number;
  head_seq: number;
  open_lots: bigint;
  slots: bigint[];
}): StellarSdk.xdr.ScVal {
  const u64 = (v: bigint) => xdr.ScVal.scvU64(xdr.Uint64.fromString(v.toString()));
  const entry = (k: string, v: StellarSdk.xdr.ScVal) =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });
  return xdr.ScVal.scvMap([
    entry("generation", xdr.ScVal.scvU32(fields.generation)),
    entry("head_seq", xdr.ScVal.scvU32(fields.head_seq)),
    entry("open_lots", u64(fields.open_lots)),
    entry("slots", xdr.ScVal.scvVec(fields.slots.map(u64))),
  ]);
}

test("empty level", () => {
  const scv = levelScVal({
    generation: 0,
    head_seq: 0,
    open_lots: 0n,
    slots: [],
  });
  const lvl = parseLevel(StellarSdk.scValToNative(scv));
  expect(lvl).toBeTruthy();
  expect(lvl!.generation).toBe(0);
  expect(lvl!.head_seq).toBe(0);
  expect(lvl!.open_lots).toBe(0n);
  expect(lvl!.slots.length).toBe(0);
});

test("occupied level: the vector is the queue, its length the tail", () => {
  const scv = levelScVal({
    generation: 3,
    head_seq: 5,
    open_lots: 123456789012n,
    slots: [10n, 20n, 30n, 40n, 0n, 1n, 2n, 3n, 1n << 40n],
  });
  const lvl = parseLevel(StellarSdk.scValToNative(scv));
  expect(lvl).toBeTruthy();
  expect(lvl!.generation).toBe(3);
  expect(lvl!.head_seq).toBe(5);
  expect(lvl!.open_lots).toBe(123456789012n);
  expect(lvl!.slots.length).toBe(9);
  // Slots from head_seq to the tail are the live orders' open lots; a zero is
  // a tombstone or a consumed head and is skipped.
  expect(lvl!.slots.slice(lvl!.head_seq)).toEqual([1n, 2n, 3n, 1n << 40n]);
  expect(lvl!.slots[0]).toBe(10n);
  expect(lvl!.slots[3]).toBe(40n);
  expect(lvl!.slots[4]).toBe(0n);
  expect(lvl!.slots[8]).toBe(1n << 40n);
});

test("parseLevel rejects foreign shapes", () => {
  expect(parseLevel(null)).toBeNull();
  expect(parseLevel(new Uint8Array(285))).toBeNull();
  expect(parseLevel({ generation: 1 })).toBeNull();
  expect(parseLevel({ generation: "x", slots: [] })).toBeNull();
});

test("bitmap bits", () => {
  const bytes = new Uint8Array(BITMAP_BYTES);
  bytes[0] = 0b1000_0001;
  bytes[1] = 0b0000_0001;
  bytes[255] = 0b1000_0000;
  const bm = decodeBitmap(bytes);
  expect(bm).toBeTruthy();
  expect(bm!.bit(0)).toBe(true);
  expect(bm!.bit(7)).toBe(true);
  expect(bm!.bit(8)).toBe(true);
  expect(bm!.bit(2047)).toBe(true);
  expect(bm!.bit(1)).toBe(false);
  expect([...bm!.setBits()]).toEqual([0, 7, 8, 2047]);
  expect([...bm!.setBits(true)]).toEqual([2047, 8, 7, 0]);
  // The stored form is BytesN<256>: any other length is not a bitmap.
  expect(decodeBitmap(new Uint8Array(257))).toBeNull();
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
  // XLM/USDC quantization: tick 1000, lot 1e8, 7/7 decimals -> 5 decimals
  expect(ticksToPrice(19800, 1000n, 100000000n, 7, 7)).toBe("0.19800");
  expect(ticksToPrice(20000, 1000n, 100000000n, 7, 7)).toBe("0.20000");
  expect(ticksToPrice(19839, 1000n, 100000000n, 7, 7)).toBe("0.19839");
  // unit quantization: tick 1, lot 1, 7/7 -> step 1, no padding
  expect(ticksToPrice(100, 1n, 1n, 7, 7)).toBe("100");
});
