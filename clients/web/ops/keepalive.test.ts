import { expect, test } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { wordOf } from "../src/decode";
import { keyStr } from "../src/engine/clientKeys";
import {
  batchItems,
  enumerateKeepaliveKeys,
  EXTEND_BATCH,
  midFromBests,
  parseKeepaliveArgs,
  planKeepalive,
  runKeepalive,
  ticksAround,
  wordsAround,
} from "./keepalive";
import type { KeepaliveRow } from "./keepalive";

test("keepalive flags and defaults", () => {
  const a = parseKeepaliveArgs(["--contract", "C1", "--market", "1", "--base-sac", "B", "--quote-sac", "Q"]);
  expect(a.identity).toBe("pb-mm");
  expect(a.wordSpan).toBe(2);
  expect(a.tickSpan).toBe(400);
  expect(a.horizonLedgers).toBe(51840);
  expect(a.extendLedgers).toBe(500000);
  expect(a.dryRun).toBe(false);
  expect(parseKeepaliveArgs(["--contract", "C1", "--market", "1", "--base-sac", "B", "--quote-sac", "Q", "--dry-run"]).dryRun).toBe(
    true,
  );
});

test("wordsAround and ticksAround cover mid plus the span", () => {
  const mid = 18000;
  expect(wordOf(mid)).toBe(8);
  expect(wordsAround(mid, 2)).toEqual([6, 7, 8, 9, 10]);
  expect(wordsAround(100, 2)[0]).toBe(0);
  const ticks = ticksAround(mid, 400);
  expect(ticks[0]).toBe(17600);
  expect(ticks[ticks.length - 1]).toBe(18400);
  expect(ticks.length).toBe(801);
  expect(ticksAround(10, 400)[0]).toBe(1);
});

test("enumerateKeepaliveKeys lists singletons, words, and the tick band", () => {
  const base = "02".repeat(32);
  const quote = "03".repeat(32);
  const none = enumerateKeepaliveKeys({ market: 1, mid: null, wordSpan: 2, tickSpan: 400, base, quote });
  expect(none.map(keyStr).sort()).toEqual(
    [
      "Market(1)",
      "TickSummary(1,true)",
      "TickSummary(1,false)",
      "BestTick(1,true)",
      "BestTick(1,false)",
      `FeeAccrual(1,${base})`,
      `FeeAccrual(1,${quote})`,
    ].sort(),
  );
  const keys = enumerateKeepaliveKeys({ market: 1, mid: 18000, wordSpan: 2, tickSpan: 400, base, quote });
  expect(keys.some((k) => k.t === "TickWord" && k.word === 6 && k.isBid)).toBe(true);
  expect(keys.some((k) => k.t === "TickWord" && k.word === 10 && !k.isBid)).toBe(true);
  expect(keys.some((k) => k.t === "Level" && k.tick === 17600)).toBe(true);
  expect(keys.some((k) => k.t === "Level" && k.tick === 18400 && !k.isBid)).toBe(true);
  expect(keys.filter((k) => k.t === "TickWord").length).toBe(10);
  expect(keys.filter((k) => k.t === "Level").length).toBe(1602);
  expect(midFromBests(10, 20)).toBe(15);
  expect(midFromBests(10, null)).toBe(10);
  expect(midFromBests(null, null)).toBeNull();
});

test("planKeepalive extends near-horizon live keys and restores archived", () => {
  const rows: KeepaliveRow[] = [
    { key: { t: "Market", market: 1 }, keyXdr: "a", liveness: "live", liveUntil: 100 },
    { key: { t: "BestTick", market: 1, isBid: true }, keyXdr: "b", liveness: "live", liveUntil: 200 },
    { key: { t: "TickSummary", market: 1, isBid: false }, keyXdr: "c", liveness: "archived", liveUntil: 50 },
    { key: { t: "Level", market: 1, isBid: true, tick: 1 }, keyXdr: "d", liveness: "nonexistent" },
  ];
  const plan = planKeepalive(rows, 80, 30);
  expect(plan.map((p) => `${p.op}:${p.keyName}`)).toEqual([
    "extend:Market(1)",
    "restore:TickSummary(1,false)",
    "extend:TickSummary(1,false)",
  ]);
});

test("batchItems splits on the 90-key extend boundary", () => {
  expect(batchItems([], EXTEND_BATCH)).toEqual([]);
  expect(batchItems([1], EXTEND_BATCH)).toEqual([[1]]);
  expect(batchItems(Array.from({ length: 90 }, (_, i) => i), EXTEND_BATCH)).toHaveLength(1);
  expect(batchItems(Array.from({ length: 91 }, (_, i) => i), EXTEND_BATCH).map((b) => b.length)).toEqual([90, 1]);
  expect(batchItems(Array.from({ length: 180 }, (_, i) => i), EXTEND_BATCH)).toHaveLength(2);
});

test("runKeepalive dry-run plans from synthetic getLedgerEntries", async () => {
  const kp = StellarSdk.Keypair.random();
  const lines: { action: string; outcome: string; extra?: Record<string, unknown> }[] = [];
  const contract = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO";
  const { r } = await (async () => {
    const args = parseKeepaliveArgs([
      "--contract",
      contract,
      "--market",
      "1",
      "--base-sac",
      contract,
      "--quote-sac",
      contract,
      "--dry-run",
      "--tick-span",
      "0",
      "--word-span",
      "0",
    ]);
    const result = await runKeepalive(args, {
      id: { name: "pb-mm", secret: kp.secret(), address: kp.publicKey() },
      views: {
        best: async (isBid) => (isBid ? 100 : 110),
        level: async () => ({ generation: 0, head_seq: 0, tail_seq: 0, head_consumed_lots: 0, open_lots: 0 }),
        order: async () => null,
        quotePlace: async () => ({ start_tick: 1, crossed: [], filled_lots: 0, quote_atoms: 0n, tail_seq: 0 }),
      },
      rpc: {
        getLedgerEntries: async (...keys: Array<string | { toXDR: (fmt: string) => string }>) => ({
          latestLedger: 1000,
          entries: keys.slice(0, 2).map((k) => ({
            key: typeof k === "string" ? k : "toXDR" in k ? k.toXDR("base64") : "",
            xdr: StellarSdk.xdr.ScVal.scvVoid().toXDR("base64"),
            liveUntilLedgerSeq: 1010,
          })),
        }),
      } as never,
      log: {
        record(action, outcome, extra) {
          lines.push({ action, outcome, extra });
          return { t: 0, action, outcome };
        },
        close() {},
      },
    });
    return { r: result };
  })();
  expect(r.summary.dry).toBe(true);
  expect(r.summary.mid).toBe(105);
  expect(r.line.startsWith("KEEPALIVE dry ")).toBe(true);
  expect(lines.some((l) => l.action === "extend" && l.outcome === "dry")).toBe(true);
});
