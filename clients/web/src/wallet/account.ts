import * as StellarSdk from "@stellar/stellar-sdk";
import type { Rpc, RpcLedgerEntry } from "../book";
import { toBigInt } from "../decode";

export const BASE_RESERVE_STROOPS = 5_000_000n;

export type NativeAsset = { type: "native" };
export type CreditAsset = { type: "credit"; code: string; issuer: string };
export type ClassicAsset = NativeAsset | CreditAsset;

export type AccountState = {
  exists: boolean;
  balance: bigint;
  spendable: bigint;
  sequence: bigint;
  numSubEntries: number;
};

export type TrustlineState = {
  asset: CreditAsset;
  exists: boolean;
  balance: bigint;
};

export function spendableXlm(balance: bigint, numSubEntries: number): bigint {
  const reserved = (2n + BigInt(numSubEntries)) * BASE_RESERVE_STROOPS;
  const out = balance - reserved;
  return out < 0n ? 0n : out;
}

export function parseAssetFromSacName(name: string): ClassicAsset {
  if (name === "native") return { type: "native" };
  const colon = name.indexOf(":");
  if (colon <= 0 || colon === name.length - 1) throw new Error(`malformed SAC name: ${name}`);
  const code = name.slice(0, colon);
  const issuer = name.slice(colon + 1);
  if (!/^[A-Za-z0-9]{1,12}$/.test(code) || issuer.length !== 56 || issuer[0] !== "G") {
    throw new Error(`malformed SAC name: ${name}`);
  }
  return { type: "credit", code, issuer };
}

function ledgerData(entry: RpcLedgerEntry): StellarSdk.xdr.LedgerEntryData | null {
  if (entry.val && typeof entry.val === "object" && "switch" in entry.val && typeof entry.val.switch === "function") {
    return entry.val;
  }
  const raw = entry.xdr || (typeof entry.val === "string" ? entry.val : null);
  if (!raw) return null;
  try {
    return StellarSdk.xdr.LedgerEntryData.fromXDR(raw, "base64");
  } catch {
    try {
      return StellarSdk.xdr.LedgerEntry.fromXDR(raw, "base64").data();
    } catch {
      return null;
    }
  }
}

export function accountLedgerKey(pubkey: string): StellarSdk.xdr.LedgerKey {
  const kp = StellarSdk.Keypair.fromPublicKey(pubkey);
  return StellarSdk.xdr.LedgerKey.account(new StellarSdk.xdr.LedgerKeyAccount({ accountId: kp.xdrAccountId() }));
}

export function trustlineLedgerKey(pubkey: string, asset: CreditAsset): StellarSdk.xdr.LedgerKey {
  const kp = StellarSdk.Keypair.fromPublicKey(pubkey);
  const a = new StellarSdk.Asset(asset.code, asset.issuer);
  return StellarSdk.xdr.LedgerKey.trustline(
    new StellarSdk.xdr.LedgerKeyTrustLine({
      accountId: kp.xdrAccountId(),
      asset: a.toTrustLineXDRObject(),
    }),
  );
}

function emptyAccount(): AccountState {
  return { exists: false, balance: 0n, spendable: 0n, sequence: 0n, numSubEntries: 0 };
}

export async function readAccount(rpc: Rpc, pubkey: string): Promise<AccountState> {
  const res = await rpc.getLedgerEntries(accountLedgerKey(pubkey));
  const entry = res.entries?.[0];
  if (!entry) return emptyAccount();
  const data = ledgerData(entry);
  if (!data) return emptyAccount();
  try {
    if (data.switch().name !== "account") return emptyAccount();
    const acc = data.account();
    const balance = toBigInt(acc.balance());
    const sequence = toBigInt(acc.seqNum());
    const numSubEntries = Number(acc.numSubEntries());
    return {
      exists: true,
      balance,
      spendable: spendableXlm(balance, numSubEntries),
      sequence,
      numSubEntries,
    };
  } catch {
    return emptyAccount();
  }
}

export async function readTrustline(rpc: Rpc, pubkey: string, asset: CreditAsset): Promise<TrustlineState> {
  const res = await rpc.getLedgerEntries(trustlineLedgerKey(pubkey, asset));
  const entry = res.entries?.[0];
  if (!entry) return { asset, exists: false, balance: 0n };
  const data = ledgerData(entry);
  if (!data) return { asset, exists: false, balance: 0n };
  try {
    if (data.switch().name !== "trustline") return { asset, exists: false, balance: 0n };
    const tl = data.trustLine();
    return { asset, exists: true, balance: toBigInt(tl.balance()) };
  } catch {
    return { asset, exists: false, balance: 0n };
  }
}

export async function readTrustlines(rpc: Rpc, pubkey: string, assets: CreditAsset[]): Promise<TrustlineState[]> {
  if (!assets.length) return [];
  const keys = assets.map((a) => trustlineLedgerKey(pubkey, a));
  const res = await rpc.getLedgerEntries(...keys);
  const found = new Set<string>();
  const out: TrustlineState[] = [];
  for (const entry of res.entries ?? []) {
    const data = ledgerData(entry);
    if (!data) continue;
    try {
      if (data.switch().name !== "trustline") continue;
      const tl = data.trustLine();
      const xdrAsset = tl.asset();
      let asset: CreditAsset | null = null;
      if (xdrAsset.switch().name === "assetTypeCreditAlphanum4") {
        const a4 = xdrAsset.alphaNum4();
        asset = { type: "credit", code: a4.assetCode().toString().replace(/\0+$/, ""), issuer: issuerFromAccountId(a4.issuer()) };
      } else if (xdrAsset.switch().name === "assetTypeCreditAlphanum12") {
        const a12 = xdrAsset.alphaNum12();
        asset = { type: "credit", code: a12.assetCode().toString().replace(/\0+$/, ""), issuer: issuerFromAccountId(a12.issuer()) };
      }
      if (!asset) continue;
      found.add(`${asset.code}:${asset.issuer}`);
      out.push({ asset, exists: true, balance: toBigInt(tl.balance()) });
    } catch {
      continue;
    }
  }
  for (const a of assets) {
    if (!found.has(`${a.code}:${a.issuer}`)) out.push({ asset: a, exists: false, balance: 0n });
  }
  return out;
}

function issuerFromAccountId(accountId: StellarSdk.xdr.AccountId): string {
  return StellarSdk.StrKey.encodeEd25519PublicKey(accountId.ed25519());
}
