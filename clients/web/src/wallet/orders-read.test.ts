import * as StellarSdk from "@stellar/stellar-sdk";
import { beforeEach, expect, test } from "vitest";
import type { Rpc } from "../book";
import { orderKey } from "../keys";
import {
  classifyOrderEntry,
  loadNonces,
  loadOpenOrders,
  readOrderView,
  rememberNonce,
  type OpenOrder,
} from "./orders";

const CONTRACT = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO";
const OWNER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const MARKET = 0;
const SOURCE = OWNER;
const SEQUENCE = "0";

const mem = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, v);
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
    clear: () => mem.clear(),
  },
  configurable: true,
});

beforeEach(() => mem.clear());

function keyB64(k: unknown): string {
  if (typeof k === "string") return k;
  if (k && typeof k === "object" && "base64" in k && typeof (k as { base64: unknown }).base64 === "string") {
    return (k as { base64: string }).base64;
  }
  if (k && typeof k === "object" && "toXDR" in k && typeof (k as { toXDR: (fmt: string) => string }).toXDR === "function") {
    return (k as { toXDR: (fmt: string) => string }).toXDR("base64");
  }
  return String(k);
}

function nonceFromTx(xdr: string): bigint {
  const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, "Test SDF Network ; September 2015") as StellarSdk.Transaction;
  const args = tx.toEnvelope().v1().tx().operations()[0].body().invokeHostFunctionOp().hostFunction().invokeContract().args();
  return BigInt(String(StellarSdk.scValToNative(args[2])));
}

function orderXdr(
  p: Partial<{
    is_bid: boolean;
    tick: number;
    qty_lots: bigint;
    filled_lots: bigint;
    refund_lots: bigint;
    generation: number;
    seq: number;
  }> = {},
): string {
  return StellarSdk.nativeToScVal({
    is_bid: p.is_bid ?? true,
    tick: p.tick ?? 99,
    qty_lots: p.qty_lots ?? 10n,
    filled_lots: p.filled_lots ?? 1n,
    refund_lots: p.refund_lots ?? 9n,
    generation: p.generation ?? 2,
    seq: p.seq ?? 3,
  }).toXDR("base64");
}

function echoLive(keys: unknown[], liveUntil = 200, latest = 100) {
  return {
    entries: keys.map((k) => ({ key: keyB64(k), liveUntilLedgerSeq: liveUntil })),
    latestLedger: latest,
  };
}

function stubRpc(over: Partial<Rpc> = {}): Rpc {
  return {
    getLatestLedger: async () => ({ sequence: 1 }),
    getLedgerEntries: async () => ({ entries: [], latestLedger: 1 }),
    getEvents: async () => ({ events: [] }),
    getNetwork: async () => ({ passphrase: "Test SDF Network ; September 2015" }),
    sendTransaction: async () => ({ status: "PENDING" }),
    getTransaction: async () => ({ status: "NOT_FOUND" }),
    simulateTransaction: async () => ({ results: [{ xdr: orderXdr() }] }),
    ...over,
  };
}

function seed(nonces: bigint[]): void {
  for (const n of nonces) rememberNonce(OWNER, CONTRACT, MARKET, n);
}

test("classifyOrderEntry: undefined is absent, liveUntil at or above latest is live, below is archived", () => {
  expect(classifyOrderEntry(undefined, 100)).toBe("absent");
  expect(classifyOrderEntry({ liveUntilLedgerSeq: 100 }, 100)).toBe("live");
  expect(classifyOrderEntry({ liveUntilLedgerSeq: 200 }, 100)).toBe("live");
  expect(classifyOrderEntry({ liveUntilLedgerSeq: 99 }, 100)).toBe("archived");
});

test("readOrderView: no entry is absent", async () => {
  const got = await readOrderView(stubRpc(), CONTRACT, SOURCE, SEQUENCE, MARKET, OWNER, 1n);
  expect(got).toEqual({ kind: "absent" });
});

test("readOrderView: live entry with simulation error is unavailable", async () => {
  const rpc = stubRpc({
    getLedgerEntries: async (...keys) => echoLive(keys),
    simulateTransaction: async () => ({ error: "sim failed" }),
  });
  const got = await readOrderView(rpc, CONTRACT, SOURCE, SEQUENCE, MARKET, OWNER, 1n);
  expect(got.kind).toBe("unavailable");
});

test("readOrderView: live entry with malformed result XDR is unavailable", async () => {
  const rpc = stubRpc({
    getLedgerEntries: async (...keys) => echoLive(keys),
    simulateTransaction: async () => ({ results: [{ xdr: "not-a-valid-scval" }] }),
  });
  const got = await readOrderView(rpc, CONTRACT, SOURCE, SEQUENCE, MARKET, OWNER, 1n);
  expect(got.kind).toBe("unavailable");
});

