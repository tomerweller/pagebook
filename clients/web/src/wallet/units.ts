import { formatAtoms, formatRatio } from "../decode";

export type Decimal = { num: bigint; den: bigint };

export function parseDecimal(s: string): Decimal | null {
  const t = s.trim();
  if (!t) return null;
  const m = t.match(/^([+-])?(\d*)(?:\.(\d*))?$/);
  if (!m) return null;
  if (!m[2] && !m[3]) return null;
  const sign = m[1] === "-" ? -1n : 1n;
  const whole = m[2] || "0";
  const frac = m[3] || "";
  return { num: sign * BigInt(whole + frac), den: 10n ** BigInt(frac.length) };
}

export type Quant = {
  lotSize: bigint;
  tickSize: bigint;
  baseDec: number;
  quoteDec: number;
  tickMin: number;
  tickMax: number;
  minLots: bigint;
};

export function priceToTick(price: Decimal, q: Quant, isBid: boolean): { tick: number; snapped: boolean } {
  const num = price.num * q.lotSize * 10n ** BigInt(q.quoteDec);
  const den = price.den * q.tickSize * 10n ** BigInt(q.baseDec);
  if (den === 0n) return { tick: 0, snapped: true };
  const quot = num / den;
  const rem = num % den;
  let tick = rem === 0n ? Number(quot) : isBid ? Number(quot) : Number(quot + 1n);
  if (!Number.isFinite(tick) || tick < 0) tick = 0;
  return { tick, snapped: rem !== 0n };
}

export function qtyToLots(qty: Decimal, q: Quant): bigint {
  if (qty.den === 0n) return 0n;
  const atoms = (qty.num * 10n ** BigInt(q.baseDec)) / qty.den;
  if (atoms < 0n) return 0n;
  return atoms / q.lotSize;
}

export function tickToPrice(tick: number, q: Quant): string {
  return formatRatio(BigInt(tick) * q.tickSize * 10n ** BigInt(q.baseDec), q.lotSize * 10n ** BigInt(q.quoteDec)).replace(
    /,/g,
    "",
  );
}

export function lotsToQty(lots: bigint, q: Quant): string {
  return formatAtoms(lots * q.lotSize, q.baseDec);
}

export function oneTickPriceStep(q: Quant): string {
  return tickToPrice(1, q);
}

export function oneLotQtyStep(q: Quant): string {
  return lotsToQty(1n, q);
}

export function minLotLabel(q: Quant, baseSymbol: string): string {
  const n = q.minLots < 1n ? 1n : q.minLots;
  return `min ${n.toString()} lot${n === 1n ? "" : "s"} = ${lotsToQty(n, q)} ${baseSymbol}`;
}
