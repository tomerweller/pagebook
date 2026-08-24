import { expect, test } from "vitest";
import { mockSnapshot } from "../book";
import { closestBeyond, instrumentExtra, noteFills, ordersBeyondWindow, tapeIsOwn } from "./awareness";
import type { OpenOrder } from "./orders";

function ord(p: Partial<OpenOrder> & Pick<OpenOrder, "nonce" | "isBid" | "tick">): OpenOrder {
  return {
    qtyLots: 1n,
    filledLots: 0n,
    refundLots: 0n,
    generation: 1,
    seq: 0,
    archived: false,
    ...p,
  };
}

test("noteFills ignores first sight and counts later increases", () => {
  const a = ord({ nonce: 1n, isBid: true, tick: 10, filledLots: 0n });
  const first = noteFills({}, [a]);
  expect(first.added).toBe(0);
  expect(first.next["1"]).toBe("0");
  const second = noteFills(first.next, [{ ...a, filledLots: 2n }]);
  expect(second.added).toBe(1);
  const same = noteFills(second.next, [{ ...a, filledLots: 2n }]);
  expect(same.added).toBe(0);
});

test("noteFills does not fire on first sight of a part-filled order", () => {
  const a = ord({ nonce: 4n, isBid: false, tick: 20, filledLots: 3n });
  const first = noteFills({}, [a]);
  expect(first.added).toBe(0);
  expect(first.next["4"]).toBe("3");
  const later = noteFills(first.next, [{ ...a, filledLots: 5n }]);
  expect(later.added).toBe(1);
});

test("noteFills keeps lastFilled after the order disappears", () => {
  const a = ord({ nonce: 7n, isBid: false, tick: 20, filledLots: 1n });
  const seen = noteFills({ "7": "0" }, [a]);
  expect(seen.added).toBe(1);
  const gone = noteFills(seen.next, []);
  expect(gone.next["7"]).toBe("1");
  expect(gone.added).toBe(0);
});

test("instrumentExtra omits zeros", () => {
  expect(instrumentExtra(0, 0)).toBe("");
  expect(instrumentExtra(1, 0)).toBe("1 order");
  expect(instrumentExtra(2, 1)).toBe("2 orders · 1 fill");
});

test("ordersBeyondWindow splits own orders past the rendered ticks", () => {
  const book = mockSnapshot();
  const above = ord({ nonce: 1n, isBid: false, tick: 200 });
  const below = ord({ nonce: 2n, isBid: true, tick: 50 });
  const insideAsk = ord({ nonce: 3n, isBid: false, tick: 102 });
  const insideBid = ord({ nonce: 4n, isBid: true, tick: 98 });
  const out = ordersBeyondWindow([above, below, insideAsk, insideBid], book);
  expect(out.above.map((o) => o.nonce.toString())).toEqual(["1"]);
  expect(out.below.map((o) => o.nonce.toString())).toEqual(["2"]);
  expect(closestBeyond(out.above, "ask")?.tick).toBe(200);
  expect(closestBeyond(out.below, "bid")?.tick).toBe(50);
});

test("ordersBeyondWindow empty when everything is in range", () => {
  const book = mockSnapshot();
  const inside = ord({ nonce: 3n, isBid: false, tick: 101 });
  const out = ordersBeyondWindow([inside], book);
  expect(out.above).toEqual([]);
  expect(out.below).toEqual([]);
});

test("own order at the last rendered level is in-window; one tick beyond is not", () => {
  const book = mockSnapshot();
  const maxAsk = 104;
  const minBid = 97;
  const atAskEdge = ord({ nonce: 10n, isBid: false, tick: maxAsk });
  const pastAsk = ord({ nonce: 11n, isBid: false, tick: maxAsk + 1 });
  const atBidEdge = ord({ nonce: 12n, isBid: true, tick: minBid });
  const pastBid = ord({ nonce: 13n, isBid: true, tick: minBid - 1 });
  expect(ordersBeyondWindow([atAskEdge], book).above).toEqual([]);
  expect(ordersBeyondWindow([pastAsk], book).above.map((o) => o.tick)).toEqual([105]);
  expect(ordersBeyondWindow([atBidEdge], book).below).toEqual([]);
  expect(ordersBeyondWindow([pastBid], book).below.map((o) => o.tick)).toEqual([96]);
});

test("tapeIsOwn is hash-only", () => {
  const hashes = new Set(["aaa"]);
  expect(tapeIsOwn("aaa", hashes)).toBe(true);
  expect(tapeIsOwn("bbb", hashes)).toBe(false);
  expect(tapeIsOwn(undefined, hashes)).toBe(false);
  expect(tapeIsOwn("aaa", undefined)).toBe(false);
});
