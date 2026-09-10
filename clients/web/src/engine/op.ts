import * as StellarSdk from "@stellar/stellar-sdk";
import { accountLedgerKey, trustlineLedgerKey } from "../client/account";
import { instanceKey, sacBalanceKey } from "../keys";
import { type PlannedLedgerKey } from "./clientKeys";
import type { DeclaredResources } from "./txdata";

export type PlaceFlags = {
  post_only: boolean;
  fill_or_kill: boolean;
  no_rest: boolean;
};

export type EnginePhase = "simulation" | "apply" | "send" | "prepare";
export type EngineOk = { kind: "ok"; hash: string; ledger?: number; fee?: string; resultMetaXdr?: string };
// `raisedBy` is the contract the diagnostic events attribute the error to,
// when they carry one. `foreign` means it was some contract other than the
// one invoked — for PageBook that can only be a token, so the code was
// decoded through the SAC error table instead of PageBook's.
export type EngineTyped = {
  kind: "typed";
  errorCode: number;
  errorName: string;
  at: "simulation" | "apply";
  hash?: string;
  raisedBy?: string;
  foreign?: boolean;
};
export type EngineFootprint = { kind: "footprint"; missingKey?: string; hash?: string; at?: EnginePhase };
export type EngineBadSeq = { kind: "txBadSeq"; message: string; hash?: string; reachedLedger?: boolean; at?: EnginePhase };
export type EngineResourceLimit = {
  kind: "resourceLimit";
  message: string;
  hash?: string;
  at?: EnginePhase;
  declared?: DeclaredResources;
};
export type EngineSorobanInvalid = { kind: "sorobanInvalid"; message: string; hash?: string; at?: EnginePhase };
export type EngineTimeout = { kind: "timeout"; message: string; hash: string };
export type EngineRpc = { kind: "rpc"; message: string; hash?: string; at?: EnginePhase };
export type EngineTrapped = { kind: "trapped"; message?: string; hash?: string; at?: EnginePhase };
export type EngineArchived = {
  kind: "archived";
  keyName: string;
  keyXdr: string;
  at: "apply" | "simulation";
  hash?: string;
};
export type EngineBody =
  | EngineOk
  | EngineTyped
  | EngineFootprint
  | EngineBadSeq
  | EngineResourceLimit
  | EngineSorobanInvalid
  | EngineTimeout
  | EngineRpc
  | EngineTrapped
  | EngineArchived;
export type EngineResult = EngineBody & { declared?: DeclaredResources };

export type ClassicToken = { sac: string; code?: string; issuer?: string };

export function tokenExtraKeys(pagebook: string, caller: string, tokens: ClassicToken[]): PlannedLedgerKey[] {
  const keys: PlannedLedgerKey[] = [];
  for (const t of tokens) {
    keys.push({ key: instanceKey(t.sac).xdr, access: "ro" });
    keys.push({ key: sacBalanceKey(t.sac, pagebook).xdr, access: "rw" });
    if (t.code && t.issuer) {
      keys.push({ key: trustlineLedgerKey(caller, { type: "credit", code: t.code, issuer: t.issuer }), access: "rw" });
    } else {
      keys.push({ key: accountLedgerKey(caller), access: "rw" });
    }
  }
  return keys;
}

export function scvU32(n: number): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvU32(n);
}

export function scvBool(b: boolean): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvBool(b);
}

export function scvU64(n: bigint): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(n, { type: "u64" });
}

export function scvAddr(a: string): StellarSdk.xdr.ScVal {
  return new StellarSdk.Address(a).toScVal();
}

function scvSym(s: string): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvSymbol(s);
}

function scvMap(entries: [string, StellarSdk.xdr.ScVal][]): StellarSdk.xdr.ScVal {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return StellarSdk.xdr.ScVal.scvMap(
    sorted.map(([k, v]) => new StellarSdk.xdr.ScMapEntry({ key: scvSym(k), val: v })),
  );
}

export function scPlaceFlags(f: PlaceFlags): StellarSdk.xdr.ScVal {
  return scvMap([
    ["post_only", scvBool(f.post_only)],
    ["fill_or_kill", scvBool(f.fill_or_kill)],
    ["no_rest", scvBool(f.no_rest)],
  ]);
}

export function scReplaceItem(item: {
  nonce: bigint;
  isBid: boolean;
  tick: number;
  qtyLots: bigint;
}): StellarSdk.xdr.ScVal {
  return scvMap([
    ["nonce", scvU64(item.nonce)],
    ["is_bid", scvBool(item.isBid)],
    ["tick", scvU32(item.tick)],
    ["qty_lots", scvU64(item.qtyLots)],
  ]);
}

export type PlaceArgParams = {
  taker: string;
  market: number;
  isBid: boolean;
  limitTick: number;
  qtyLots: bigint;
  startTick: number;
  nonce: bigint;
  flags: PlaceFlags;
};

export function buildPlaceArgs(opts: PlaceArgParams): StellarSdk.xdr.ScVal[] {
  return [
    scvAddr(opts.taker),
    scvU32(opts.market),
    scvBool(opts.isBid),
    scvU32(opts.limitTick),
    scvU64(opts.qtyLots),
    scvU32(opts.startTick),
    scvU64(opts.nonce),
    scPlaceFlags(opts.flags),
  ];
}
