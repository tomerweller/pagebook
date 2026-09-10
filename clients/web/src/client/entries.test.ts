import { expect, test } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { contractScVal, entryData, entryDataSize, indexByKey, RpcShapeError } from "./entries";

const CONTRACT = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO";

function contractEntryXdr(): { xdr: string; key: string } {
  const key = StellarSdk.xdr.LedgerKey.contractData(
    new StellarSdk.xdr.LedgerKeyContractData({
      contract: new StellarSdk.Address(CONTRACT).toScAddress(),
      key: StellarSdk.xdr.ScVal.scvSymbol("Market"),
      durability: StellarSdk.xdr.ContractDataDurability.persistent(),
    }),
  );
  const data = StellarSdk.xdr.LedgerEntryData.contractData(
    new StellarSdk.xdr.ContractDataEntry({
      ext: new StellarSdk.xdr.ExtensionPoint(0),
      contract: new StellarSdk.Address(CONTRACT).toScAddress(),
      key: StellarSdk.xdr.ScVal.scvSymbol("Market"),
      durability: StellarSdk.xdr.ContractDataDurability.persistent(),
      val: StellarSdk.xdr.ScVal.scvU32(7),
    }),
  );
  return { xdr: data.toXDR("base64"), key: key.toXDR("base64") };
}

test("entryData decodes LedgerEntryData and entryDataSize matches XDR length", () => {
  const { xdr, key } = contractEntryXdr();
  const data = entryData({ key, xdr });
  expect(data.switch().name).toBe("contractData");
  expect(entryDataSize({ key, xdr })).toBe(data.toXDR().length);
  expect(StellarSdk.scValToNative(contractScVal({ key, xdr })!)).toBe(7);
});

test("missing xdr throws RpcShapeError naming the key", () => {
  const key = "abc=";
  expect(() => entryData({ key })).toThrow(RpcShapeError);
  expect(() => entryData({ key })).toThrow(key);
});

test("garbage xdr throws RpcShapeError naming the key", () => {
  const key = "xyz=";
  expect(() => entryData({ key, xdr: "!!!!" })).toThrow(RpcShapeError);
  expect(() => entryData({ key, xdr: "!!!!" })).toThrow(key);
});

test("indexByKey keys by base64", () => {
  const { xdr, key } = contractEntryXdr();
  const map = indexByKey([{ key, xdr }, { xdr }]);
  expect(map.get(key)?.xdr).toBe(xdr);
  expect(map.size).toBe(1);
});
