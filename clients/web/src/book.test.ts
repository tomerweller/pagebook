import { expect, test } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { scanLevels } from "./book";
import { ck } from "./keys";
import type { LedgerKeyArg, Rpc } from "./client/rpc";

const CONTRACT = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO";

function levelEntry(tick: number, isBid: boolean, lots: bigint) {
  const key = ck(CONTRACT, "Level", 0, isBid, tick);
  const val = StellarSdk.nativeToScVal(
    {
      generation: 1,
      head_seq: 0,
      open_lots: lots,
      slots: [lots],
    },
    { type: { generation: ["symbol", "u32"], head_seq: ["symbol", "u32"], open_lots: ["symbol", "i128"], slots: ["symbol"] } },
  );
  const data = StellarSdk.xdr.LedgerEntryData.contractData(
    new StellarSdk.xdr.ContractDataEntry({
      ext: new StellarSdk.xdr.ExtensionPoint(0),
      contract: new StellarSdk.Address(CONTRACT).toScAddress(),
      key: key.xdr.contractData().key(),
      durability: StellarSdk.xdr.ContractDataDurability.persistent(),
      val,
    }),
  );
  return { key: key.base64, xdr: data.toXDR("base64") };
}

// The contract never deletes a Level, so an emptied one is still an entry with
// open_lots 0 — the phantom the scan has to walk past.
function fakeRpc(live: Map<number, bigint>, phantoms: number[], calls: string[][]): Rpc {
  return {
    async getLedgerEntries(...keys: LedgerKeyArg[]) {
      const wanted = keys.map((k) => (typeof k === "string" ? k : "base64" in k ? k.base64 : k.toXDR("base64")));
      calls.push(wanted);
      const entries: { key: string; xdr: string }[] = [];
      for (const tick of [...phantoms, ...live.keys()]) {
        const lots = live.get(tick) ?? 0n;
        const e = levelEntry(tick, false, lots);
        if (wanted.includes(e.key)) entries.push(e);
      }
      return { entries, latestLedger: 100 };
    },
  } as unknown as Rpc;
}

test("scanLevels finds a live level past a long trail of stale bits", async () => {
  const phantoms = Array.from({ length: 400 }, (_, i) => 17_854 + i).filter((t) => t !== 18_000);
  const live = new Map([[18_000, 3n]]);
  const calls: string[][] = [];
  const cands = [17_854, ...phantoms.filter((t) => t !== 17_854), 18_000].sort((a, b) => a - b);
  const res = await scanLevels(fakeRpc(live, phantoms, calls), {
    contract: CONTRACT,
    market: 0,
    depth: 12,
    sides: [{ isBid: false, cands, best: { empty: false, tick: 17_854 } }],
  });
  const side = res.sides[0];
  expect(side.rows.map((r) => r.tick)).toEqual([18_000]);
  expect(side.rows[0].open_lots).toBe(3n);
  expect(side.staleBest).toBe(true);
  // 18000 is candidate 146, so the first chunk alone cannot reach it.
  expect(calls.length).toBeGreaterThan(1);
  expect(side.scanned).toBeGreaterThan(146);
});

test("scanLevels stops after the first round once depth is met", async () => {
  const live = new Map<number, bigint>();
  for (let i = 0; i < 12; i++) live.set(17_854 + i, 5n);
  const calls: string[][] = [];
  const cands = Array.from({ length: 300 }, (_, i) => 17_854 + i);
  const res = await scanLevels(fakeRpc(live, [], calls), {
    contract: CONTRACT,
    market: 0,
    depth: 12,
    sides: [{ isBid: false, cands, best: { empty: false, tick: 17_854 } }],
  });
  expect(res.sides[0].rows).toHaveLength(12);
  expect(res.sides[0].staleBest).toBe(false);
  expect(calls).toHaveLength(1);
  expect(res.sides[0].scanned).toBe(96);
});

test("scanLevels leaves candidates unscanned when the trail outlives the rounds", async () => {
  const calls: string[][] = [];
  const cands = Array.from({ length: 900 }, (_, i) => 17_854 + i);
  const res = await scanLevels(fakeRpc(new Map(), cands, calls), {
    contract: CONTRACT,
    market: 0,
    depth: 12,
    sides: [{ isBid: false, cands, best: { empty: false, tick: 17_854 } }],
  });
  expect(res.sides[0].rows).toHaveLength(0);
  // Five rounds of 96, and the leftover candidates are what makes the view
  // say there are more levels beyond the read window.
  expect(res.sides[0].scanned).toBe(480);
  expect(res.sides[0].scanned).toBeLessThan(cands.length);
  expect(calls).toHaveLength(5);
});
