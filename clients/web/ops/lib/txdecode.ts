import * as StellarSdk from "@stellar/stellar-sdk";

export type EnvelopeResources = {
  d_ro: number;
  d_rw: number;
  d_instr: number;
  d_read_b: number;
  d_write_b: number;
  d_fee: number;
  tx_fee: number;
};

export function decodeEnvelopeResources(envelopeXdr: string): EnvelopeResources {
  const env = StellarSdk.xdr.TransactionEnvelope.fromXDR(envelopeXdr, "base64");
  if (env.switch().name !== "envelopeTypeTx") throw new Error("not a v1 envelope");
  const tx = env.v1().tx();
  const ext = tx.ext();
  if (ext.switch() !== 1) throw new Error("no soroban data");
  const sd = ext.sorobanData();
  const res = sd.resources();
  const fp = res.footprint();
  return {
    d_ro: fp.readOnly().length,
    d_rw: fp.readWrite().length,
    d_instr: Number(res.instructions()),
    d_read_b: Number(res.diskReadBytes()),
    d_write_b: Number(res.writeBytes()),
    d_fee: Number(sd.resourceFee().toString()),
    tx_fee: Number(tx.fee().toString()),
  };
}

export function decodeFeeCharged(resultXdr: string): number {
  return Number(StellarSdk.xdr.TransactionResult.fromXDR(resultXdr, "base64").feeCharged().toString());
}

export function decodeCoreMetrics(events: string[]): Record<string, number> {
  const rec: Record<string, number> = {};
  for (const e of events) {
    try {
      const ev = StellarSdk.xdr.DiagnosticEvent.fromXDR(e, "base64");
      const b = ev.event().body().v0();
      const topics = b.topics();
      if (topics.length !== 2) continue;
      if (topics[0].switch().name !== "scvSymbol") continue;
      if (topics[0].sym().toString() !== "core_metrics") continue;
      if (topics[1].switch().name !== "scvSymbol") continue;
      const name = topics[1].sym().toString();
      const data = b.data();
      const n = data.switch().name === "scvU64" ? Number(data.u64().toString()) : Number(StellarSdk.scValToNative(data));
      if (Number.isFinite(n)) rec["a_" + name] = n;
    } catch {
      continue;
    }
  }
  return rec;
}