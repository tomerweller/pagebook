import { expect, test } from "vitest";
import { waitLedgers } from "./ledger";

test("waitLedgers stops at start+count and progress-ticks every N", async () => {
  const seq = [100, 150, 199, 200];
  let i = 0;
  const progress: number[] = [];
  const sleeps: number[] = [];
  const end = await waitLedgers({
    latest: async () => seq[Math.min(i++, seq.length - 1)],
    start: 100,
    count: 100,
    intervalMs: 15,
    progressEvery: 50,
    onProgress: (cur) => progress.push(cur),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  expect(end).toBe(200);
  expect(progress).toEqual([150]);
  expect(sleeps.length).toBe(4);
});