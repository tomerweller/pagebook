export type WaitLedgersOpts = {
  latest: () => Promise<number>;
  start: number;
  count: number;
  intervalMs: number;
  progressEvery: number;
  onProgress: (cur: number, end: number) => void;
  sleep?: (ms: number) => Promise<void>;
  onPollError?: (e: unknown) => void;
};

export async function latestLedger(rpc: { getLatestLedger(): Promise<{ sequence: number }> }): Promise<number> {
  return (await rpc.getLatestLedger()).sequence;
}

export async function waitLedgers(opts: WaitLedgersOpts): Promise<number> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const end = opts.start + opts.count;
  let last = opts.start;
  for (;;) {
    await sleep(opts.intervalMs);
    let cur: number;
    try {
      cur = await opts.latest();
    } catch (e) {
      if (!opts.onPollError) throw e;
      opts.onPollError(e);
      continue;
    }
    if (cur >= end) return cur;
    if (cur - last >= opts.progressEvery) {
      last = cur;
      opts.onProgress(cur, end);
    }
  }
}