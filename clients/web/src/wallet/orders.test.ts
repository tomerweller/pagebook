import { expect, test } from "vitest";
import { countLabel } from "../view/format";
import { MAX_REPLACE_BATCH } from "../engine/pad";
import {
  batchRequoteTicks,
  isArchivedEntry,
  isStaleGeneration,
  replaceNet,
  settleAtoms,
  sumDeltas,
  type OpenOrder,
} from "./orders";

const lot = 100_000_000n;
const tickSize = 1_000n;

function ord(p: Partial<OpenOrder> & Pick<OpenOrder, "isBid" | "tick" | "filledLots" | "refundLots">): OpenOrder {
  return {
    nonce: 1n,
    qtyLots: p.filledLots + p.refundLots,
    generation: 1,
    seq: 0,
    archived: false,
    ...p,
  };
}

test("settleAtoms bid claims base and refunds quote", () => {
  const d = settleAtoms(ord({ isBid: true, tick: 19633, filledLots: 0n, refundLots: 1n }), lot, tickSize);
  expect(d.base).toBe(0n);
  expect(d.quote).toBe(19_633_000n);
});

test("settleAtoms ask claims quote and refunds base", () => {
  const d = settleAtoms(ord({ isBid: false, tick: 19680, filledLots: 1n, refundLots: 0n }), lot, tickSize);
  expect(d.base).toBe(0n);
  expect(d.quote).toBe(19_680_000n);
});

test("replaceNet same-side bid tighter tick", () => {
  const o = ord({ isBid: true, tick: 19600, filledLots: 0n, refundLots: 1n });
  const net = replaceNet(o, true, 19602, 1n, lot, tickSize);
  expect(net.base).toBe(0n);
  expect(net.quote).toBe(19_600_000n - 19_602_000n);
});

test("batch net across 3 orders including a cross-side", () => {
  const a = ord({ nonce: 1n, isBid: true, tick: 100, filledLots: 0n, refundLots: 1n });
  const b = ord({ nonce: 2n, isBid: false, tick: 120, filledLots: 0n, refundLots: 1n });
  const c = ord({ nonce: 3n, isBid: true, tick: 90, filledLots: 0n, refundLots: 1n });
  const parts = [
    replaceNet(a, true, 102, 1n, lot, tickSize),
    replaceNet(b, true, 80, 1n, lot, tickSize),
    replaceNet(c, false, 130, 1n, lot, tickSize),
  ];
  const net = sumDeltas(parts);
  expect(net.base).toBe(0n);
  expect(net.quote).toBe(100_000n - 102_000n - 80_000n + 90_000n);
  const planned = batchRequoteTicks([a, b, c], 110, 15);
  expect(planned[0].newTick).toBe(95);
  expect(planned[1].newTick).toBe(125);
  expect(planned[2].newTick).toBe(95);
});

test("stale generation when the level moved past the order", () => {
  expect(isStaleGeneration(3, 4)).toBe(true);
  expect(isStaleGeneration(3, 3)).toBe(false);
  expect(isStaleGeneration(3, undefined)).toBe(false);
});

test("archived when liveUntil is behind latest", () => {
  expect(isArchivedEntry(100, 200)).toBe(true);
  expect(isArchivedEntry(200, 200)).toBe(false);
  expect(isArchivedEntry(undefined, 200)).toBe(false);
});

test("countLabel singular and plural", () => {
  expect(countLabel(1, "level")).toBe("1 level");
  expect(countLabel(3, "level")).toBe("3 levels");
  expect(countLabel(1n, "lot")).toBe("1 lot");
  expect(countLabel(5n, "lot")).toBe("5 lots");
});

test("MAX_REPLACE_BATCH matches the contract constant", () => {
  expect(MAX_REPLACE_BATCH).toBe(40);
});
