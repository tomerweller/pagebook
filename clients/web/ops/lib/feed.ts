import { TICK_USD_PER_XLM } from "./math";

export const FEED_UA = "pagebook-mm/0.1";
export const FEED_TIMEOUT_MS = 10_000;
export const COINBASE_URL = "https://api.coinbase.com/v2/prices/XLM-USD/spot";
export const KRAKEN_URL = "https://api.kraken.com/0/public/Ticker?pair=XLMUSD";
// Third source: XLM/USD mid from Bitstamp (US-accessible; Binance geo-blocks
// US egress like Fly iad). Added after a cloud host lost Coinbase AND Kraken
// for hours (2026-08-28) and the maker correctly refused to quote blind.
export const BITSTAMP_URL = "https://www.bitstamp.net/api/v2/ticker/xlmusd/";

export type HttpGet = (url: string, opts: { timeoutMs: number; userAgent: string }) => Promise<unknown>;

export type FeedOpts = {
  get?: HttpGet;
  now?: () => number;
  fixedMid?: number;
  walkMid?: boolean;
  rnd?: () => number;
};

async function defaultGet(url: string, opts: { timeoutMs: number; userAgent: string }): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": opts.userAgent },
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

export class Feed {
  last: number | null = null;
  at = 0;
  source: string | null = null;
  private get: HttpGet;
  private now: () => number;
  private fixedTick: number | undefined;
  private walkMid: boolean;
  private rnd: () => number;

  constructor(opts?: FeedOpts) {
    this.get = opts?.get ?? defaultGet;
    this.now = opts?.now ?? (() => Date.now() / 1000);
    this.fixedTick = opts?.fixedMid;
    this.walkMid = !!opts?.walkMid;
    this.rnd = opts?.rnd ?? Math.random;
  }

  async fetch(): Promise<number | null> {
    if (this.fixedTick != null) {
      if (this.walkMid) this.fixedTick += Math.floor(this.rnd() * 5) - 2;
      const p = this.fixedTick * TICK_USD_PER_XLM;
      this.last = p;
      this.at = this.now();
      this.source = "fixed";
      return p;
    }
    try {
      const j = (await this.get(COINBASE_URL, { timeoutMs: FEED_TIMEOUT_MS, userAgent: FEED_UA })) as {
        data?: { amount?: string };
      };
      const p = Number(j.data?.amount);
      if (!Number.isFinite(p)) throw new Error("bad coinbase");
      this.last = p;
      this.at = this.now();
      this.source = "coinbase";
      return p;
    } catch {
      /* kraken */
    }
    try {
      const j = (await this.get(KRAKEN_URL, { timeoutMs: FEED_TIMEOUT_MS, userAgent: FEED_UA })) as {
        result?: Record<string, { a?: string[]; b?: string[] }>;
      };
      const r = Object.values(j.result ?? {})[0];
      if (!r) throw new Error("bad kraken");
      const p = (Number(r.a?.[0]) + Number(r.b?.[0])) / 2;
      if (!Number.isFinite(p)) throw new Error("bad kraken mid");
      this.last = p;
      this.at = this.now();
      this.source = "kraken";
      return p;
    } catch {
      /* bitstamp */
    }
    try {
      const j = (await this.get(BITSTAMP_URL, { timeoutMs: FEED_TIMEOUT_MS, userAgent: FEED_UA })) as {
        bid?: string;
        ask?: string;
      };
      const p = (Number(j.bid) + Number(j.ask)) / 2;
      if (!Number.isFinite(p) || p <= 0) throw new Error("bad bitstamp mid");
      this.last = p;
      this.at = this.now();
      this.source = "bitstamp";
      return p;
    } catch {
      return null;
    }
  }

  age(): number {
    return this.at ? this.now() - this.at : Number.POSITIVE_INFINITY;
  }
}
