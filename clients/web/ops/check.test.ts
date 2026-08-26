import { expect, test } from "vitest";
import { Feed } from "./lib/feed";
import type { Views } from "./lib/views";
import { archivedKeyName, isMmBadOutcome, parseCheckArgs, runCheck, type CheckArgs } from "./check";

function args(over: Partial<CheckArgs> = {}): CheckArgs {
  return {
    ...parseCheckArgs(["--contract", "C1", "--market", "1"]),
    ...over,
  };
}

function loop(t: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    t,
    action: "loop",
    outcome: "ok",
    mid: 0.158,
    fills_total: 2,
    volume_lots: 10,
    xlm: 5000,
    usdc: 7000,
    ...extra,
  });
}

const cleanState = JSON.stringify({
  quotes: {
    "1": { side: "bid", tick: 15780, lots: 25, slot: 0, t: 1 },
    "2": { side: "ask", tick: 15820, lots: 25, slot: 0, t: 1 },
  },
});

function openViews(bid: number, ask: number, bidLots: number, askLots: number): Views {
  return {
    best: async (isBid) => (isBid ? bid : ask),
    level: async (isBid) => ({
      generation: 1,
      head_seq: 0,
      tail_seq: 0,
      head_consumed_lots: 0,
      open_lots: isBid ? bidLots : askLots,
    }),
    order: async () => null,
    quotePlace: async () => ({ start_tick: 1, crossed: [], filled_lots: 0, quote_atoms: 0n, tail_seq: 0 }),
  };
}

const now = () => 10_000;

function files(mm: string, state = cleanState, trader: string | null = null): {
  readFile: (p: string) => string | null;
  exists: (p: string) => boolean;
} {
  return {
    readFile: (p) => {
      if (p.includes("trader")) return trader;
      if (p.includes("state")) return state;
      return mm;
    },
    exists: (p) => {
      if (p.includes("trader")) return trader != null;
      if (p.includes("state")) return true;
      return true;
    },
  };
}

test("check flags and defaults", () => {
  const a = parseCheckArgs(["--contract", "C1", "--market", "1"]);
  expect(a.maxLoopAge).toBe(300);
  expect(a.maxMidDevBps).toBe(50);
  expect(a.maxTouchBps).toBe(40);
  expect(a.throughMidTolBps).toBe(15);
  expect(a.minXlm).toBe(2000);
  expect(a.window).toBe(3600);
  expect(a.maxTraderAge).toBe(600);
  expect(isMmBadOutcome("footprint")).toBe(true);
  expect(isMmBadOutcome("typed:LevelFull")).toBe(true);
  expect(isMmBadOutcome("typed:Crossed")).toBe(false);
  expect(isMmBadOutcome("sim:typed:LevelFull")).toBe(false);
  expect(isMmBadOutcome("ok")).toBe(false);
  expect(isMmBadOutcome("archived:TickSummary(1,false)")).toBe(true);
  expect(isMmBadOutcome("sim:archived:TickSummary(1,false)")).toBe(false);
  expect(archivedKeyName("archived:TickSummary(1,false)")).toBe("TickSummary(1,false)");
  expect(archivedKeyName("sim:archived:BestTick(1,true)")).toBe("BestTick(1,true)");
});

test("clean window is MM OK", async () => {
  const feed = new Feed({ get: async () => ({ data: { amount: "0.158" } }) });
  const r = await runCheck(args(), {
    now,
    feed,
    views: openViews(15770, 15830, 4, 4),
    ...files(loop(9990) + "\n" + JSON.stringify({ t: 9995, action: "place", outcome: "ok", tx: "aa" })),
  });
  expect(r.ok).toBe(true);
  expect(r.line.startsWith("MM OK ")).toBe(true);
  expect(r.alerts).toEqual([]);
});

