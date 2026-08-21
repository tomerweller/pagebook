import * as StellarSdk from "@stellar/stellar-sdk";

const U32_MAX = 0xffffffff;

export type LedgerKeyWrap = {
  xdr: StellarSdk.xdr.LedgerKey;
  base64: string;
};

export type CkField = boolean | bigint | number | string;

function wrap(ledgerKey: StellarSdk.xdr.LedgerKey): LedgerKeyWrap {
  return { xdr: ledgerKey, base64: ledgerKey.toXDR("base64") };
}

function fieldScVal(f: CkField): StellarSdk.xdr.ScVal {
  const { xdr, Address } = StellarSdk;
  if (typeof f === "boolean") return xdr.ScVal.scvBool(f);
  if (typeof f === "bigint") {
    if (f > BigInt(U32_MAX)) return StellarSdk.nativeToScVal(f, { type: "u64" });
    if (f < 0n) throw new Error(`unsupported ck field: ${f}`);
    return xdr.ScVal.scvU32(Number(f));
  }
  if (typeof f === "number" && Number.isFinite(f)) {
    if (!Number.isInteger(f) || f < 0) throw new Error(`unsupported ck field: ${f}`);
    if (f > U32_MAX) return StellarSdk.nativeToScVal(BigInt(f), { type: "u64" });
    return xdr.ScVal.scvU32(f);
  }
  if (typeof f === "string" && f.length === 56 && (f[0] === "G" || f[0] === "C")) {
    return new Address(f).toScVal();
  }
  throw new Error(`unsupported ck field: ${f}`);
}

function contractDataKey(contract: string, key: StellarSdk.xdr.ScVal): LedgerKeyWrap {
  const { xdr, Address } = StellarSdk;
  return wrap(
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(contract).toScAddress(),
        key,
        durability: xdr.ContractDataDurability.persistent(),
      }),
    ),
  );
}

export function ck(contract: string, variant: string, ...fields: CkField[]): LedgerKeyWrap {
  const { xdr } = StellarSdk;
  const vec = [xdr.ScVal.scvSymbol(variant), ...fields.map((f) => fieldScVal(f))];
  return contractDataKey(contract, xdr.ScVal.scvVec(vec));
}

export function orderKey(contract: string, market: number, owner: string, nonce: bigint | number | string): LedgerKeyWrap {
  const { xdr, Address } = StellarSdk;
  const n = typeof nonce === "bigint" ? nonce : BigInt(nonce);
  const vec = [
    xdr.ScVal.scvSymbol("Order"),
    xdr.ScVal.scvU32(market),
    new Address(owner).toScVal(),
    StellarSdk.nativeToScVal(n, { type: "u64" }),
  ];
  return contractDataKey(contract, xdr.ScVal.scvVec(vec));
}

export function instanceKey(contract: string): LedgerKeyWrap {
  const { xdr, Address } = StellarSdk;
  return wrap(
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(contract).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    ),
  );
}

export function sacBalanceKey(sac: string, holderAddress: string): LedgerKeyWrap {
  return ck(sac, "Balance", holderAddress);
}

export function scValU32Base64(n: number): string {
  return StellarSdk.xdr.ScVal.scvU32(n).toXDR("base64");
}
