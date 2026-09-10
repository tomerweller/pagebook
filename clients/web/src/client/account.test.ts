import { expect, test } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { readAccount } from "./account";
import { RpcShapeError } from "./entries";
import type { Rpc } from "./rpc";

function accountDataXdr(pubkey: string, seq = "10"): string {
  const kp = StellarSdk.Keypair.fromPublicKey(pubkey);
  const acc = new StellarSdk.xdr.AccountEntry({
    accountId: kp.xdrAccountId(),
    balance: new StellarSdk.xdr.Int64(10_000_000_000),
    seqNum: new StellarSdk.xdr.Int64(Number(seq)) as never,
    numSubEntries: 0,
    inflationDest: null,
    flags: 0,
    homeDomain: "",
    thresholds: Uint8Array.from([1, 0, 0, 0]) as never,
    signers: [],
    ext: new StellarSdk.xdr.AccountEntryExt(0),
  });
  return StellarSdk.xdr.LedgerEntryData.account(acc).toXDR("base64");
}

function rpcWithEntries(entries: { key?: string; xdr?: string }[]): Rpc {
  return {
    getLatestLedger: async () => ({ sequence: 1 }),
    getLedgerEntries: async () => ({ entries, latestLedger: 1 }),
    getEvents: async () => ({ events: [] }),
    getNetwork: async () => ({ passphrase: "Test SDF Network ; September 2015" }),
    sendTransaction: async () => ({ status: "PENDING" }),
    getTransaction: async () => ({ status: "NOT_FOUND" }),
    simulateTransaction: async () => ({}),
  };
}

test("readAccount returns balance, sequence, and spendable from a real entry", async () => {
  const kp = StellarSdk.Keypair.random();
  const key = StellarSdk.xdr.LedgerKey.account(
    new StellarSdk.xdr.LedgerKeyAccount({ accountId: kp.xdrAccountId() }),
  ).toXDR("base64");
  const acc = await readAccount(rpcWithEntries([{ key, xdr: accountDataXdr(kp.publicKey(), "42") }]), kp.publicKey());
  expect(acc.exists).toBe(true);
  expect(acc.balance).toBe(10_000_000_000n);
  expect(acc.sequence).toBe(42n);
  expect(acc.spendable).toBe(acc.balance - 10_000_000n);
});

test("readAccount rejects a malformed entry with RpcShapeError", async () => {
  const kp = StellarSdk.Keypair.random();
  const key = "acct-key";
  await expect(readAccount(rpcWithEntries([{ key, xdr: "!!!!" }]), kp.publicKey())).rejects.toBeInstanceOf(RpcShapeError);
  await expect(readAccount(rpcWithEntries([{ key }]), kp.publicKey())).rejects.toThrow(key);
});

test("readAccount returns exists: false when no entry", async () => {
  const kp = StellarSdk.Keypair.random();
  const acc = await readAccount(rpcWithEntries([]), kp.publicKey());
  expect(acc).toEqual({ exists: false, balance: 0n, spendable: 0n, sequence: 0n, numSubEntries: 0 });
});
