import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseArgs } from "./args";
import { Feed } from "./feed";
import { findConfigDir, loadIdentity } from "./identity";
import { secretEnvName } from "./math";
import { openLog } from "./opslog";
import { main as mmMain, parseMmArgs } from "../mm";
import { main as soakMain, parseSoakArgs } from "../soak";
import { main as stressMain, parseStressArgs } from "../stress";
import { main as checkMain, parseCheckArgs } from "../check";
import { main as resourcesMain, parseResourcesArgs } from "../resources";
import { main as traderMain, parseTraderArgs } from "../trader";
import { main as keepaliveMain, parseKeepaliveArgs } from "../keepalive";

test("identity env override PB_SECRET_<NAME>", async () => {
  const { Keypair } = await import("@stellar/stellar-sdk");
  const secret = Keypair.random().secret();
  const id = loadIdentity("pb-mm", "/nope", {
    env: { [secretEnvName("pb-mm")]: secret },
    spawn: () => {
      throw new Error("spawn should not run");
    },
  });
  expect(id.secret).toBe(secret);
  expect(id.address.startsWith("G")).toBe(true);
  expect(secretEnvName("pb-mm")).toBe("PB_SECRET_PB_MM");
  expect(() => loadIdentity("x", "/nope", { env: { PB_SECRET_X: "S" + "A".repeat(55) } })).toThrow();
});

test("findConfigDir walks up to a .stellar/identity directory", () => {
  const root = mkdtempSync(join(tmpdir(), "pb-cfg-"));
  const nested = join(root, "a", "b");
  mkdirSync(join(root, ".stellar", "identity"), { recursive: true });
  mkdirSync(nested, { recursive: true });
  expect(findConfigDir({ start: nested, env: {} })).toBe(join(root, ".stellar"));
  expect(findConfigDir({ start: nested, env: { STELLAR_CONFIG_DIR: "/explicit" } })).toBe("/explicit");
});

test("missing stellar binary is distinct from missing identity", () => {
  expect(() =>
    loadIdentity("pb-mm", "/nope", {
      env: {},
      spawn: () => ({ stdout: "", stderr: "", status: null, error: { code: "ENOENT", message: "spawn stellar ENOENT" } }),
    }),
  ).toThrow(/stellar CLI not found/);
  expect(() =>
    loadIdentity("pb-mm", "/nope", {
      env: {},
      spawn: () => ({ stdout: "", stderr: "no such identity", status: 1 }),
    }),
  ).toThrow(/could not load identity pb-mm/);
});

test("feed uses last-good, coinbase then kraken, fixed-mid", async () => {
  const calls: string[] = [];
  const feed = new Feed({
    now: () => 100,
    get: async (url) => {
      calls.push(url);
      if (url.includes("coinbase")) throw new Error("down");
      return { result: { XXLMZUSD: { a: ["0.16"], b: ["0.14"] } } };
    },
  });
  expect(await feed.fetch()).toBeCloseTo(0.15);
  expect(feed.source).toBe("kraken");
  expect(feed.age()).toBe(0);
  expect(calls.some((u) => u.includes("coinbase"))).toBe(true);
  expect(calls.some((u) => u.includes("kraken"))).toBe(true);

  const fixed = new Feed({ fixedMid: 15800, now: () => 1 });
  expect(await fixed.fetch()).toBeCloseTo(0.158);
  expect(fixed.source).toBe("fixed");

  const walked = new Feed({
    fixedMid: 15800,
    walkMid: true,
    now: () => 1,
    rnd: () => 0.99,
  });
  const p = await walked.fetch();
  expect(p).not.toBeNull();
});

test("horizon skips non-native rows without asset_code and NaN balances", async () => {
  const { fetchBalances } = await import("./horizon");
  const bal = await fetchBalances("https://horizon.test", "G1", async () => ({
    balances: [
      { asset_type: "native", balance: "12.5" },
      { asset_type: "credit_alphanum4", balance: "9" },
      { asset_code: "USDC", asset_type: "credit_alphanum4", balance: "3.25" },
      { asset_code: "BAD", asset_type: "credit_alphanum4", balance: "nope" },
    ],
  }));
  expect(bal).toEqual({ XLM: 12.5, USDC: 3.25 });
});

test("opslog JSON-lines flush per line with Python field names", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-log-"));
  const path = join(dir, "mm.log");
  const log = openLog(path, () => 12.5);
  log.record("feed", "stale", { age: 300, action: "cancel_all" });
  log.close();
  const line = JSON.parse(readFileSync(path, "utf8").trim()) as Record<string, unknown>;
  expect(line).toEqual({ t: 12.5, action: "cancel_all", outcome: "stale", age: 300 });
});

