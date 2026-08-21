import * as StellarSdk from "@stellar/stellar-sdk";
import { ck, instanceKey, orderKey, sacBalanceKey, type LedgerKeyWrap } from "../keys";

export type Hex32 = string;

export type ClientKey =
  | { t: "Config" }
  | { t: "Market"; market: number }
  | { t: "Level"; market: number; isBid: boolean; tick: number }
  | { t: "LevelPage"; market: number; isBid: boolean; tick: number; page: number }
  | { t: "Order"; market: number; owner: Hex32; nonce: bigint }
  | { t: "FeeAccrual"; market: number; token: Hex32 }
  | { t: "BestTick"; market: number; isBid: boolean }
  | { t: "TickSummary"; market: number; isBid: boolean }
  | { t: "TickWord"; market: number; isBid: boolean; word: number }
  | { t: "VaultBalance"; token: Hex32 }
  | { t: "UserBalance"; token: Hex32 };

export type KeyContext = {
  contract: string;
  caller: string;
};

export function hex32(bytes: Uint8Array): Hex32 {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseHex32(h: Hex32): Uint8Array {
  if (h.length !== 64 || !/^[0-9a-f]+$/i.test(h)) throw new Error(`bad hex32: ${h}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function addrToHex(addr: string): Hex32 {
  if (addr.startsWith("G")) return hex32(StellarSdk.StrKey.decodeEd25519PublicKey(addr));
  if (addr.startsWith("C")) return hex32(StellarSdk.StrKey.decodeContract(addr));
  throw new Error(`unsupported address: ${addr}`);
}

export function hexToAccount(h: Hex32): string {
  return StellarSdk.StrKey.encodeEd25519PublicKey(parseHex32(h));
}

export function hexToContract(h: Hex32): string {
  return StellarSdk.StrKey.encodeContract(parseHex32(h));
}

export function keyStr(k: ClientKey): string {
  switch (k.t) {
    case "Config":
      return "Config";
    case "Market":
      return `Market(${k.market})`;
    case "Level":
      return `Level(${k.market},${k.isBid},${k.tick})`;
    case "LevelPage":
      return `LevelPage(${k.market},${k.isBid},${k.tick},${k.page})`;
    case "Order":
      return `Order(${k.market},${k.owner},${k.nonce})`;
    case "FeeAccrual":
      return `FeeAccrual(${k.market},${k.token})`;
    case "BestTick":
      return `BestTick(${k.market},${k.isBid})`;
    case "TickSummary":
      return `TickSummary(${k.market},${k.isBid})`;
    case "TickWord":
      return `TickWord(${k.market},${k.isBid},${k.word})`;
    case "VaultBalance":
      return `VaultBalance(${k.token})`;
    case "UserBalance":
      return `UserBalance(${k.token})`;
  }
}

export function sortedKeyStrs(keys: ClientKey[]): string[] {
  return keys.map(keyStr).sort();
}

export function sameKey(a: ClientKey, b: ClientKey): boolean {
  return keyStr(a) === keyStr(b);
}

export function toLedgerKey(ctx: KeyContext, k: ClientKey): LedgerKeyWrap {
  switch (k.t) {
    case "Config":
      return instanceKey(ctx.contract);
    case "Market":
      return ck(ctx.contract, "Market", k.market);
    case "Level":
      return ck(ctx.contract, "Level", k.market, k.isBid, k.tick);
    case "LevelPage":
      return ck(ctx.contract, "LevelPage", k.market, k.isBid, k.tick, k.page);
    case "Order":
      return orderKey(ctx.contract, k.market, hexToAccount(k.owner), k.nonce);
    case "FeeAccrual":
      return ck(ctx.contract, "FeeAccrual", k.market, hexToContract(k.token));
    case "BestTick":
      return ck(ctx.contract, "BestTick", k.market, k.isBid);
    case "TickSummary":
      return ck(ctx.contract, "TickSummary", k.market, k.isBid);
    case "TickWord":
      return ck(ctx.contract, "TickWord", k.market, k.isBid, k.word);
    case "VaultBalance":
      return sacBalanceKey(hexToContract(k.token), ctx.contract);
    case "UserBalance":
      return sacBalanceKey(hexToContract(k.token), ctx.caller);
  }
}
