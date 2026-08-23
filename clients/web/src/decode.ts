export const LEVEL_BYTES = 285;
export const BITMAP_BYTES = 257;
export const INLINE_SLOTS = 32;
export const WORD_TICKS = 2048;
export const SUMMARY_WORDS = 2048;
export const PACKED_VERSION = 1;

export type LevelDecoded = {
  generation: number;
  head_seq: number;
  tail_seq: number;
  head_consumed_lots: bigint;
  open_lots: bigint;
  slots: bigint[];
};

export type Bitmap = {
  bits: Uint8Array;
  bit(i: number): boolean;
  setBits(descending?: boolean): Generator<number>;
};

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function asBytes(bytes: Uint8Array | ArrayLike<number>): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes;
  return new Uint8Array(bytes);
}

export function decodeLevel(bytes: Uint8Array | ArrayLike<number>): LevelDecoded | null {
  const buf = asBytes(bytes);
  if (buf.length !== LEVEL_BYTES || buf[0] !== PACKED_VERSION) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const slots = new Array<bigint>(INLINE_SLOTS);
  for (let i = 0; i < INLINE_SLOTS; i++) {
    slots[i] = view.getBigUint64(29 + i * 8, true);
  }
  return {
    generation: view.getUint32(1, true),
    head_seq: view.getUint32(5, true),
    tail_seq: view.getUint32(9, true),
    head_consumed_lots: view.getBigUint64(13, true),
    open_lots: view.getBigUint64(21, true),
    slots,
  };
}

export function decodeBitmap(bytes: Uint8Array | ArrayLike<number>): Bitmap | null {
  const buf = asBytes(bytes);
  if (buf.length !== BITMAP_BYTES || buf[0] !== PACKED_VERSION) return null;
  const bits = buf.subarray(1);
  const bm: Bitmap = {
    bits,
    bit(i) {
      return (bits[i >> 3] & (1 << (i & 7))) !== 0;
    },
    *setBits(descending = false) {
      if (descending) {
        for (let i = SUMMARY_WORDS - 1; i >= 0; i--) {
          if (bm.bit(i)) yield i;
        }
      } else {
        for (let i = 0; i < SUMMARY_WORDS; i++) {
          if (bm.bit(i)) yield i;
        }
      }
    },
  };
  return bm;
}

export function toBigInt(n: unknown): bigint {
  if (typeof n === "bigint") return n;
  if (typeof n === "number") {
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new Error("non-integer amount");
    }
    return BigInt(n);
  }
  if (typeof n === "string") return BigInt(n);
  if (n == null) return 0n;
  if (typeof n === "object" && typeof (n as { toString?: unknown }).toString === "function") {
    return BigInt((n as { toString: () => string }).toString());
  }
  throw new Error("not an integer");
}

export function formatInt(n: unknown): string {
  const v = toBigInt(n);
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? `-${grouped}` : grouped;
}

export function formatAtoms(atoms: unknown, decimals: unknown): string {
  const n = toBigInt(atoms);
  const d = Number(decimals);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  if (!Number.isInteger(d) || d <= 0) {
    return (neg ? "-" : "") + formatInt(abs);
  }
  const base = 10n ** BigInt(d);
  const whole = abs / base;
  const frac = abs % base;
  if (frac === 0n) return (neg ? "-" : "") + formatInt(whole);
  const fracStr = frac.toString().padStart(d, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${formatInt(whole)}.${fracStr}`;
}

export function formatRatio(num: unknown, den: unknown, maxFrac = 12, minFrac = 0): string {
  let n = toBigInt(num);
  let d = toBigInt(den);
  if (d === 0n) return "?";
  const neg = n < 0n !== d < 0n;
  if (n < 0n) n = -n;
  if (d < 0n) d = -d;
  const whole = n / d;
  let rem = n % d;
  let frac = "";
  for (let i = 0; i < maxFrac && rem !== 0n; i++) {
    rem *= 10n;
    frac += (rem / d).toString();
    rem %= d;
  }
  frac = frac.replace(/0+$/, "");
  while (frac.length < minFrac) frac += "0";
  if (!frac.length) return (neg ? "-" : "") + formatInt(whole);
  return `${neg ? "-" : ""}${formatInt(whole)}.${frac}`;
}

/// Decimal places of one tick in price units: the fixed precision every
/// price on a market is padded to so columns read uniformly.
export function priceStepDecimals(tickSize: unknown, lotSize: unknown, baseDecimals: unknown, quoteDecimals: unknown): number {
  const num = toBigInt(tickSize) * 10n ** toBigInt(baseDecimals);
  const den = toBigInt(lotSize) * 10n ** toBigInt(quoteDecimals);
  const s = formatRatio(num, den);
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

export function ticksToPrice(
  tick: unknown,
  tickSize: unknown,
  lotSize: unknown,
  baseDecimals: unknown,
  quoteDecimals: unknown,
): string {
  const t = toBigInt(tick);
  const ts = toBigInt(tickSize);
  const ls = toBigInt(lotSize);
  const bd = toBigInt(baseDecimals);
  const qd = toBigInt(quoteDecimals);
  const num = t * ts * 10n ** bd;
  const den = ls * 10n ** qd;
  return formatRatio(num, den, 12, priceStepDecimals(tickSize, lotSize, baseDecimals, quoteDecimals));
}

export function wordOf(tick: number | bigint): number {
  return Math.floor(Number(tick) / WORD_TICKS);
}
