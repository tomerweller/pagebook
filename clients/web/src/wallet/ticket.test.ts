import { expect, test } from "vitest";
import {
  escrowBaseAtoms,
  escrowQuoteAtoms,
  lotsInBounds,
  remainderDisposition,
  takerFeeAtoms,
  tickInBand,
  validateTicket,
  XLM_FEE_HEADROOM,
} from "./ticket";
import type { MarketInfo } from "../book";

const market: MarketInfo = {
  base: "C".padEnd(56, "A"),
  quote: "C".padEnd(56, "B"),
  lot_size: 100_000_000n,
  tick_size: 1_000n,
  tick_min: 1,
  tick_max: 4_194_304,
  taker_fee_bps: 5,
  min_order_lots: 1n,
  max_order_lots: 1_000_000n,
  max_levels_crossed: 32,
  max_slots_scanned: 64,
  inline_slots: 32,
  page_slots: 32,
  max_pages: 1,
};

test("escrow quote is lots × tick × tick_size", () => {
  expect(escrowQuoteAtoms(2n, 19200, 1000n)).toBe(38_400_000n);
  expect(escrowQuoteAtoms(5n, 100, 1n)).toBe(500n);
});

test("escrow base is lots × lot_size", () => {
  expect(escrowBaseAtoms(5n, 100_000_000n)).toBe(500_000_000n);
});

test("taker fee rounds up", () => {
  expect(takerFeeAtoms(10_000n, 5)).toBe(5n);
  expect(takerFeeAtoms(7n, 1000)).toBe(1n);
  expect(takerFeeAtoms(0n, 5)).toBe(0n);
});

test("tick band and lot bounds", () => {
  expect(tickInBand(1, 1, 10)).toBe(true);
  expect(tickInBand(10, 1, 10)).toBe(false);
  expect(tickInBand(0, 1, 10)).toBe(false);
  expect(lotsInBounds(1n, 1n, 100n)).toBe(true);
  expect(lotsInBounds(0n, 1n, 100n)).toBe(false);
  expect(lotsInBounds(101n, 1n, 100n)).toBe(false);
});

test("remainder disposition respects flags", () => {
  expect(remainderDisposition(3n, 5n, { post_only: false, fill_or_kill: false, no_rest: false })).toBe("rests");
  expect(remainderDisposition(3n, 5n, { post_only: false, fill_or_kill: false, no_rest: true })).toBe("refunds");
  expect(remainderDisposition(3n, 5n, { post_only: false, fill_or_kill: true, no_rest: false })).toBe("unfilled");
  expect(remainderDisposition(2n, 5n, { post_only: true, fill_or_kill: false, no_rest: false })).toBe("crossed");
  expect(remainderDisposition(5n, 5n, { post_only: false, fill_or_kill: false, no_rest: false })).toBe("refunds");
});

const funded = {
  funded: true,
  xlmSpendable: 10_000_000_000n,
  baseAtoms: 10_000_000_000n,
  quoteAtoms: 100_000_000n,
  baseIsNative: true,
  quoteIsNative: false,
  quoteSymbol: "USDC",
  baseSymbol: "XLM",
};

test("validateTicket accepts a funded in-band bid", () => {
  expect(
    validateTicket({ isBid: true, tick: 19200, lots: 2n, flags: { post_only: false, fill_or_kill: false, no_rest: false } }, market, funded).ok,
  ).toBe(true);
});

test("validateTicket rejects unfunded, band, lots, trustline, escrow", () => {
  expect(validateTicket({ isBid: true, tick: 10, lots: 1n, flags: { post_only: false, fill_or_kill: false, no_rest: false } }, market, { ...funded, funded: false }).ok).toBe(false);
  expect(validateTicket({ isBid: true, tick: 0, lots: 1n, flags: { post_only: false, fill_or_kill: false, no_rest: false } }, market, funded).ok).toBe(false);
  expect(validateTicket({ isBid: true, tick: 10, lots: 0n, flags: { post_only: false, fill_or_kill: false, no_rest: false } }, market, funded).ok).toBe(false);
  expect(validateTicket({ isBid: true, tick: 19200, lots: 2n, flags: { post_only: false, fill_or_kill: false, no_rest: false } }, market, { ...funded, quoteAtoms: null }).ok).toBe(false);
  expect(validateTicket({ isBid: true, tick: 19200, lots: 2n, flags: { post_only: false, fill_or_kill: false, no_rest: false } }, market, { ...funded, quoteAtoms: 1n }).ok).toBe(false);
  expect(validateTicket({ isBid: false, tick: 19200, lots: 5n, flags: { post_only: false, fill_or_kill: false, no_rest: false } }, market, { ...funded, xlmSpendable: XLM_FEE_HEADROOM + 1n }).ok).toBe(false);
});
