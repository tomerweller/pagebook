import * as StellarSdk from "@stellar/stellar-sdk";
import type { Rpc } from "../../src/book";
import { parseContractError } from "../../src/engine/errors";
import { simulate, simulateQuotePlace, type SimResult } from "../../src/engine/quote";
import type { CrossedLevel } from "../../src/engine/pad";
import { scvAddr, scvBool, scvU32, scvU64 } from "../../src/engine/submit";
import { NETWORK_PASSPHRASE } from "../../src/wallet/network";

export type LevelView = {
  generation: number;
  head_seq: number;
  tail_seq: number;
  head_consumed_lots: number;
  open_lots: number;
};

export type OrderView = {
  is_bid: boolean;
  tick: number;
  generation: number;
  seq: number;
  qty_lots: number;
  filled_lots: number;
  refund_lots: number;
};

export type QuoteView = {
  start_tick: number;
  crossed: CrossedLevel[];
  filled_lots: number;
  quote_atoms: bigint;
  tail_seq: number;
};

export type Views = {
  best: (isBid: boolean) => Promise<number | null>;
  level: (isBid: boolean, tick: number) => Promise<LevelView>;
  order: (nonce: number) => Promise<OrderView | null>;
  quotePlace: (isBid: boolean, limitTick: number, qty: number) => Promise<QuoteView>;
};

function asNum(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  return Number(v ?? 0);
}

export function parseLevel(native: unknown): LevelView {
  if (native == null || typeof native !== "object") throw new Error("empty Level view");
  const r = native as Record<string, unknown>;
  return {
    generation: asNum(r.generation),
    head_seq: asNum(r.head_seq ?? r.headSeq),
    tail_seq: asNum(r.tail_seq ?? r.tailSeq),
    head_consumed_lots: asNum(r.head_consumed_lots ?? r.headConsumedLots),
    open_lots: asNum(r.open_lots ?? r.openLots),
  };
}

export function parseOrder(native: unknown): OrderView {
  if (native == null || typeof native !== "object") throw new Error("empty Order view");
  const r = native as Record<string, unknown>;
  return {
    is_bid: !!(r.is_bid ?? r.isBid),
    tick: asNum(r.tick),
    generation: asNum(r.generation),
    seq: asNum(r.seq),
    qty_lots: asNum(r.qty_lots ?? r.qtyLots),
    filled_lots: asNum(r.filled_lots ?? r.filledLots),
    refund_lots: asNum(r.refund_lots ?? r.refundLots),
  };
}

export async function simulateView(
  rpc: Rpc,
  opts: {
    contract: string;
    source: string;
    sequence: string;
    fn: string;
    args: StellarSdk.xdr.ScVal[];
  },
): Promise<{ native: unknown; sim: SimResult }> {
  const contract = new StellarSdk.Contract(opts.contract);
  const account = new StellarSdk.Account(opts.source, opts.sequence);
  const tx = new StellarSdk.TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call(opts.fn, ...opts.args))
    .setTimeout(30)
    .build();
  const sim = await simulate(rpc, tx.toXDR());
  if (sim.error) throw new Error(sim.error);
  const retval = sim.results?.[0]?.xdr;
  if (!retval) return { native: null, sim };
  const scv = StellarSdk.xdr.ScVal.fromXDR(retval, "base64");
  return { native: StellarSdk.scValToNative(scv) as unknown, sim };
}

export function createViews(
  rpc: Rpc,
  opts: { contract: string; source: string; market: number; owner: string },
): Views {
  async function call(fn: string, args: StellarSdk.xdr.ScVal[]): Promise<unknown> {
    const { native } = await simulateView(rpc, {
      contract: opts.contract,
      source: opts.source,
      sequence: "0",
      fn,
      args,
    });
    return native;
  }

  return {
    async best(isBid) {
      try {
        const native = await call("best", [scvU32(opts.market), scvBool(isBid)]);
        if (native == null) return null;
        return Number(native);
      } catch {
        return null;
      }
    },
    async level(isBid, tick) {
      const native = await call("level", [scvU32(opts.market), scvBool(isBid), scvU32(tick)]);
      return parseLevel(native);
    },
    async order(nonce) {
      try {
        const native = await call("order", [scvU32(opts.market), scvAddr(opts.owner), scvU64(BigInt(nonce))]);
        return parseOrder(native);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (parseContractError(msg) != null || /Contract, #/.test(msg)) return null;
        throw e;
      }
    },
    async quotePlace(isBid, limitTick, qty) {
      const { parsed } = await simulateQuotePlace(rpc, {
        contract: opts.contract,
        source: opts.source,
        sequence: "0",
        market: opts.market,
        isBid,
        limitTick,
        qty: BigInt(qty),
      });
      return {
        start_tick: parsed.startTick,
        crossed: parsed.crossed,
        filled_lots: Number(parsed.filledLots),
        quote_atoms: parsed.quoteAtoms,
        tail_seq: parsed.tailSeq,
      };
    },
  };
}
