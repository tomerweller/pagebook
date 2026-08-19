import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeLevel,
  decodeBitmap,
  hexToBytes,
  formatInt,
  formatAtoms,
  ticksToPrice,
  LEVEL_BYTES,
  BITMAP_BYTES,
} from "./decode.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url)));

test("empty level", () => {
  const lvl = decodeLevel(hexToBytes(fixtures.emptyLevel));
  assert.ok(lvl);
  assert.equal(hexToBytes(fixtures.emptyLevel).length, LEVEL_BYTES);
  assert.equal(lvl.generation, 0);
  assert.equal(lvl.head_seq, 0);
  assert.equal(lvl.tail_seq, 0);
  assert.equal(lvl.head_consumed_lots, 0n);
  assert.equal(lvl.open_lots, 0n);
  assert.equal(lvl.slots.length, 32);
  assert.ok(lvl.slots.every((s) => s === 0n));
});

test("occupied level", () => {
  const lvl = decodeLevel(hexToBytes(fixtures.occupiedLevel));
  assert.ok(lvl);
  assert.equal(lvl.generation, 3);
  assert.equal(lvl.head_seq, 5);
  assert.equal(lvl.tail_seq, 9);
  assert.equal(lvl.head_consumed_lots, 7n);
  assert.equal(lvl.open_lots, 123456789012n);
  assert.equal(lvl.slots[0], 10n);
  assert.equal(lvl.slots[1], 20n);
  assert.equal(lvl.slots[2], 30n);
  assert.equal(lvl.slots[3], 40n);
  assert.equal(lvl.slots[4], 0n);
  assert.equal(lvl.slots[31], 1n << 40n);
});

test("bitmap bits", () => {
  const bytes = hexToBytes(fixtures.bitmap);
  assert.equal(bytes.length, BITMAP_BYTES);
  const bm = decodeBitmap(bytes);
  assert.ok(bm);
  assert.equal(bm.bit(0), true);
  assert.equal(bm.bit(7), true);
  assert.equal(bm.bit(8), true);
  assert.equal(bm.bit(2047), true);
  assert.equal(bm.bit(1), false);
  assert.deepEqual([...bm.setBits()], [0, 7, 8, 2047]);
  assert.deepEqual([...bm.setBits(true)], [2047, 8, 7, 0]);
});

test("reject bad packed values", () => {
  assert.equal(decodeLevel(new Uint8Array(285)), null);
  const badLevel = hexToBytes(fixtures.emptyLevel);
  badLevel[0] = 2;
  assert.equal(decodeLevel(badLevel), null);
  assert.equal(decodeBitmap(new Uint8Array(10)), null);
});

test("format integers without floats", () => {
  assert.equal(formatInt(0n), "0");
  assert.equal(formatInt(123456789012n), "123,456,789,012");
  assert.equal(formatInt(-1000n), "-1,000");
  assert.equal(formatAtoms(12340000000n, 7), "1,234");
  assert.equal(formatAtoms(15000000n, 7), "1.5");
  assert.equal(formatAtoms(7n, 7), "0.0000007");
  assert.equal(ticksToPrice(99, 1, 1, 7, 7), "99");
  assert.equal(ticksToPrice(1, 1, 2, 0, 0), "0.5");
});
