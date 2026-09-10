import { expect, test } from "vitest";
import { createRequestGate, type RequestScope } from "./request";

const scopeA: RequestScope = { contract: "C", market: 1, account: "A" };
const scopeB: RequestScope = { contract: "C", market: 2, account: "A" };

test("begin then begin rejects the older token", () => {
  const gate = createRequestGate<number>();
  const older = gate.begin(scopeA, 1);
  gate.begin(scopeA, 2);
  expect(gate.accepts(older, scopeA)).toBe(false);
});

test("invalidate alone rejects the outstanding token", () => {
  const gate = createRequestGate<null>();
  const token = gate.begin(scopeA, null);
  gate.invalidate();
  expect(gate.accepts(token, scopeA)).toBe(false);
});

test("a token for scope A is rejected when the live scope is B", () => {
  const gate = createRequestGate<null>();
  const token = gate.begin(scopeA, null);
  expect(gate.accepts(token, scopeB)).toBe(false);
});

test("A to B to A with a version bump in between rejects the A token", () => {
  const gate = createRequestGate<null>();
  const tokenA = gate.begin(scopeA, null);
  gate.begin(scopeB, null);
  expect(gate.accepts(tokenA, scopeA)).toBe(false);
});

test("identical scope and current version accepts", () => {
  const gate = createRequestGate<string>();
  const token = gate.begin(scopeA, "ok");
  expect(gate.accepts(token, scopeA)).toBe(true);
});
