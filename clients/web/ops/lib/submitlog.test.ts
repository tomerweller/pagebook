import { expect, test } from "vitest";
import { MAX_RESTORES_PER_CYCLE, recordSubmit, runSubmit } from "./submitlog";
import type { EngineResult } from "../../src/engine/submit";
import type { Rpc } from "../../src/book";

test("runSubmit records a thrown build_error once", async () => {
  const lines: { action: string; outcome: string }[] = [];
  const log = {
    record(action: string, outcome: string) {
      lines.push({ action, outcome });
      return { t: 0, action, outcome };
    },
  };
  const { out, res } = await runSubmit(log, "place", {}, async () => {
    throw new Error("boom");
  });
  expect(out).toBe("build_error");
  expect(res.kind).toBe("build_error");
  expect(lines).toEqual([{ action: "place", outcome: "build_error" }]);
});

test("recordSubmit keeps the outcome string for a typed apply failure", () => {
  const lines: string[] = [];
  recordSubmit(
    {
      record(_a, outcome) {
        lines.push(outcome);
        return { t: 0, action: "x", outcome };
      },
    },
    "place",
    { kind: "typed", errorCode: 11, errorName: "LevelFull", at: "simulation" },
  );
  expect(lines).toEqual(["sim:typed:LevelFull"]);
});

test("runSubmit restores an archived key then retries once", async () => {
  const lines: { action: string; outcome: string; extra?: Record<string, unknown> }[] = [];
  const log = {
    record(action: string, outcome: string, extra?: Record<string, unknown>) {
      lines.push({ action, outcome, extra });
      return { t: 0, action, outcome };
    },
  };
  let calls = 0;
  const restored: string[][] = [];
  const { out, res } = await runSubmit(
    log,
    "place",
    {},
    async () => {
      calls += 1;
      if (calls === 1) {
        return {
          kind: "archived",
          keyName: "TickSummary(1,false)",
          keyXdr: "KEYXDR",
          at: "apply",
        } satisfies EngineResult;
      }
      return { kind: "ok", hash: "ff" } satisfies EngineResult;
    },
    {
      rpc: {} as Rpc,
      secret: "S",
      contract: "C",
      budget: { n: 0 },
      restore: async (_rpc, _secret, _contract, keys) => {
        restored.push(keys);
        return { kind: "ok", hash: "re" };
      },
    },
  );
  expect(out).toBe("ok");
  expect(res.kind).toBe("ok");
  expect(calls).toBe(2);
  expect(restored).toEqual([["KEYXDR"]]);
  expect(lines).toEqual([
    { action: "place", outcome: "archived:TickSummary(1,false)", extra: { tx: "", detail: "archived:TickSummary(1,false)" } },
    { action: "restore", outcome: "ok", extra: { key: "TickSummary(1,false)" } },
    { action: "place", outcome: "ok", extra: { tx: "ff", detail: "" } },
  ]);
});

test("runSubmit caps restores per cycle", async () => {
  const log = {
    record() {
      return { t: 0, action: "x", outcome: "x" };
    },
  };
  let restores = 0;
  const budget = { n: MAX_RESTORES_PER_CYCLE };
  const { res } = await runSubmit(
    log,
    "place",
    {},
    async () =>
      ({
        kind: "archived",
        keyName: "TickSummary(1,false)",
        keyXdr: "KEYXDR",
        at: "apply",
      }) satisfies EngineResult,
    {
      rpc: {} as Rpc,
      secret: "S",
      contract: "C",
      budget,
      restore: async () => {
        restores += 1;
        return { kind: "ok", hash: "re" };
      },
    },
  );
  expect(res.kind).toBe("archived");
  expect(restores).toBe(0);
});
