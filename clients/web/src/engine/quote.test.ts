import { expect, test } from "vitest";
import { parseQuoteResult } from "./quote";

test("parseQuoteResult decodes snake_case QuoteResult", () => {
  expect(
    parseQuoteResult({
      start_tick: 5,
      crossed: [{ tick: 1 }],
      filled_lots: 3n,
      quote_atoms: 9n,
    }),
  ).toEqual({
    startTick: 5,
    crossed: [{ tick: 1 }],
    filledLots: 3n,
    quoteAtoms: 9n,
  });
});

test("parseQuoteResult rejects camelCase and missing fields", () => {
  expect(() =>
    parseQuoteResult({
      startTick: 5,
      crossed: [],
      filledLots: 0n,
      quoteAtoms: 0n,
    }),
  ).toThrow(/missing start_tick/);
  expect(() =>
    parseQuoteResult({
      start_tick: 5,
      crossed: [],
      quote_atoms: 0n,
    }),
  ).toThrow(/missing filled_lots/);
});
