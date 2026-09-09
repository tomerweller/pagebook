import { expect, test } from "vitest";
import { accessOf, hexToAccount, sortedKeyStrs } from "./clientKeys";
import { plannedKeysFor, touchedKeysFor } from "./pad";

const OWNER = "01".repeat(32);
const BASE = "02".repeat(32);
const QUOTE = "03".repeat(32);

test("plannedKeysFor placePostOnly is rest keys, Order, and both FeeAccruals", () => {
  const intent = {
    kind: "placePostOnly" as const,
    market: 1,
    isBid: true,
    limitTick: 40,
    taker: hexToAccount(OWNER),
    nonce: 9n,
    base: BASE,
    quote: QUOTE,
  };
  const planned = plannedKeysFor(intent);
  expect(sortedKeyStrs(planned)).toEqual([
    "BestTick(1,false)",
    "BestTick(1,true)",
    `FeeAccrual(1,${BASE})`,
    `FeeAccrual(1,${QUOTE})`,
    "Level(1,true,40)",
    `Order(1,${OWNER},9)`,
    "TickSummary(1,true)",
    "TickWord(1,true,0)",
  ]);
  expect(sortedKeyStrs(touchedKeysFor(intent, planned))).toEqual(
    sortedKeyStrs(planned.filter((k) => accessOf(k) === "rw")),
  );
});

test("plannedKeysFor settle is fee keys only", () => {
  const intent = { kind: "settle" as const, market: 1, base: BASE, quote: QUOTE };
  const planned = plannedKeysFor(intent);
  expect(sortedKeyStrs(planned)).toEqual([`FeeAccrual(1,${BASE})`, `FeeAccrual(1,${QUOTE})`]);
  expect(sortedKeyStrs(touchedKeysFor(intent, planned))).toEqual(
    sortedKeyStrs(planned.filter((k) => accessOf(k) === "rw")),
  );
});

test("plannedKeysFor replace is rest keys and fee keys", () => {
  const intent = {
    kind: "replace" as const,
    market: 1,
    isBid: false,
    tick: 40,
    base: BASE,
    quote: QUOTE,
  };
  const planned = plannedKeysFor(intent);
  expect(sortedKeyStrs(planned)).toEqual([
    "BestTick(1,false)",
    "BestTick(1,true)",
    `FeeAccrual(1,${BASE})`,
    `FeeAccrual(1,${QUOTE})`,
    "Level(1,false,40)",
    "TickSummary(1,false)",
    "TickWord(1,false,0)",
  ]);
  expect(sortedKeyStrs(touchedKeysFor(intent, planned))).toEqual(
    sortedKeyStrs(planned.filter((k) => accessOf(k) === "rw")),
  );
});

test("plannedKeysFor replaceBatch dedups rest keys that share a word", () => {
  const intent = {
    kind: "replaceBatch" as const,
    market: 1,
    items: [
      { isBid: true, tick: 10 },
      { isBid: true, tick: 11 },
    ],
    base: BASE,
    quote: QUOTE,
  };
  const planned = plannedKeysFor(intent);
  expect(sortedKeyStrs(planned)).toEqual([
    "BestTick(1,false)",
    "BestTick(1,true)",
    `FeeAccrual(1,${BASE})`,
    `FeeAccrual(1,${QUOTE})`,
    "Level(1,true,10)",
    "Level(1,true,11)",
    "TickSummary(1,true)",
    "TickWord(1,true,0)",
  ]);
  expect(sortedKeyStrs(touchedKeysFor(intent, planned))).toEqual(
    sortedKeyStrs(planned.filter((k) => accessOf(k) === "rw")),
  );
});
