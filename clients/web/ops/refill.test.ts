import { expect, test } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "../src/wallet/network";
import type { AccountState } from "../src/wallet/account";
import {
  buildMergeTx,
  buildSwapMergeTx,
  DEST_MIN_USDC,
  FLY_MAKER,
  FLY_TRADER,
  parseRefillArgs,
  runRefill,
  stroopsToAmount,
  swapSendStroops,
  USDC_ISSUER,
  xlmAccountsNeeded,
} from "./refill";
import type { RefillDeps } from "./refill";

test("refill flags and defaults", () => {
  const a = parseRefillArgs([]);
  expect(a.maker).toBe(FLY_MAKER);
  expect(a.trader).toBe(FLY_TRADER);
  expect(a.usdcIssuer).toBe(USDC_ISSUER);
  expect(a.horizon).toBe("https://horizon-testnet.stellar.org");
  expect(a.xlmFloor).toBe(30000);
  expect(a.xlmTarget).toBe(50000);
  expect(a.usdcFloor).toBe(5000);
  expect(a.usdcTarget).toBe(20000);
  expect(a.maxAccounts).toBe(8);
  expect(a.dryRun).toBe(false);
  expect(a.log).toBe("ops/refill.log");
  const b = parseRefillArgs(["--dry-run", "--xlm-floor", "1000", "--max-accounts", "2"]);
  expect(b.dryRun).toBe(true);
  expect(b.xlmFloor).toBe(1000);
  expect(b.maxAccounts).toBe(2);
});

test("xlmAccountsNeeded rounds up per 9,999 XLM throwaway", () => {
  expect(xlmAccountsNeeded(50000, 50000)).toBe(0);
  expect(xlmAccountsNeeded(49999, 50000)).toBe(1);
  expect(xlmAccountsNeeded(40001, 50000)).toBe(1);
  expect(xlmAccountsNeeded(40000, 50000)).toBe(2);
  expect(xlmAccountsNeeded(10000, 50000)).toBe(5);
  expect(xlmAccountsNeeded(0, 50000)).toBe(6);
});

test("stroopsToAmount formats 7 decimals", () => {
  expect(stroopsToAmount(0n)).toBe("0.0000000");
  expect(stroopsToAmount(1n)).toBe("0.0000001");
  expect(stroopsToAmount(99_999_000_000n)).toBe("9999.9000000");
  expect(() => stroopsToAmount(-1n)).toThrow();
});

test("swapSendStroops leaves the fee behind, never negative", () => {
  const st = (spendable: bigint): AccountState => ({ exists: true, balance: 0n, spendable, sequence: 1n, numSubEntries: 0 });
  expect(swapSendStroops(st(99_990_000_000n))).toBe(99_990_000_000n - 200n);
  expect(swapSendStroops(st(100n))).toBe(0n);
});

test("buildMergeTx signs a single account_merge into the destination", () => {
  const kp = StellarSdk.Keypair.random();
  const xdr = buildMergeTx(kp.secret(), 7n, FLY_MAKER);
  const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE) as StellarSdk.Transaction;
  expect(tx.source).toBe(kp.publicKey());
  expect(tx.sequence).toBe("8");
  expect(tx.operations).toHaveLength(1);
  const op = tx.operations[0] as StellarSdk.Operation.AccountMerge;
  expect(op.type).toBe("accountMerge");
  expect(op.destination).toBe(FLY_MAKER);
  expect(tx.signatures).toHaveLength(1);
  expect(kp.verify(tx.hash(), tx.signatures[0].signature())).toBe(true);
});

