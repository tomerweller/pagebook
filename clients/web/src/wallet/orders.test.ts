import { expect, test } from "vitest";
import { accessOf } from "../engine/clientKeys";
import { countLabel } from "../view/format";
import { keysForReplace, MAX_REPLACE_BATCH } from "../engine/pad";
import {
  batchRequoteTicks,
  isArchivedEntry,
  isStaleGeneration,
  replaceNet,
  settleAtoms,
  sumDeltas,
  validateReplace,
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

test("replace fee estimate counts 11 rw and 2 ro with distinct tokens", () => {
  const planned = keysForReplace(0, "01".repeat(32), 1n, true, 19600, true, 19602, "02".repeat(32), "03".repeat(32));
  let rw = 0;
  let ro = 0;
  for (const k of planned) {
    if (accessOf(k) === "rw") rw += 1;
    else ro += 1;
  }
  expect({ rw, ro }).toEqual({ rw: 11, ro: 2 });
});

const bal = {
  funded: true,
  xlmSpendable: 100_000_000n,
  baseAtoms: 0n,
  quoteAtoms: 2_000_000n,
  baseIsNative: true,
  quoteIsNative: false,
  quoteSymbol: "USDC",
  baseSymbol: "XLM",
  baseDec: 7,
  quoteDec: 7,
};

test("validateReplace blocks a requote the wallet cannot escrow", () => {
  // 10 lots at tick 17000 escrows 17 USDC against a 0.2 USDC balance.
  const net = { base: 10n * lot, quote: -17_000_000n };
  const check = validateReplace(net, bal);
  expect(check.ok).toBe(false);
  if (!check.ok) {
    expect(check.reason).toBe("need 1.7 USDC for this replace");
    expect(check.title).toBe("17000000 atoms");
  }
  expect(validateReplace(net, { ...bal, quoteAtoms: 17_000_000n }).ok).toBe(true);
});

test("validateReplace names the missing trustline and the unfunded account", () => {
  const net = { base: 0n, quote: -1n };
  expect(validateReplace(net, { ...bal, quoteAtoms: null })).toEqual({
    ok: false,
    reason: "no USDC trustline",
  });
  expect(validateReplace(net, { ...bal, funded: false })).toEqual({ ok: false, reason: "account not funded" });
  expect(validateReplace(net, { ...bal, xlmSpendable: 1_000n })).toEqual({
    ok: false,
    reason: "need at least 0.2 XLM for the padded fee",
  });
});

test("validateReplace keeps the fee headroom out of a native base escrow", () => {
  const net = { base: -99_000_000n, quote: 0n };
  const check = validateReplace(net, { ...bal, xlmSpendable: 100_000_000n });
  expect(check.ok).toBe(false);
  expect(validateReplace(net, { ...bal, xlmSpendable: 101_000_000n }).ok).toBe(true);
});

test("a replace that only refunds needs no balance", () => {
  expect(validateReplace({ base: 5n * lot, quote: 1_000n }, { ...bal, quoteAtoms: 0n }).ok).toBe(true);
});
