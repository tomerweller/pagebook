/// URL parameters are hand-typed, and `Number("abc")` is NaN — which used to
/// reach the key builder as `unsupported ck field: NaN` (`?market=abc`) or
/// silently empty the ladder while the KPIs still showed a book
/// (`?depth=abc`). Every numeric parameter goes through here instead, and a
/// value that is not a plain integer in range reads as absent.

export function intParam(raw: string | null | undefined, opts: { min: number; max: number }): number | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n)) return null;
  if (n < opts.min || n > opts.max) return null;
  return n;
}

export const MAX_DEPTH = 64;
export const MAX_MARKET_ID = 0xffffffff;
export const MAX_DECIMALS = 18;

export function depthParam(raw: string | null | undefined, fallback = 12): number {
  return intParam(raw, { min: 1, max: MAX_DEPTH }) ?? fallback;
}

export function marketParam(raw: string | null | undefined): number | null {
  return intParam(raw, { min: 0, max: MAX_MARKET_ID });
}

export function decimalsParam(raw: string | null | undefined): number | null {
  return intParam(raw, { min: 0, max: MAX_DECIMALS });
}
