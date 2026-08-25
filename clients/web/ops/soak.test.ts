import { expect, test } from "vitest";
import { outcomeOf } from "./lib/outcomes";
import { parseSoakArgs, soakLine } from "./soak";

test("soak argparse flags and defaults", () => {
  const a = parseSoakArgs(["--contract", "C1", "--base", "B", "--quote", "Q", "--issuer", "G", "--codes", "PBA,PBB"]);
  expect(a.market).toBe(0);
  expect(a.ledgers).toBe(2000);
  expect(a.mid).toBe(100);
  expect(a.taker).toBe("pb-taker");
  expect(a.maker).toBe("pb-maker");
  expect(a.spam).toBe("pb-spam");
  expect(a.storm).toBe("pb-storm");
  expect(a.log).toBe("ops/soak.log");
});

test("soak log line uses role not acct", () => {
  const line = soakLine("pb-taker", "place", "ok", "abc", 12.5);
  expect(Object.keys(line)).toEqual(["t", "role", "action", "outcome", "detail"]);
  expect(line.role).toBe("pb-taker");
  expect(line.acct).toBeUndefined();
});

test("soak classification reuses outcomes vocabulary", () => {
  expect(outcomeOf({ kind: "ok", hash: "aa" })).toBe("ok");
  expect(outcomeOf({ kind: "typed", errorCode: 11, errorName: "LevelFull", at: "simulation" })).toBe("sim:typed:LevelFull");
  expect(outcomeOf({ kind: "typed", errorCode: 9, errorName: "Crossed", at: "apply" })).toBe("typed:Crossed");
  expect(outcomeOf({ kind: "footprint" })).toBe("footprint");
  expect(outcomeOf({ kind: "trapped" })).toBe("trapped:unknown");
});