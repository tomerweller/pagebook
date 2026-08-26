import { expect, test } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { ck } from "../../src/keys";
import { classifyLiveness, sweepPadSizes } from "./padkeys";

test("classifyLiveness splits live, archived, and nonexistent", () => {
  expect(classifyLiveness(undefined, 100, false)).toBe("nonexistent");
  expect(classifyLiveness(50, 100, true)).toBe("archived");
  expect(classifyLiveness(100, 100, true)).toBe("live");
  expect(classifyLiveness(200, 100, true)).toBe("live");
  expect(classifyLiveness(0, 100, true)).toBe("live");
});

test("sweepPadSizes records liveUntil and classifies against latestLedger", async () => {
  const contract = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO";
  const live = ck(contract, "Market", 1).xdr;
  const archived = ck(contract, "TickSummary", 1, false).xdr;
  const missing = ck(contract, "BestTick", 1, true).xdr;
  const rpc = {
    getLedgerEntries: async () => ({
      latestLedger: 200,
      entries: [
        { key: live.toXDR("base64"), xdr: StellarSdk.xdr.ScVal.scvVoid().toXDR("base64"), liveUntilLedgerSeq: 500 },
        { key: archived.toXDR("base64"), xdr: StellarSdk.xdr.ScVal.scvVoid().toXDR("base64"), liveUntilLedgerSeq: 150 },
      ],
    }),
  };
  const sizes = await sweepPadSizes(rpc as never, [live, archived, missing], { chunk: 100, coverBytes: false });
  expect(sizes.latestLedger).toBe(200);
  expect(sizes.sizeOf(live)?.liveness).toBe("live");
  expect(sizes.sizeOf(archived)?.liveness).toBe("archived");
  expect(sizes.sizeOf(missing)?.liveness).toBe("nonexistent");
  expect(sizes.coverBytes).toBe(false);
});
