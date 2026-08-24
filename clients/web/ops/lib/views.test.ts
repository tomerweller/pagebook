import { expect, test } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { createViews, parseLevel, parseOrder } from "./views";

test("parseLevel throws on a null or absent native", () => {
  expect(() => parseLevel(null)).toThrow(/empty Level view/);
  expect(() => parseLevel(undefined)).toThrow(/empty Level view/);
  expect(parseLevel({ generation: 1, open_lots: 4 }).open_lots).toBe(4);
});

test("parseOrder throws on a null native rather than fabricating zeros", () => {
  expect(() => parseOrder(null)).toThrow(/empty Order view/);
  expect(() => parseOrder(undefined)).toThrow(/empty Order view/);
  expect(parseOrder({ tick: 10, filled_lots: 3 }).filled_lots).toBe(3);
});

test("view simulations use sequence 0 and skip the account read", async () => {
  let sawGet = false;
  const source = StellarSdk.Keypair.random().publicKey();
  const views = createViews(
    {
      getLedgerEntries: async () => {
        sawGet = true;
        return { entries: [] };
      },
      simulateTransaction: async () => ({ error: "HostError: Error(Contract, #15)" }),
    } as never,
    {
      contract: "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO",
      source,
      market: 0,
      owner: source,
    },
  );
  expect(await views.order(1)).toBeNull();
  expect(sawGet).toBe(false);
  await expect(views.level(true, 10)).rejects.toThrow();
});
