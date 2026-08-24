import { expect, test } from "vitest";
import { recordSubmit, runSubmit } from "./submitlog";

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
