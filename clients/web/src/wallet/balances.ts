import { parseAssetFromSacName } from "../client/account";
import { tokenDecimals, tokenLabel } from "../view/format";
import type { AppState } from "../view/market";
import type { TicketBalances } from "./ticket";

function safeAsset(name: string) {
  try {
    return parseAssetFromSacName(name);
  } catch {
    return null;
  }
}

/// What the active identity can actually spend, in the market's own tokens.
/// The place ticket and the replace form both need it: a replace that escrows
/// more quote than the wallet holds used to reach the chain and come back as a
/// bare "BalanceError" (ADR-046 companion fix).
export function walletBalances(state: AppState): TicketBalances {
  const book = state.book.snapshot;
  const acc = state.wallet.account;
  const tls = state.wallet.trustlines;
  const ov = state.book.overrides;
  const baseClassic = book?.tokens.base?.name ? safeAsset(book.tokens.base.name) : null;
  const quoteClassic = book?.tokens.quote?.name ? safeAsset(book.tokens.quote.name) : null;
  const quoteTl =
    quoteClassic && quoteClassic.type === "credit"
      ? tls.find((t) => t.asset.code === quoteClassic.code && t.asset.issuer === quoteClassic.issuer)
      : undefined;
  const baseTl =
    baseClassic && baseClassic.type === "credit"
      ? tls.find((t) => t.asset.code === baseClassic.code && t.asset.issuer === baseClassic.issuer)
      : undefined;
  const baseIsNative = !baseClassic || baseClassic.type === "native";
  const quoteIsNative = quoteClassic?.type === "native";
  return {
    funded: !!acc?.exists,
    xlmSpendable: acc?.spendable ?? 0n,
    baseAtoms: baseIsNative ? (acc?.balance ?? 0n) : baseTl?.exists ? baseTl.balance : 0n,
    quoteAtoms: quoteIsNative
      ? (acc?.balance ?? 0n)
      : quoteTl
        ? quoteTl.exists
          ? quoteTl.balance
          : null
        : quoteClassic
          ? null
          : 0n,
    baseIsNative,
    quoteIsNative: !!quoteIsNative,
    quoteSymbol: tokenLabel(book?.tokens.quote, ov.quoteSym, book?.quote ?? null),
    baseSymbol: tokenLabel(book?.tokens.base, ov.baseSym, book?.base ?? null),
    baseDec: tokenDecimals(book?.tokens.base, ov.baseDec),
    quoteDec: tokenDecimals(book?.tokens.quote, ov.quoteDec),
  };
}