test("readOrderView: live entry with simulateTransaction throwing is unavailable", async () => {
  const rpc = stubRpc({
    getLedgerEntries: async (...keys) => echoLive(keys),
    simulateTransaction: async () => {
      throw new Error("rpc down");
    },
  });
  const got = await readOrderView(rpc, CONTRACT, SOURCE, SEQUENCE, MARKET, OWNER, 1n);
  expect(got.kind).toBe("unavailable");
});

test("readOrderView: getLedgerEntries throwing is unavailable and does not reject", async () => {
  const rpc = stubRpc({
    getLedgerEntries: async () => {
      throw new Error("entries down");
    },
  });
  const got = await readOrderView(rpc, CONTRACT, SOURCE, SEQUENCE, MARKET, OWNER, 1n);
  expect(got.kind).toBe("unavailable");
});

test("readOrderView: archived entry with simulation error returns placeholder", async () => {
  const rpc = stubRpc({
    getLedgerEntries: async (...keys) => echoLive(keys, 50, 100),
    simulateTransaction: async () => ({ error: "sim failed" }),
  });
  const got = await readOrderView(rpc, CONTRACT, SOURCE, SEQUENCE, MARKET, OWNER, 7n);
  expect(got.kind).toBe("archived");
  if (got.kind !== "archived") return;
  expect(got.order.archived).toBe(true);
  expect(got.order.nonce).toBe(7n);
});

test("readOrderView: archived entry with valid result is archived with decoded fields", async () => {
  const rpc = stubRpc({
    getLedgerEntries: async (...keys) => echoLive(keys, 50, 100),
    simulateTransaction: async () => ({
      results: [{ xdr: orderXdr({ is_bid: false, tick: 42, qty_lots: 5n, filled_lots: 2n, refund_lots: 3n, generation: 8, seq: 4 }) }],
    }),
  });
  const got = await readOrderView(rpc, CONTRACT, SOURCE, SEQUENCE, MARKET, OWNER, 7n);
  expect(got.kind).toBe("archived");
  if (got.kind !== "archived") return;
  expect(got.order.archived).toBe(true);
  expect(got.order.isBid).toBe(false);
  expect(got.order.tick).toBe(42);
  expect(got.order.qtyLots).toBe(5n);
  expect(got.order.filledLots).toBe(2n);
  expect(got.order.refundLots).toBe(3n);
  expect(got.order.generation).toBe(8);
  expect(got.order.seq).toBe(4);
});

test("readOrderView: live entry with valid result is found with decoded fields", async () => {
  const rpc = stubRpc({
    getLedgerEntries: async (...keys) => echoLive(keys, 200, 100),
    simulateTransaction: async () => ({
      results: [{ xdr: orderXdr({ is_bid: true, tick: 99, qty_lots: 10n, filled_lots: 1n, refund_lots: 9n, generation: 2, seq: 3 }) }],
    }),
  });
  const got = await readOrderView(rpc, CONTRACT, SOURCE, SEQUENCE, MARKET, OWNER, 1n);
  expect(got.kind).toBe("found");
  if (got.kind !== "found") return;
  expect(got.order.archived).toBe(false);
  expect(got.order.isBid).toBe(true);
  expect(got.order.tick).toBe(99);
  expect(got.order.qtyLots).toBe(10n);
  expect(got.order.filledLots).toBe(1n);
  expect(got.order.refundLots).toBe(9n);
  expect(got.order.generation).toBe(2);
  expect(got.order.seq).toBe(3);
});

