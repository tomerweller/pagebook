import * as StellarSdk from "@stellar/stellar-sdk";
import type { Rpc } from "../book";
import { NETWORK_PASSPHRASE } from "../wallet/network";
import { addrToHex } from "./clientKeys";
import type { CrossedLevel, Quoted } from "./pad";

export type SimResult = {
  transactionData?: string;
  minResourceFee?: string;
  results?: { xdr?: string }[];
  error?: string;
  restorePreamble?: { transactionData?: string; minResourceFee?: string };
  latestLedger?: number;
  raw: unknown;
};

export async function simulate(rpc: Rpc, txXdr: string): Promise<SimResult> {
  const raw = await rpc.simulateTransaction(txXdr);
  const rec = raw as Record<string, unknown>;
  const error = typeof rec.error === "string" ? rec.error : rec.error != null ? JSON.stringify(rec.error) : undefined;
  const results = Array.isArray(rec.results) ? (rec.results as { xdr?: string }[]) : undefined;
  const restore = rec.restorePreamble as { transactionData?: string; minResourceFee?: string } | undefined;
  return {
    transactionData: typeof rec.transactionData === "string" ? rec.transactionData : undefined,
    minResourceFee: rec.minResourceFee != null ? String(rec.minResourceFee) : undefined,
    results,
    error,
    restorePreamble: restore,
    latestLedger: typeof rec.latestLedger === "number" ? rec.latestLedger : undefined,
    raw,
  };
}

export type QuotePlaceOpts = {
  contract: string;
  source: string;
  sequence: string;
  market: number;
  isBid: boolean;
  limitTick: number;
  qty: bigint;
};

export type QuoteOpts = QuotePlaceOpts & {
  taker: string;
  nonce: bigint;
  base: string;
  quote: string;
};

function parseCrossed(raw: unknown): CrossedLevel[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      tick: Number(r.tick),
      headSeq: Number(r.head_seq ?? r.headSeq),
      openLots: BigInt(String(r.open_lots ?? r.openLots ?? 0)),
    };
  });
}

export function parseQuoteResult(native: unknown): {
  startTick: number;
  crossed: CrossedLevel[];
  filledLots: bigint;
  quoteAtoms: bigint;
  tailSeq: number;
} {
  if (!native || typeof native !== "object") throw new Error("empty QuoteResult");
  const r = native as Record<string, unknown>;
  return {
    startTick: Number(r.start_tick ?? r.startTick),
    crossed: parseCrossed(r.crossed),
    filledLots: BigInt(String(r.filled_lots ?? r.filledLots ?? 0)),
    quoteAtoms: BigInt(String(r.quote_atoms ?? r.quoteAtoms ?? 0)),
    tailSeq: Number(r.tail_seq ?? r.tailSeq),
  };
}

export async function simulateQuotePlace(
  rpc: Rpc,
  opts: QuotePlaceOpts,
): Promise<{ parsed: ReturnType<typeof parseQuoteResult>; sim: SimResult }> {
  const contract = new StellarSdk.Contract(opts.contract);
  const account = new StellarSdk.Account(opts.source, opts.sequence);
  const op = contract.call(
    "quote_place",
    StellarSdk.nativeToScVal(opts.market, { type: "u32" }),
    StellarSdk.nativeToScVal(opts.isBid),
    StellarSdk.nativeToScVal(opts.limitTick, { type: "u32" }),
    StellarSdk.nativeToScVal(opts.qty, { type: "u64" }),
  );
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();
  const sim = await simulate(rpc, tx.toXDR());
  if (sim.error) throw new Error(sim.error);
  const retval = sim.results?.[0]?.xdr;
  if (!retval) throw new Error("quote_place returned no value");
  const scv = StellarSdk.xdr.ScVal.fromXDR(retval, "base64");
  return { parsed: parseQuoteResult(StellarSdk.scValToNative(scv) as unknown), sim };
}

export async function simulatePlace(rpc: Rpc, opts: QuoteOpts): Promise<{ quoted: Quoted; sim: SimResult; filledLots: bigint; quoteAtoms: bigint }> {
  const { parsed, sim } = await simulateQuotePlace(rpc, opts);
  return {
    quoted: {
      market: opts.market,
      ownSide: opts.isBid,
      limitTick: opts.limitTick,
      startTick: parsed.startTick,
      crossed: parsed.crossed,
      tailSeq: parsed.tailSeq,
      taker: addrToHex(opts.taker),
      nonce: opts.nonce,
      base: addrToHex(opts.base),
      quote: addrToHex(opts.quote),
    },
    sim,
    filledLots: parsed.filledLots,
    quoteAtoms: parsed.quoteAtoms,
  };
}
