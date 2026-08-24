import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import fixture from "./state.fixture.json";
import {
  bandTooWide,
  banKey,
  clampHealTarget,
  crosses,
  drawTake,
  halfEvenRound,
  healTargetFromQuote,
  inTickBand,
  inventorySkew,
  ladder,
  LOOP_LINE_KEYS,
  loopLine,
  stepAwayFromBanned,
  takeLimit,
  tickOf,
} from "./math";
import { loadState, saveState, type MmState } from "./statefile";

test("halfEvenRound matches Python round on .5 boundaries", () => {
  expect(halfEvenRound(0.5)).toBe(0);
  expect(halfEvenRound(1.5)).toBe(2);
  expect(halfEvenRound(2.5)).toBe(2);
  expect(halfEvenRound(3.5)).toBe(4);
  expect(halfEvenRound(4.5)).toBe(4);
  expect(halfEvenRound(19862.5)).toBe(19862);
  expect(halfEvenRound(19863.5)).toBe(19864);
  expect(halfEvenRound(-0.5)).toBe(-0);
  expect(halfEvenRound(-1.5)).toBe(-2);
  expect(halfEvenRound(2.4)).toBe(2);
  expect(halfEvenRound(2.6)).toBe(3);
});

test("tickOf matches Python int(round(price / 0.00001))", () => {
  expect(tickOf(0.198625)).toBe(19862);
  expect(tickOf(0.15)).toBe(15000);
  expect(tickOf(0.158)).toBe(15800);
  expect(tickOf(0.158125)).toBe(15812);
  expect(tickOf(0.158135)).toBe(15813);
  expect(tickOf(0.2)).toBe(20000);
  expect(tickOf(0.19862)).toBe(19862);
  expect(tickOf(0.19863)).toBe(19863);
});

test("ladder and skew match hand-computed Python values", () => {
  const params = { levels: 3, halfSpreadBps: 4.0, spacingBps: 5.0, baseLots: 25, stepLots: 12 };
  const flat = ladder(15800, 0, params);
  expect(flat.bids.map((s) => [s.tick, s.lots])).toEqual([
    [15793, 25],
    [15785, 37],
    [15777, 49],
  ]);
  expect(flat.asks.map((s) => [s.tick, s.lots])).toEqual([
    [15807, 25],
    [15815, 37],
    [15823, 49],
  ]);
  const skewed = ladder(15800, -1.5, params);
  expect(skewed.bids.map((s) => [s.tick, s.lots])).toEqual([
    [15791, 25],
    [15783, 37],
    [15775, 49],
  ]);
  expect(skewed.asks.map((s) => [s.tick, s.lots])).toEqual([
    [15804, 25],
    [15812, 37],
    [15820, 49],
  ]);
  const skew = inventorySkew({
    skewBps: 3,
    ladder: { levels: 20, halfSpreadBps: 4, spacingBps: 5, baseLots: 25, stepLots: 12 },
    price: 0.158,
    xlm: 41000,
    usdc: 69000,
    inv0: { xlm: 40000, usdc: 70000 },
  });
  expect(skew).toBeCloseTo(-0.39545578726891906, 10);
});

test("bad-tick stepping walks one tick away while banned", () => {
  const banned = new Map<string, number>();
  banned.set(banKey(true, 100), 50);
  banned.set(banKey(true, 99), 50);
  banned.set(banKey(false, 200), 50);
  expect(stepAwayFromBanned(true, 100, banned, 10)).toBe(98);
  expect(stepAwayFromBanned(true, 100, banned, 60)).toBe(100);
  expect(stepAwayFromBanned(false, 200, banned, 10)).toBe(201);
});

test("heal chunk/clamp math", () => {
  expect(clampHealTarget(true, 1000, 2000, 150)).toBe(1150);
  expect(clampHealTarget(false, 2000, 1000, 150)).toBe(1850);
  expect(clampHealTarget(true, 1000, 1100, 150)).toBe(1100);
  expect(clampHealTarget(true, 2000, 1000, 150)).toBe(1000);
  const crossed = Array.from({ length: 32 }, (_, i) => ({ tick: 1000 + i }));
  expect(healTargetFromQuote(true, 1000, 2000, 150, crossed)).toBe(1031);
  expect(healTargetFromQuote(true, 1000, 2000, 150, crossed.slice(0, 31))).toBe(1150);
  expect(crosses(true, 100, 110)).toBe(true);
  expect(crosses(true, 120, 110)).toBe(false);
  expect(crosses(false, 120, 110)).toBe(true);
  expect(crosses(false, 100, 110)).toBe(false);
});

