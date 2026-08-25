import { expect, test } from "vitest";
import { parseStressArgs, ticksFor } from "./stress";

test("ticksFor is 40 ticks, one per word plus 8 more, offset per account", () => {
  const a0 = ticksFor(0);
  const a1 = ticksFor(1);
  expect(a0).toHaveLength(40);
  expect(a1).toHaveLength(40);
  expect(a0[0]).toBe(200);
  expect(a0[31]).toBe(2048 * 31 + 200);
  expect(a0[32]).toBe(1200);
  expect(a0[39]).toBe(2048 * 7 + 1200);
  expect(a1[0]).toBe(217);
  expect(new Set(a0).size).toBe(40);
  expect(a0.some((t) => a1.includes(t))).toBe(false);
});

test("stress argparse peels the phase positional", () => {
  const a = parseStressArgs(["run", "--accounts", "4", "--ledgers", "10"]);
  expect(a.phase).toBe("run");
  expect(a.accounts).toBe(4);
  expect(a.ledgers).toBe(10);
  expect(a.pause).toBe(1);
  expect(a.extraPad).toBe(28);
  expect(parseStressArgs(["--log", "x.log", "analyze"]).phase).toBe("analyze");
  expect(() => parseStressArgs(["--accounts", "2"])).toThrow(/phase/);
});