test("doctored bad-outcome window is MM ALERT", async () => {
  const feed = new Feed({ get: async () => ({ data: { amount: "0.158" } }) });
  const mm =
    loop(9990) +
    "\n" +
    JSON.stringify({ t: 9995, action: "place", outcome: "footprint", tx: "bb" }) +
    "\n" +
    JSON.stringify({ t: 9996, action: "heal", outcome: "typed:LevelFull", tx: "cc" });
  const r = await runCheck(args(), {
    now,
    feed,
    views: openViews(15770, 15830, 4, 4),
    ...files(mm),
  });
  expect(r.ok).toBe(false);
  expect(r.line.startsWith("MM ALERT ")).toBe(true);
  expect(r.alerts.some((a) => a.includes("bad outcomes"))).toBe(true);
  expect(r.alerts.join(" ")).toMatch(/place\/footprint/);
  expect(r.alerts.join(" ")).toMatch(/heal\/typed:LevelFull/);
});

test("phantom cross is a note; real cross is an alert", async () => {
  const feed = new Feed({ get: async () => ({ data: { amount: "0.158" } }) });
  const mm = loop(9990);
  const phantom = await runCheck(args(), {
    now,
    feed,
    views: openViews(15850, 15750, 0, 5),
    ...files(mm),
  });
  expect(phantom.ok).toBe(true);
  expect(phantom.notes.some((n) => n.includes("phantom"))).toBe(true);

  const real = await runCheck(args(), {
    now,
    feed,
    views: openViews(15850, 15750, 3, 5),
    ...files(mm),
  });
  expect(real.ok).toBe(false);
  expect(real.alerts.some((a) => a.includes("book crossed for real"))).toBe(true);
});

test("through-mid tolerance boundary", async () => {
  const feed = new Feed({ get: async () => ({ data: { amount: "0.158" } }) });
  const mm = loop(9990);
  const midTick = 15800;
  const tol = Math.floor((midTick * 15) / 1e4);
  expect(tol).toBe(23);

  const inside = await runCheck(args(), {
    now,
    feed,
    views: openViews(15700, 15900, 1, 1),
    ...files(
      mm,
      JSON.stringify({
        quotes: {
          b: { side: "bid", tick: midTick + tol - 1, lots: 1, slot: 0, t: 1 },
          a: { side: "ask", tick: midTick + 40, lots: 1, slot: 0, t: 1 },
        },
      }),
    ),
  });
  expect(inside.alerts.some((x) => x.includes("quote through the mid"))).toBe(false);
  expect(inside.notes.some((n) => n.includes("within 15 bps tolerance"))).toBe(true);

  const over = await runCheck(args(), {
    now,
    feed,
    views: openViews(15700, 15900, 1, 1),
    ...files(
      mm,
      JSON.stringify({
        quotes: {
          b: { side: "bid", tick: midTick + tol, lots: 1, slot: 0, t: 1 },
          a: { side: "ask", tick: midTick + 40, lots: 1, slot: 0, t: 1 },
        },
      }),
    ),
  });
  expect(over.ok).toBe(false);
  expect(over.alerts.some((x) => x.includes("quote through the mid"))).toBe(true);
});

test("archived outcomes get their own alert class", async () => {
  const feed = new Feed({ get: async () => ({ data: { amount: "0.158" } }) });
  const mm =
    loop(9990) +
    "\n" +
    JSON.stringify({ t: 9995, action: "place", outcome: "archived:TickSummary(1,false)", tx: "bb" }) +
    "\n" +
    JSON.stringify({ t: 9996, action: "replace", outcome: "archived:TickSummary(1,false)", tx: "cc" });
  const r = await runCheck(args(), {
    now,
    feed,
    views: openViews(15770, 15830, 4, 4),
    ...files(mm),
  });
  expect(r.ok).toBe(false);
  expect(r.alerts.some((a) => a.includes("archived entries:"))).toBe(true);
  expect(r.alerts.join(" ")).toContain('"TickSummary(1,false)":2');
});