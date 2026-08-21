export const ERROR_NAMES: Record<number, string> = {
  1: "NotAdmin",
  2: "Paused",
  3: "SameToken",
  4: "UnknownMarket",
  5: "BadQuantization",
  6: "TickOutOfBand",
  7: "BadStartTick",
  8: "QtyOutOfBounds",
  9: "Crossed",
  10: "Unfilled",
  11: "LevelFull",
  12: "RetryRest",
  13: "OrderExists",
  14: "NotOwner",
  15: "UnknownOrder",
  16: "Overflow",
  17: "FeeTooHigh",
  18: "TooManyLegs",
  19: "BadWindow",
  20: "BatchTooLarge",
  21: "TokenNotAuthorized",
  22: "CorruptEntry",
  23: "NotInitialized",
  24: "SelfTrade",
};

export const ERROR_MESSAGES: Record<number, string> = {
  1: "only the admin can do that",
  2: "the contract is paused",
  3: "base and quote must be different tokens",
  4: "that market id is not on this contract",
  5: "lot or tick size is not valid",
  6: "tick is outside this market's band",
  7: "start tick is not valid for this walk",
  8: "lots are outside the market min and max",
  9: "crossed the book: a post-only order would have taken",
  10: "unfilled: fill-or-kill would not fill completely",
  11: "that price level's queue is full. try another tick",
  12: "the rest window moved. retry the rest",
  13: "an order with that nonce is already live",
  14: "only the owner can settle or replace this order",
  15: "no live order with that nonce",
  16: "an amount overflowed",
  17: "taker fee is above the allowed maximum",
  18: "too many route legs",
  19: "the declared page window is not valid",
  20: "the replace batch is larger than the cap",
  21: "this token has not authorized the vault",
  22: "a stored entry failed to decode",
  23: "the contract has not been initialized",
  24: "a later leg would take this call's own rest",
};

export const ERROR_CODE_COUNT = 24;

export function errorName(code: number): string {
  return ERROR_NAMES[code] ?? String(code);
}

export function errorMessage(code: number): string {
  return ERROR_MESSAGES[code] ?? `contract error ${code}`;
}

export function errorCodeByName(name: string): number | undefined {
  for (const [k, v] of Object.entries(ERROR_NAMES)) {
    if (v === name) return Number(k);
  }
  return undefined;
}

export function errorMessageByName(name: string): string {
  const code = errorCodeByName(name);
  return code != null ? errorMessage(code) : name;
}

export function errorTitle(code: number): string {
  return `Error ${code} (${errorName(code)})`;
}

export function errorTitleByName(name: string): string {
  const code = errorCodeByName(name);
  return code != null ? errorTitle(code) : name;
}

export function hostErrorMessage(text: string): string | null {
  if (/trustline entry is missing/i.test(text)) return "token trustline is missing";
  if (/insufficient balance/i.test(text)) return "insufficient token balance";
  return null;
}

export function parseContractError(text: string): number | null {
  if (hostErrorMessage(text)) return null;
  const m = text.match(/Error\(Contract, #(\d+)\)|"error"\s*:\s*\{\s*"contract"\s*:\s*(\d+)\}/);
  if (!m) return null;
  return Number(m[1] || m[2]);
}
