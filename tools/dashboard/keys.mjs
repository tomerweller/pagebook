const U32_MAX = 0xffffffff;

let injectedSdk = null;

export function setSdk(sdk) {
  injectedSdk = sdk;
}

export function resolveSdk(sdk) {
  const s =
    sdk ||
    injectedSdk ||
    (typeof globalThis !== "undefined" ? globalThis.StellarSdk : null);
  if (!s) throw new Error("StellarSdk is not available");
  return s;
}

function wrap(ledgerKey) {
  return { xdr: ledgerKey, base64: ledgerKey.toXDR("base64") };
}

function fieldScVal(sdk, f) {
  const { xdr, Address } = sdk;
  if (typeof f === "boolean") return xdr.ScVal.scvBool(f);
  if (typeof f === "bigint") {
    if (f > BigInt(U32_MAX)) return sdk.nativeToScVal(f, { type: "u64" });
    if (f < 0n) throw new Error(`unsupported ck field: ${f}`);
    return xdr.ScVal.scvU32(Number(f));
  }
  if (typeof f === "number" && Number.isFinite(f)) {
    if (!Number.isInteger(f) || f < 0) throw new Error(`unsupported ck field: ${f}`);
    if (f > U32_MAX) return sdk.nativeToScVal(BigInt(f), { type: "u64" });
    return xdr.ScVal.scvU32(f);
  }
  if (typeof f === "string" && f.length === 56 && (f[0] === "G" || f[0] === "C")) {
    return new Address(f).toScVal();
  }
  throw new Error(`unsupported ck field: ${f}`);
}

function contractDataKey(sdk, contract, key) {
  const { xdr, Address } = sdk;
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

export function ck(contract, variant, ...fields) {
  const sdk = resolveSdk();
  const { xdr } = sdk;
  const vec = [xdr.ScVal.scvSymbol(variant), ...fields.map((f) => fieldScVal(sdk, f))];
  return contractDataKey(sdk, contract, xdr.ScVal.scvVec(vec));
}

export function orderKey(contract, market, owner, nonce) {
  const sdk = resolveSdk();
  const { xdr, Address } = sdk;
  const n = typeof nonce === "bigint" ? nonce : BigInt(nonce);
  const vec = [
    xdr.ScVal.scvSymbol("Order"),
    xdr.ScVal.scvU32(market),
    new Address(owner).toScVal(),
    sdk.nativeToScVal(n, { type: "u64" }),
  ];
  return contractDataKey(sdk, contract, xdr.ScVal.scvVec(vec));
}

export function instanceKey(contract) {
  const sdk = resolveSdk();
  const { xdr, Address } = sdk;
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

export function sacBalanceKey(sac, holderAddress) {
  return ck(sac, "Balance", holderAddress);
}

export function scValU32Base64(n) {
  const sdk = resolveSdk();
  return sdk.xdr.ScVal.scvU32(n).toXDR("base64");
}
