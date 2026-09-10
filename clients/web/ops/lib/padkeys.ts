import * as StellarSdk from "@stellar/stellar-sdk";
import { addrToHex, type Hex32 } from "../../src/engine/clientKeys";
import { tokenExtraKeys, type ClassicToken } from "../../src/engine/op";

export function classicPairTokens(baseSac: string, quoteSac: string, issuer: string, codes: string): ClassicToken[] {
  const [baseCode, quoteCode] = codes.split(",");
  return classicTokens({
    baseSac,
    quoteSac,
    usdcCode: quoteCode ?? "",
    usdcIssuer: issuer,
    baseCode: baseCode ?? "",
    baseIssuer: issuer,
  });
}

export function classicTokens(opts: {
  baseSac: string;
  quoteSac: string;
  usdcCode: string;
  usdcIssuer: string;
  baseCode?: string;
  baseIssuer?: string;
}): ClassicToken[] {
  // Base defaults to native XLM (caller's balance entry is the account itself);
  // a classic base (a test-asset market) passes its trustline coordinates.
  const base: ClassicToken =
    opts.baseCode && opts.baseIssuer
      ? { sac: opts.baseSac, code: opts.baseCode, issuer: opts.baseIssuer }
      : { sac: opts.baseSac };
  return [base, { sac: opts.quoteSac, code: opts.usdcCode, issuer: opts.usdcIssuer }];
}

export function tokenXdrKeys(pagebook: string, caller: string, tokens: ClassicToken[]): StellarSdk.xdr.LedgerKey[] {
  return tokenExtraKeys(pagebook, caller, tokens).map((p) => p.key);
}

export function tokenHex(baseSac: string, quoteSac: string): { base: Hex32; quote: Hex32 } {
  return { base: addrToHex(baseSac), quote: addrToHex(quoteSac) };
}
