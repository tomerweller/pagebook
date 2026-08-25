import { expect, test } from "vitest";
import { categorizeLine, categorizeLog, pickPerCat } from "./resources";

const mm = [
  { t: 1, action: "place", outcome: "ok", tx: "p1" },
  { t: 2, action: "heal", outcome: "ok", tx: "h1", phantoms: 3 },
  { t: 3, action: "heal", outcome: "ok", tx: "h2", phantoms: 9 },
  { t: 4, action: "replace", outcome: "ok", tx: "r1" },
  { t: 5, action: "replace_batch", outcome: "ok", tx: "b1" },
  { t: 6, action: "settle", outcome: "ok", tx: "s1" },
  { t: 7, action: "place", outcome: "footprint", tx: "bad" },
  { t: 8, action: "loop", outcome: "ok" },
];

const trader = [
  { t: 1, action: "take", outcome: "ok", tx: "t1", crossed: 0, lots: 2 },
  { t: 2, action: "take", outcome: "ok", tx: "t2", crossed: 2, lots: 8 },
  { t: 3, action: "take", outcome: "ok", tx: "t3", crossed: 5, lots: 20 },
  { t: 4, action: "rest", outcome: "ok", tx: "r1" },
  { t: 5, action: "settle", outcome: "ok", tx: "s1" },
  { t: 6, action: "stats", outcome: "tick" },
];

test("resources bucketing from fixture log lines", () => {
  expect(categorizeLine(mm[0], "mm")?.cat).toBe("place post-only (maker quote)");
  expect(categorizeLine(mm[1], "mm")?.cat).toBe("heal walk, 1-8 phantom levels");
  expect(categorizeLine(mm[2], "mm")?.cat).toBe("heal walk, 9+ phantom levels");
  expect(categorizeLine(mm[3], "mm")?.cat).toBe("replace (single quote)");
  expect(categorizeLine(mm[4], "mm")?.cat).toBe("replace_batch (6-8 quotes)");
  expect(categorizeLine(mm[5], "mm")?.cat).toBe("settle");
  expect(categorizeLine(mm[6], "mm")).toBeNull();
  expect(categorizeLine(mm[7], "mm")).toBeNull();

  expect(categorizeLine(trader[0], "trader")?.cat).toBe("place take, 0-1 levels crossed");
  expect(categorizeLine(trader[1], "trader")?.cat).toBe("place take, 2-3 levels crossed");
  expect(categorizeLine(trader[2], "trader")?.cat).toBe("place take, 4+ levels crossed");
  expect(categorizeLine(trader[3], "trader")?.cat).toBe("place rest inside spread (trader)");
  expect(categorizeLine(trader[4], "trader")?.cat).toBe("settle");
  expect(categorizeLine(trader[5], "trader")).toBeNull();
});

test("resources samples newest-first per category", () => {
  const text = [
    JSON.stringify({ t: 1, action: "place", outcome: "ok", tx: "old" }),
    JSON.stringify({ t: 2, action: "place", outcome: "ok", tx: "new" }),
    JSON.stringify({ t: 3, action: "heal", outcome: "ok", tx: "h", phantoms: 1 }),
  ].join("\n");
  const picks = categorizeLog(text, "mm");
  expect(picks.map((p) => p.tx)).toEqual(["h", "new", "old"]);
  const sampled = pickPerCat(picks, 1);
  expect(sampled.map((p) => p.tx).sort()).toEqual(["h", "new"]);
});