test("buildSwapMergeTx path-pays XLM to USDC then merges the residue", () => {
  const kp = StellarSdk.Keypair.random();
  const xdr = buildSwapMergeTx({
    secret: kp.secret(),
    sequence: 3n,
    dest: FLY_TRADER,
    usdcIssuer: USDC_ISSUER,
    sendXlm: "9997.9999800",
  });
  const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE) as StellarSdk.Transaction;
  expect(tx.operations).toHaveLength(2);
  const swap = tx.operations[0] as StellarSdk.Operation.PathPaymentStrictSend;
  expect(swap.type).toBe("pathPaymentStrictSend");
  expect(swap.sendAsset.isNative()).toBe(true);
  expect(swap.sendAmount).toBe("9997.9999800");
  expect(swap.destination).toBe(FLY_TRADER);
  expect(swap.destAsset.getCode()).toBe("USDC");
  expect(swap.destAsset.getIssuer()).toBe(USDC_ISSUER);
  expect(swap.destMin).toBe(DEST_MIN_USDC);
  expect(swap.path).toHaveLength(0);
  const merge = tx.operations[1] as StellarSdk.Operation.AccountMerge;
  expect(merge.type).toBe("accountMerge");
  expect(merge.destination).toBe(FLY_TRADER);
});

type Line = { action: string; outcome: string; extra?: Record<string, unknown> };

function fakeDeps(opts: {
  balances: (addr: string, call: number) => Record<string, number>;
  submitOk?: boolean;
  friendbotOk?: boolean;
}): { deps: RefillDeps; lines: Line[]; funded: string[]; submitted: string[] } {
  const lines: Line[] = [];
  const funded: string[] = [];
  const submitted: string[] = [];
  let calls = 0;
  const state: AccountState = {
    exists: true,
    balance: 99_999_999_900n,
    spendable: 99_989_999_900n,
    sequence: 1n,
    numSubEntries: 0,
  };
  const deps: RefillDeps = {
    balances: async (addr) => opts.balances(addr, calls++),
    friendbot: async (addr) => {
      funded.push(addr);
      return opts.friendbotOk === false ? { ok: false, error: "nope" } : { ok: true };
    },
    account: async () => state,
    submit: async (xdr) => {
      submitted.push(xdr);
      return opts.submitOk === false ? { ok: false, error: "transaction failed" } : { ok: true, hash: "h" + submitted.length };
    },
    keygen: () => StellarSdk.Keypair.random(),
    sleep: async () => {},
    log: {
      record(action, outcome, extra) {
        lines.push({ action, outcome, extra });
        return { t: 0, action, outcome };
      },
      close() {},
    },
  };
  return { deps, lines, funded, submitted };
}

test("runRefill leaves healthy balances alone", async () => {
  const { deps, lines, funded } = fakeDeps({
    balances: (addr): Record<string, number> => (addr === FLY_MAKER ? { XLM: 45000 } : { USDC: 12000, XLM: 100 }),
  });
  const r = await runRefill(parseRefillArgs([]), deps);
  expect(funded).toHaveLength(0);
  expect(r.summary).toEqual({ makerXlm: 45000, traderUsdc: 12000, merges: 0, swaps: 0, errors: 0, dry: false });
  expect(lines.map((l) => `${l.action}:${l.outcome}`)).toEqual(["maker:ok", "trader:ok", "summary:ok"]);
});

test("runRefill dry-run plans but funds nothing", async () => {
  const { deps, lines, funded, submitted } = fakeDeps({
    balances: (addr): Record<string, number> => (addr === FLY_MAKER ? { XLM: 10000 } : { USDC: 1000 }),
  });
  const r = await runRefill(parseRefillArgs(["--dry-run"]), deps);
  expect(funded).toHaveLength(0);
  expect(submitted).toHaveLength(0);
  expect(r.line.startsWith("REFILL dry ")).toBe(true);
  const maker = lines.find((l) => l.action === "maker");
  expect(maker?.outcome).toBe("dry");
  expect(maker?.extra?.accounts).toBe(5);
  expect(lines.find((l) => l.action === "trader")?.outcome).toBe("dry");
});