test("mm and trader argparse flags and defaults", () => {
  const mm = parseMmArgs(["--contract", "C1", "--market", "1", "--base-sac", "B", "--quote-sac", "Q", "--usdc-issuer", "G"]);
  expect(mm.identity).toBe("pb-mm");
  expect(mm.levels).toBe(20);
  expect(mm.halfSpreadBps).toBe(4);
  expect(mm.spacingBps).toBe(5);
  expect(mm.baseLots).toBe(25);
  expect(mm.stepLots).toBe(12);
  expect(mm.skewBps).toBe(3);
  expect(mm.requoteTicks).toBe(4);
  expect(mm.touchSlots).toBe(3);
  expect(mm.fullScanEvery).toBe(8);
  expect(mm.batch).toBe(8);
  expect(mm.maxPlacesPerCycle).toBe(6);
  expect(mm.interval).toBe(30);
  expect(mm.maxFeedAge).toBe(240);
  expect(mm.healBand).toBe(150);
  expect(mm.maxHealsPerCycle).toBe(6);
  expect(mm.padV2).toBe(false);
  expect(mm.walkMid).toBe(false);
  expect(mm.cancelAll).toBe(false);
  const mm2 = parseMmArgs(["--contract", "C1", "--market", "1", "--base-sac", "B", "--quote-sac", "Q", "--usdc-issuer", "G", "--pad-v2", "--fixed-mid", "15800", "--walk-mid", "--cancel-on-exit"]);
  expect(mm2.padV2).toBe(true);
  expect(mm2.fixedMid).toBe(15800);
  expect(mm2.walkMid).toBe(true);
  expect(mm2.cancelOnExit).toBe(true);
  const tr = parseTraderArgs(["--contract", "C1", "--market", "1", "--base-sac", "B", "--quote-sac", "Q", "--usdc-issuer", "G"]);
  expect(tr.identity).toBe("pb-trader");
  expect(tr.minWait).toBe(20);
  expect(tr.maxWait).toBe(75);
  expect(tr.restShare).toBe(0.15);
  expect(tr.maxResting).toBe(3);
  expect(tr.restMinS).toBe(120);
  expect(tr.restMaxS).toBe(360);
});

test("ops entry points reject a non-testnet network", async () => {
  await expect(
    mmMain(["--contract", "C1", "--market", "1", "--base-sac", "B", "--quote-sac", "Q", "--usdc-issuer", "G", "--network", "mainnet"]),
  ).rejects.toThrow(/only testnet is supported/);
  await expect(
    traderMain(["--contract", "C1", "--market", "1", "--base-sac", "B", "--quote-sac", "Q", "--usdc-issuer", "G", "--network", "pubnet"]),
  ).rejects.toThrow(/only testnet is supported/);
  await expect(
    soakMain(["--contract", "C1", "--base", "B", "--quote", "Q", "--issuer", "G", "--codes", "PBA,PBB", "--network", "pubnet"]),
  ).rejects.toThrow(/only testnet is supported/);
  await expect(stressMain(["run", "--network", "pubnet"])).rejects.toThrow(/only testnet is supported/);
  await expect(checkMain(["--contract", "C1", "--market", "1", "--network", "pubnet"])).rejects.toThrow(/only testnet is supported/);
  await expect(resourcesMain(["--contract", "C1", "--network", "pubnet"])).rejects.toThrow(/only testnet is supported/);
  await expect(
    keepaliveMain(["--contract", "C1", "--market", "1", "--base-sac", "B", "--quote-sac", "Q", "--network", "pubnet"]),
  ).rejects.toThrow(/only testnet is supported/);
  expect(parseKeepaliveArgs(["--contract", "C1", "--market", "1", "--base-sac", "B", "--quote-sac", "Q"]).wordSpan).toBe(2);
  expect(parseSoakArgs(["--contract", "C1", "--base", "B", "--quote", "Q", "--issuer", "G", "--codes", "PBA,PBB"]).taker).toBe("pb-taker");
  expect(parseStressArgs(["seed"]).phase).toBe("seed");
  expect(parseCheckArgs(["--contract", "C1", "--market", "1"]).window).toBe(3600);
  expect(parseResourcesArgs(["--contract", "C1"]).perCat).toBe(30);
});

test("parseArgs rejects missing required", () => {
  expect(() => parseArgs([], [{ flag: "--contract", dest: "contract", required: true }])).toThrow(/--contract/);
});
