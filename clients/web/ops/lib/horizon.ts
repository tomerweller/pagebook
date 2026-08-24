import { FEED_UA } from "./feed";

export const HORIZON_TIMEOUT_MS = 15_000;

export type HorizonGet = (url: string, opts: { timeoutMs: number; userAgent: string }) => Promise<unknown>;

async function defaultGet(url: string, opts: { timeoutMs: number; userAgent: string }): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": opts.userAgent },
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

export async function fetchBalances(
  horizon: string,
  addr: string,
  get: HorizonGet = defaultGet,
): Promise<Record<string, number>> {
  try {
    const acc = (await get(`${horizon.replace(/\/$/, "")}/accounts/${addr}`, {
      timeoutMs: HORIZON_TIMEOUT_MS,
      userAgent: FEED_UA,
    })) as { balances?: { asset_code?: string; asset_type?: string; balance?: string }[] };
    const out: Record<string, number> = {};
    for (const b of acc.balances ?? []) {
      if (!b.asset_code && b.asset_type !== "native") continue;
      const n = Number(b.balance);
      if (!Number.isFinite(n)) continue;
      const code = b.asset_code ?? "XLM";
      out[code] = n;
    }
    return out;
  } catch {
    return {};
  }
}
