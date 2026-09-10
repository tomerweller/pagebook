import * as StellarSdk from "@stellar/stellar-sdk";
import { type LedgerKeyWrap } from "../keys";

export const MAX_KEYS = 200;

export type RpcLedgerEntry = {
  key?: string;
  xdr?: string;
  liveUntilLedgerSeq?: number;
};

export type RpcEvent = {
  id?: string;
  topic?: unknown[];
  topics?: unknown[];
  value?: unknown;
  ledger?: number;
  ledgerClosedAt?: string;
  txHash?: string;
  transactionHash?: string;
  pagingToken?: string;
};

export type GetEventsRequest = {
  filters?: unknown[];
  cursor?: string | null;
  limit?: number;
  startLedger?: number;
  endLedger?: number;
};

export type GetEventsResult = {
  events?: RpcEvent[];
  cursor?: string;
  oldestLedger?: number;
};

export type GetLedgerEntriesResult = {
  entries?: RpcLedgerEntry[];
  latestLedger?: number;
};

export type LedgerKeyArg = string | LedgerKeyWrap | StellarSdk.xdr.LedgerKey;

export type GetNetworkResult = {
  passphrase: string;
  friendbotUrl?: string;
  protocolVersion?: string | number;
};

export type SendTransactionResult = {
  status: string;
  hash?: string;
  errorResultXdr?: string;
  errorResult?: unknown;
  message?: string;
};

export type GetTransactionResult = {
  status: string;
  txHash?: string;
  envelopeXdr?: string;
  resultXdr?: string;
  resultMetaXdr?: string;
  diagnosticEventsXdr?: string[];
  ledger?: number;
  feeCharged?: number | string;
};

export type SimulateTransactionResult = {
  transactionData?: string;
  minResourceFee?: string | number;
  results?: { xdr?: string }[];
  error?: unknown;
  restorePreamble?: { transactionData?: string; minResourceFee?: string | number };
  latestLedger?: number;
  events?: unknown[];
  stateChanges?: unknown[];
};

export type Rpc = {
  getLatestLedger(): Promise<{ sequence: number }>;
  getLedgerEntries(...keys: LedgerKeyArg[]): Promise<GetLedgerEntriesResult>;
  getEvents(request: GetEventsRequest): Promise<GetEventsResult>;
  getNetwork(): Promise<GetNetworkResult>;
  sendTransaction(transaction: string): Promise<SendTransactionResult>;
  getTransaction(hash: string): Promise<GetTransactionResult>;
  simulateTransaction(transaction: string): Promise<SimulateTransactionResult>;
};

function isKeyWrap(k: LedgerKeyWrap | StellarSdk.xdr.LedgerKey): k is LedgerKeyWrap {
  return "base64" in k && typeof (k as LedgerKeyWrap).base64 === "string";
}

export function encodeKey(k: LedgerKeyArg): string {
  if (typeof k === "string") return k;
  if (isKeyWrap(k)) return k.base64;
  return k.toXDR("base64");
}

export class RpcError extends Error {
  code?: number;
  data?: unknown;
  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export function createRpc(url: string): Rpc {
  let nextId = 1;
  async function call(method: string, params: unknown = null): Promise<unknown> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method,
        params: params ?? null,
      }),
    });
    const body = (await res.json()) as {
      error?: { message?: string; code?: number; data?: unknown };
      result?: unknown;
    };
    if (body.error) {
      throw new RpcError(body.error.message || JSON.stringify(body.error), body.error.code, body.error.data);
    }
    return body.result;
  }
  return {
    getLatestLedger() {
      return call("getLatestLedger") as Promise<{ sequence: number }>;
    },
    getLedgerEntries(...keys) {
      return call("getLedgerEntries", { keys: keys.map(encodeKey) }) as Promise<GetLedgerEntriesResult>;
    },
    getEvents(request) {
      return call("getEvents", {
        filters: request.filters ?? [],
        pagination: {
          ...(request.cursor ? { cursor: request.cursor } : {}),
          ...(request.limit ? { limit: request.limit } : {}),
        },
        ...(request.startLedger ? { startLedger: request.startLedger } : {}),
        ...(request.endLedger ? { endLedger: request.endLedger } : {}),
      }) as Promise<GetEventsResult>;
    },
    getNetwork() {
      return call("getNetwork") as Promise<GetNetworkResult>;
    },
    sendTransaction(transaction) {
      return call("sendTransaction", { transaction }) as Promise<SendTransactionResult>;
    },
    getTransaction(hash) {
      return call("getTransaction", { hash }) as Promise<GetTransactionResult>;
    },
    simulateTransaction(transaction) {
      return call("simulateTransaction", { transaction }) as Promise<SimulateTransactionResult>;
    },
  };
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function fetchEntries(rpc: Rpc, keys: LedgerKeyWrap[]): Promise<{ entries: RpcLedgerEntry[]; latestLedger: number }> {
  if (!keys.length) return { entries: [], latestLedger: 0 };
  const all: RpcLedgerEntry[] = [];
  let latestLedger = 0;
  for (const group of chunk(keys, MAX_KEYS)) {
    const args = group.map((k) => k.xdr);
    const res = await rpc.getLedgerEntries(...args);
    latestLedger = res.latestLedger ?? latestLedger;
    all.push(...(res.entries ?? []));
  }
  return { entries: all, latestLedger };
}

export function entryKeyB64(entry: RpcLedgerEntry): string | null {
  return entry.key ?? null;
}
