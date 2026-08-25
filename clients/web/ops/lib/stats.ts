export type Percentiles = {
  min: number;
  p50: number;
  p95: number;
  max: number;
};

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function percentiles(values: number[]): Percentiles | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const q = (p: number): number => {
    const i = (v.length - 1) * p;
    const lo = Math.floor(i);
    return lo === v.length - 1 ? v[lo] : v[lo] + (v[lo + 1] - v[lo]) * (i - lo);
  };
  return { min: v[0], p50: round2(q(0.5)), p95: round2(q(0.95)), max: v[v.length - 1] };
}