test("state round-trips a real-shape fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-state-"));
  const path = join(dir, "state.json");
  writeFileSync(path, JSON.stringify(fixture));
  const loaded = loadState(path);
  expect(loaded.next_nonce).toBe(1787146455100);
  expect(loaded.fills).toBe(12);
  expect(loaded.volume_lots).toBe(340);
  expect(loaded.inv0).toEqual({ xlm: 39970.1234567, usdc: 70435.5 });
  expect(loaded.quotes["1787146455004"]).toMatchObject({ side: "bid", tick: 19360, lots: 49, slot: 2 });
  expect(loaded.quotes["1787146455040"].filled_lots).toBe(3);
  const out = join(dir, "round.json");
  saveState(out, loaded);
  const again = JSON.parse(readFileSync(out, "utf8")) as MmState;
  expect(again).toEqual(loaded);
  expect(Object.keys(again)).toEqual(["quotes", "next_nonce", "fills", "volume_lots", "inv0"]);
});

test("loadState defaults only when the file is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-state-"));
  const missing = join(dir, "nope.json");
  const fresh = loadState(missing, 1000);
  expect(fresh.quotes).toEqual({});
  expect(fresh.next_nonce).toBe(1_000_000);
  writeFileSync(join(dir, "bad.json"), "{not json");
  expect(() => loadState(join(dir, "bad.json"))).toThrow();
});

test("band-guard skips ticks at the edges", () => {
  expect(inTickBand(1)).toBe(false);
  expect(inTickBand(2)).toBe(true);
  expect(inTickBand(4194302)).toBe(true);
  expect(inTickBand(4194303)).toBe(false);
  expect(inTickBand(4194304)).toBe(false);
  expect(bandTooWide(100, 240)).toBe(false);
  expect(bandTooWide(100, 241)).toBe(true);
  expect(takeLimit(true, 100, 12)).toBe(112);
  expect(takeLimit(false, 100, 12)).toBe(88);
  expect(takeLimit(false, 5, 40)).toBe(2);
});

test("take-mix bounds over 1000 draws", () => {
  let n1 = 0;
  let n2 = 0;
  let n3 = 0;
  for (let i = 0; i < 1000; i++) {
    const u = Math.random();
    const d = drawTake(u);
    if (u < 0.6) {
      n1 += 1;
      expect(d.depth).toBe(0);
      expect(d.lots).toBeGreaterThanOrEqual(1);
      expect(d.lots).toBeLessThanOrEqual(12);
    } else if (u < 0.9) {
      n2 += 1;
      expect(d.depth).toBe(12);
      expect(d.lots).toBeGreaterThanOrEqual(20);
      expect(d.lots).toBeLessThanOrEqual(80);
    } else {
      n3 += 1;
      expect(d.depth).toBe(40);
      expect(d.lots).toBeGreaterThanOrEqual(100);
      expect(d.lots).toBeLessThanOrEqual(260);
    }
  }
  expect(n1).toBeGreaterThan(450);
  expect(n1).toBeLessThan(750);
  expect(n2).toBeGreaterThan(180);
  expect(n2).toBeLessThan(420);
  expect(n3).toBeGreaterThan(50);
  expect(n3).toBeLessThan(180);
});

test("loop-line field set is the exact key list", () => {
  const line = loopLine({
    outcome: "ok",
    loop: 3,
    mid: 0.158,
    src: "coinbase",
    mid_tick: 15800,
    skew_bps: -0.12,
    our_bid: 15793,
    our_ask: 15807,
    book_bid: 15790,
    book_ask: 15810,
    live: 40,
    n_bids: 20,
    n_asks: 20,
    replaced: 8,
    placed: 6,
    fills_total: 12,
    volume_lots: 340,
    xlm: 39970,
    usdc: 70435,
  });
  expect(Object.keys(line)).toEqual([...LOOP_LINE_KEYS]);
});