test("runRefill merges throwaways into the maker until the target", async () => {
  const { deps, lines, funded, submitted } = fakeDeps({
    balances: (addr): Record<string, number> => (addr === FLY_MAKER ? { XLM: 10000 } : { USDC: 12000 }),
  });
  const r = await runRefill(parseRefillArgs([]), deps);
  // (50000 - 10000) / 9999 rounds up to 5 throwaways.
  expect(funded).toHaveLength(5);
  expect(submitted).toHaveLength(5);
  expect(r.summary.merges).toBe(5);
  expect(r.summary.errors).toBe(0);
  for (const xdr of submitted) {
    const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE) as StellarSdk.Transaction;
    expect(tx.operations).toHaveLength(1);
    expect((tx.operations[0] as StellarSdk.Operation.AccountMerge).destination).toBe(FLY_MAKER);
  }
  expect(lines.filter((l) => l.action === "merge" && l.outcome === "ok")).toHaveLength(5);
});

test("runRefill swaps for the trader until the balance recovers", async () => {
  // Each successful swap credits 8,000 USDC on the next horizon read:
  // 1000 -> 9000 -> 17000 -> 25000 crosses the 20,000 target after 3 swaps.
  let usdc = 1000;
  const { deps, submitted } = (() => {
    const f = fakeDeps({
      balances: (addr): Record<string, number> => (addr === FLY_MAKER ? { XLM: 45000 } : { USDC: usdc }),
    });
    const inner = f.deps.submit!;
    f.deps.submit = async (xdr) => {
      const r = await inner(xdr);
      usdc += 8000;
      return r;
    };
    return f;
  })();
  const r = await runRefill(parseRefillArgs([]), deps);
  expect(r.summary.swaps).toBe(3);
  expect(r.summary.traderUsdc).toBe(25000);
  for (const xdr of submitted) {
    const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE) as StellarSdk.Transaction;
    expect(tx.operations.map((o) => o.type)).toEqual(["pathPaymentStrictSend", "accountMerge"]);
  }
});

test("runRefill caps swaps at --max-accounts when the balance lags", async () => {
  const { deps, funded } = fakeDeps({
    balances: (addr): Record<string, number> => (addr === FLY_MAKER ? { XLM: 45000 } : { USDC: 1000 }),
  });
  const r = await runRefill(parseRefillArgs(["--max-accounts", "3"]), deps);
  expect(funded).toHaveLength(3);
  expect(r.summary.swaps).toBe(3);
  expect(r.summary.errors).toBe(0);
});

test("runRefill records an error and stops when friendbot fails", async () => {
  const { deps, lines, submitted } = fakeDeps({
    balances: (addr): Record<string, number> => (addr === FLY_MAKER ? { XLM: 10000 } : { USDC: 12000 }),
    friendbotOk: false,
  });
  const r = await runRefill(parseRefillArgs([]), deps);
  expect(submitted).toHaveLength(0);
  expect(r.summary.errors).toBe(1);
  expect(r.line.startsWith("REFILL err ")).toBe(true);
  expect(lines.some((l) => l.action === "friendbot" && l.outcome === "err")).toBe(true);
});

test("runRefill treats a missing balance as an error, not an empty account", async () => {
  const { deps, funded } = fakeDeps({ balances: (): Record<string, number> => ({}) });
  const r = await runRefill(parseRefillArgs([]), deps);
  expect(funded).toHaveLength(0);
  expect(r.summary.errors).toBe(2);
  expect(r.summary.makerXlm).toBeNull();
  expect(r.summary.traderUsdc).toBeNull();
});

test("runRefill stops merging after a failed submit", async () => {
  const { deps, submitted } = fakeDeps({
    balances: (addr): Record<string, number> => (addr === FLY_MAKER ? { XLM: 10000 } : { USDC: 12000 }),
    submitOk: false,
  });
  const r = await runRefill(parseRefillArgs([]), deps);
  expect(submitted).toHaveLength(1);
  expect(r.summary.merges).toBe(0);
  expect(r.summary.errors).toBe(1);
});
