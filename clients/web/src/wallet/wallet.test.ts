import { expect, test } from "vitest";
import { spendableXlm, parseAssetFromSacName, BASE_RESERVE_STROOPS } from "./account";
import { Keystore, STORAGE_KEY, deriveFromSeed, SEED_NAME, type StorageLike } from "./keystore";
import { isTestnetPassphrase, NETWORK_PASSPHRASE, checkTestnet } from "./network";
import type { Rpc } from "../book";
import { missingCredits, planProvision } from "./provision";
import type { CreditAsset } from "./account";

function memStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
}

test("seed derivation is deterministic", () => {
  const a = deriveFromSeed("m2-smoke-1");
  const b = deriveFromSeed("m2-smoke-1");
  expect(a.publicKey).toBe("GCREM3GBKZPWQWDC7EXV6XIT46I5ZWO7WDOHPHBP3YNSJITWVWEQNY2M");
  expect(a.publicKey).toBe(b.publicKey);
  expect(a.secret).toBe(b.secret);
  expect(a.name).toBe(SEED_NAME);
  expect(deriveFromSeed("m2-smoke-2").publicKey).toBe("GAAG4TZXYYIKGIQOLU4U4MMQJYLLQHIPPW6CO23RKNL4NVY4LJV7DETV");
});

test("keystore round-trip in mocked localStorage", () => {
  const storage = memStorage();
  const ks = new Keystore(storage);
  const created = ks.create("alpha");
  expect(created.publicKey.startsWith("G")).toBe(true);
  expect(ks.active()?.name).toBe("alpha");
  expect(ks.list().map((i) => i.name)).toEqual(["alpha"]);

  const again = new Keystore(storage);
  expect(again.list()).toEqual([created]);
  expect(again.active()).toEqual(created);

  const imported = again.importSecret(created.secret, "copy");
  expect(imported.publicKey).toBe(created.publicKey);
  expect(again.list().length).toBe(2);
  again.select("alpha");
  again.rename("alpha", "renamed");
  expect(again.active()?.name).toBe("renamed");
  again.remove("renamed");
  expect(again.list().map((i) => i.name)).toEqual(["copy"]);
  expect(again.active()?.name).toBe("copy");

  const raw = storage.getItem(STORAGE_KEY);
  expect(raw).toBeTruthy();
  expect(JSON.parse(raw!).identities.length).toBe(1);
});

test("seed identity is ephemeral until saved", () => {
  const storage = memStorage();
  const ks = new Keystore(storage);
  const seed = ks.activateSeed("m2-smoke-1");
  expect(seed.name).toBe(SEED_NAME);
  expect(ks.active()?.publicKey).toBe("GCREM3GBKZPWQWDC7EXV6XIT46I5ZWO7WDOHPHBP3YNSJITWVWEQNY2M");
  expect(storage.getItem(STORAGE_KEY)).toBeNull();
  const saved = ks.saveEphemeral("kept");
  expect(saved.name).toBe("kept");
  expect(ks.isEphemeralActive()).toBe(false);
  const raw = JSON.parse(storage.getItem(STORAGE_KEY)!);
  expect(raw.identities[0].publicKey).toBe(seed.publicKey);
  expect(raw.identities[0].name).toBe("kept");
});

test("asset parse from SAC names", () => {
  expect(parseAssetFromSacName("native")).toEqual({ type: "native" });
  expect(parseAssetFromSacName("USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5")).toEqual({
    type: "credit",
    code: "USDC",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  });
  expect(() => parseAssetFromSacName("")).toThrow(/malformed/);
  expect(() => parseAssetFromSacName("USDC")).toThrow(/malformed/);
  expect(() => parseAssetFromSacName("USDC:")).toThrow(/malformed/);
  expect(() => parseAssetFromSacName(":GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5")).toThrow(/malformed/);
  expect(() => parseAssetFromSacName("USDC:not-an-issuer")).toThrow(/malformed/);
});

test("spendable XLM uses 2 base plus per-subentry reserve", () => {
  expect(BASE_RESERVE_STROOPS).toBe(5_000_000n);
  expect(spendableXlm(10_000_000_000n, 0)).toBe(9_990_000_000n);
  expect(spendableXlm(10_000_000_000n, 1)).toBe(9_985_000_000n);
  expect(spendableXlm(10_000_000n, 0)).toBe(0n);
  expect(spendableXlm(15_000_000n, 1)).toBe(0n);
  expect(spendableXlm(15_000_001n, 1)).toBe(1n);
  expect(spendableXlm(0n, 0)).toBe(0n);
});

test("passphrase compare enables only testnet", () => {
  expect(isTestnetPassphrase(NETWORK_PASSPHRASE)).toBe(true);
  expect(isTestnetPassphrase("Public Global Stellar Network ; September 2015")).toBe(false);
  expect(isTestnetPassphrase("")).toBe(false);
});

test("checkTestnet rejects a non-testnet passphrase from RPC", async () => {
  const rpc = {
    getNetwork: async () => ({ passphrase: "Public Global Stellar Network ; September 2015" }),
  } as unknown as Rpc;
  const res = await checkTestnet(rpc);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toBe("wallet disabled: not testnet");
});

const USDC: CreditAsset = {
  type: "credit",
  code: "USDC",
  issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
};

test("provision planner: missing account funds then trusts", () => {
  expect(planProvision({ source: "generate", accountExists: false, missing: [USDC] })).toEqual([
    { op: "fund" },
    { op: "trust", asset: USDC },
  ]);
  expect(planProvision({ source: "seed", accountExists: false, missing: [USDC] })).toEqual([
    { op: "fund" },
    { op: "trust", asset: USDC },
  ]);
});

test("provision planner: funded without trustline only trusts", () => {
  expect(planProvision({ source: "generate", accountExists: true, missing: [USDC] })).toEqual([{ op: "trust", asset: USDC }]);
});

test("provision planner: fully provisioned is empty", () => {
  expect(planProvision({ source: "seed", accountExists: true, missing: [] })).toEqual([]);
});

test("provision planner: import never plans", () => {
  expect(planProvision({ source: "import", accountExists: false, missing: [USDC] })).toEqual([]);
  expect(planProvision({ source: "import", accountExists: true, missing: [USDC] })).toEqual([]);
});

test("missingCredits skips present trustlines", () => {
  const pba: CreditAsset = { type: "credit", code: "PBA", issuer: USDC.issuer };
  expect(missingCredits([USDC, pba], [{ asset: USDC, exists: true }])).toEqual([pba]);
  expect(missingCredits([USDC], [{ asset: USDC, exists: false }])).toEqual([USDC]);
});

test("checkTestnet accepts the testnet passphrase", async () => {
  const rpc = {
    getNetwork: async () => ({ passphrase: NETWORK_PASSPHRASE }),
  } as unknown as Rpc;
  const res = await checkTestnet(rpc);
  expect(res.ok).toBe(true);
});