test("loadOpenOrders retains nonces on simulation and RPC failure, drops only on absence", async () => {
  seed([1n, 2n, 3n]);
  const live = stubRpc({
    getLedgerEntries: async (...keys) => echoLive(keys),
  });
  const first = await loadOpenOrders(live, CONTRACT, SOURCE, SEQUENCE, MARKET, OWNER, []);
  expect(first.map((r) => r.nonce)).toEqual([1n, 2n, 3n]);
  expect(first.every((r) => !r.unavailable)).toBe(true);

  const simFail = stubRpc({
    getLedgerEntries: async (...keys) => echoLive(keys),
    simulateTransaction: async (xdr) => {
      if (nonceFromTx(xdr) === 2n) return { error: "sim failed" };
      return { results: [{ xdr: orderXdr() }] };
    },
  });
  const second = await loadOpenOrders(simFail, CONTRACT, SOURCE, SEQUENCE, MARKET, OWNER, [], [], first);
  expect(loadNonces(OWNER, CONTRACT, MARKET)).toEqual([1n, 2n, 3n]);
  expect(second.map((r) => r.nonce)).toEqual([1n, 2n, 3n]);
  const row2 = second.find((r) => r.nonce === 2n);
  expect(row2).toEqual({ ...first.find((r) => r.nonce === 2n), unavailable: true });
  expect(second.find((r) => r.nonce === 1n)?.unavailable).toBeFalsy();
  expect(second.find((r) => r.nonce === 3n)?.unavailable).toBeFalsy();

  const rpcFail = stubRpc({
    getLedgerEntries: async () => {
      throw new Error("entries down");
    },
  });
  const third = await loadOpenOrders(rpcFail, CONTRACT, SOURCE, SEQUENCE, MARKET, OWNER, [], [], second);
  expect(loadNonces(OWNER, CONTRACT, MARKET)).toEqual([1n, 2n, 3n]);
  expect(third.map((r) => r.nonce)).toEqual([1n, 2n, 3n]);
  expect(third.every((r) => r.unavailable === true)).toBe(true);

  const absent2 = stubRpc({
    getLedgerEntries: async (...keys) => {
      const skip = orderKey(CONTRACT, MARKET, OWNER, 2n).base64;
      return {
        entries: keys
          .map((k) => keyB64(k))
          .filter((k) => k !== skip)
          .map((key) => ({ key, liveUntilLedgerSeq: 200 })),
        latestLedger: 100,
      };
    },
  });
  const fourth = await loadOpenOrders(absent2, CONTRACT, SOURCE, SEQUENCE, MARKET, OWNER, [], [], third);
  expect(loadNonces(OWNER, CONTRACT, MARKET)).toEqual([1n, 3n]);
  expect(fourth.map((r) => r.nonce)).toEqual([1n, 3n]);
});

test("loadOpenOrders with an unavailable nonce and no previous row keeps the handle and emits no row", async () => {
  seed([1n]);
  const rpc = stubRpc({
    getLedgerEntries: async (...keys) => echoLive(keys),
    simulateTransaction: async () => ({ error: "sim failed" }),
  });
  const rows = await loadOpenOrders(rpc, CONTRACT, SOURCE, SEQUENCE, MARKET, OWNER, []);
  expect(rows).toEqual([]);
  expect(loadNonces(OWNER, CONTRACT, MARKET)).toEqual([1n]);
});

test("loadOpenOrders batches entry reads and bounds view concurrency", async () => {
  const count = 250;
  seed(Array.from({ length: count }, (_, i) => BigInt(i + 1)));
  const sizes: number[] = [];
  let inFlight = 0;
  let peak = 0;
  const blocked: Array<() => void> = [];
  const rpc = stubRpc({
    getLedgerEntries: async (...keys) => {
      sizes.push(keys.length);
      return echoLive(keys);
    },
    simulateTransaction: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => {
        blocked.push(resolve);
      });
      inFlight -= 1;
      return { results: [{ xdr: orderXdr() }] };
    },
  });
  let rows: OpenOrder[] | undefined;
  const resultP = loadOpenOrders(rpc, CONTRACT, SOURCE, SEQUENCE, MARKET, OWNER, []);
  void resultP.then((r) => {
    rows = r;
  });
  const deadline = Date.now() + 25000;
  while (rows == null) {
    if (Date.now() > deadline) throw new Error("timed out waiting for loadOpenOrders");
    await new Promise((r) => setTimeout(r, 0));
    expect(peak).toBeLessThanOrEqual(4);
    if (blocked.length) {
      expect(blocked.length).toBeLessThanOrEqual(4);
      const batch = blocked.splice(0, blocked.length);
      for (const release of batch) release();
    }
  }
  expect(sizes).toEqual([200, 50]);
  expect(peak).toBeLessThanOrEqual(4);
  expect(rows.length).toBe(count);
  expect(rows.map((r) => r.nonce.toString())).toEqual(Array.from({ length: count }, (_, i) => String(i + 1)));
}, 30000);

test("loadOpenOrders discovery is not capped at 20", async () => {
  const count = 25;
  seed(Array.from({ length: count }, (_, i) => BigInt(i + 1)));
  const rpc = stubRpc({
    getLedgerEntries: async (...keys) => echoLive(keys),
  });
  const rows = await loadOpenOrders(rpc, CONTRACT, SOURCE, SEQUENCE, MARKET, OWNER, []);
  expect(rows.length).toBe(25);
});
