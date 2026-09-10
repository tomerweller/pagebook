// Testnet reserve refill: tops the bots back up with friendbot money before a
// drained balance turns into the ADR-033 failure mode (every ask-side replace
// rejected at simulation for want of escrow collateral). Signs only with
// locally generated throwaway keys — it needs no bot identity or secret.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as StellarSdk from "@stellar/stellar-sdk";
import { readAccount, type AccountState } from "../src/client/account";
import { NETWORK_PASSPHRASE } from "../src/client/network";
import { createRpc, type Rpc } from "../src/client/rpc";
import { parseArgs, type ArgSpec } from "./lib/args";
import { fetchBalances } from "./lib/horizon";
import { openLog, type OpsLog } from "./lib/opslog";
import { sleep } from "./lib/submitlog";

export const FLY_MAKER = "GDBXA45UBW2O3UH2RJOCOBXRGEMIP5745RQRINZZ2WHKECHHKKUWDOBH";
export const FLY_TRADER = "GBTQA6F4QWMC4IK7L4NO5H57J336NM7UB4GGZEZTGSGKWPX2DYVPBRY6";
export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export const FRIENDBOT_URL = "https://friendbot.stellar.org";
// Friendbot grants 10,000 XLM; a merge delivers all of it minus the tx fee.
export const MERGE_YIELD_XLM = 9_999;
export const FEE_STROOPS_PER_OP = 100n;
export const TX_TIMEOUT_SEC = 60;
export const STROOPS = 10_000_000n;
// Any USDC is better than a stuck trader; the testnet DEX rate is arbitrary
// anyway (ADR-026 got 1.78 USDC per XLM), so the strict-send floor is nominal.
export const DEST_MIN_USDC = "0.0000001";

export type RefillArgs = {
  maker: string;
  trader: string;
  usdcIssuer: string;
  horizon: string;
  rpc: string;
  friendbot: string;
  xlmFloor: number;
  xlmTarget: number;
  usdcFloor: number;
  usdcTarget: number;
  maxAccounts: number;
  network: string;
  dryRun: boolean;
  log: string;
};

// The maker's free (account) balance must cover escrow pay-ins even in the
// worst case where every order settles back to the account and the whole
// 20-level ask ladder (~27,800 XLM) re-rests at once: floor at 30,000.
export const REFILL_SPECS: ArgSpec<keyof RefillArgs & string>[] = [
  { flag: "--maker", dest: "maker", default: FLY_MAKER },
  { flag: "--trader", dest: "trader", default: FLY_TRADER },
  { flag: "--usdc-issuer", dest: "usdcIssuer", default: USDC_ISSUER },
  { flag: "--horizon", dest: "horizon", default: "https://horizon-testnet.stellar.org" },
  { flag: "--rpc", dest: "rpc", default: "https://soroban-testnet.stellar.org" },
  { flag: "--friendbot", dest: "friendbot", default: FRIENDBOT_URL },
  { flag: "--xlm-floor", dest: "xlmFloor", type: "float", default: 30_000 },
  { flag: "--xlm-target", dest: "xlmTarget", type: "float", default: 50_000 },
  { flag: "--usdc-floor", dest: "usdcFloor", type: "float", default: 5_000 },
  { flag: "--usdc-target", dest: "usdcTarget", type: "float", default: 20_000 },
  { flag: "--max-accounts", dest: "maxAccounts", type: "int", default: 8 },
  { flag: "--network", dest: "network", default: "testnet" },
  { flag: "--dry-run", dest: "dryRun", type: "bool" },
  { flag: "--log", dest: "log", default: "ops/refill.log" },
];

export function parseRefillArgs(argv: string[]): RefillArgs {
  return parseArgs<RefillArgs>(argv, REFILL_SPECS);
}

export function xlmAccountsNeeded(balance: number, target: number): number {
  if (balance >= target) return 0;
  return Math.ceil((target - balance) / MERGE_YIELD_XLM);
}

export function stroopsToAmount(v: bigint): string {
  if (v < 0n) throw new Error(`negative amount: ${v}`);
  return `${v / STROOPS}.${(v % STROOPS).toString().padStart(7, "0")}`;
}

function builder(pubkey: string, sequence: bigint, ops: number): StellarSdk.TransactionBuilder {
  const source = new StellarSdk.Account(pubkey, sequence.toString());
  return new StellarSdk.TransactionBuilder(source, {
    fee: (FEE_STROOPS_PER_OP * BigInt(ops)).toString(),
    networkPassphrase: NETWORK_PASSPHRASE,
  });
}

export function buildMergeTx(secret: string, sequence: bigint, dest: string): string {
  const kp = StellarSdk.Keypair.fromSecret(secret);
  const tx = builder(kp.publicKey(), sequence, 1)
    .addOperation(StellarSdk.Operation.accountMerge({ destination: dest }))
    .setTimeout(TX_TIMEOUT_SEC)
    .build();
  tx.sign(kp);
  return tx.toXDR();
}

// One tx from the throwaway: sell nearly all its XLM into USDC delivered to
// the trader (the throwaway never holds USDC, so no trustline needed), then
// merge the reserve residue in after it. Merge is last, so the whole tx fails
// atomically if the path does.
export function buildSwapMergeTx(opts: {
  secret: string;
  sequence: bigint;
  dest: string;
  usdcIssuer: string;
  sendXlm: string;
}): string {
  const kp = StellarSdk.Keypair.fromSecret(opts.secret);
  const usdc = new StellarSdk.Asset("USDC", opts.usdcIssuer);
  const tx = builder(kp.publicKey(), opts.sequence, 2)
    .addOperation(
      StellarSdk.Operation.pathPaymentStrictSend({
        sendAsset: StellarSdk.Asset.native(),
        sendAmount: opts.sendXlm,
        destination: opts.dest,
        destAsset: usdc,
        destMin: DEST_MIN_USDC,
        path: [],
      }),
    )
    .addOperation(StellarSdk.Operation.accountMerge({ destination: opts.dest }))
    .setTimeout(TX_TIMEOUT_SEC)
    .build();
  tx.sign(kp);
  return tx.toXDR();
}

// How much XLM a fresh throwaway can path-pay away: its spendable balance
// less this tx's fee. The two base reserves stay behind and ride the merge.
export function swapSendStroops(state: AccountState): bigint {
  const out = state.spendable - 2n * FEE_STROOPS_PER_OP;
  return out < 0n ? 0n : out;
}

export type SubmitOutcome = { ok: boolean; hash?: string; error?: string };

export async function submitAndWait(rpc: Rpc, xdr: string, sleepFn: (ms: number) => Promise<void> = sleep): Promise<SubmitOutcome> {
  let sent;
  try {
    sent = await rpc.sendTransaction(xdr);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  const hash = sent.hash;
  if (!hash || sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
    return { ok: false, hash, error: sent.message || sent.status || "sendTransaction failed" };
  }
  let delay = 400;
  for (let i = 0; i < 20; i++) {
    await sleepFn(delay);
    try {
      const r = await rpc.getTransaction(hash);
      if (r.status === "SUCCESS") return { ok: true, hash };
      if (r.status === "FAILED") return { ok: false, hash, error: "transaction failed" };
    } catch (e) {
      return { ok: false, hash, error: String(e) };
    }
    delay = Math.min(Math.round(delay * 1.5), 2000);
  }
  return { ok: false, hash, error: "timed out waiting for transaction" };
}

export type Friendbot = (addr: string) => Promise<{ ok: boolean; error?: string }>;

function defaultFriendbot(base: string): Friendbot {
  return async (addr) => {
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}?addr=${encodeURIComponent(addr)}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return { ok: true };
      let detail = "";
      try {
        const j = (await res.json()) as Record<string, unknown>;
        detail = [j.detail, j.title].filter((x) => typeof x === "string").join(" ");
      } catch {
        detail = "";
      }
      return { ok: false, error: detail || `friendbot ${res.status}` };
    } catch (e) {
      return { ok: false, error: `friendbot: ${String(e)}` };
    }
  };
}

export type RefillDeps = {
  rpc?: Rpc;
  log?: OpsLog;
  balances?: (addr: string) => Promise<Record<string, number>>;
  friendbot?: Friendbot;
  account?: (pubkey: string) => Promise<AccountState>;
  submit?: (xdr: string) => Promise<SubmitOutcome>;
  keygen?: () => StellarSdk.Keypair;
  sleep?: (ms: number) => Promise<void>;
};

export type RefillSummary = {
  makerXlm: number | null;
  traderUsdc: number | null;
  merges: number;
  swaps: number;
  errors: number;
  dry: boolean;
};

async function waitFunded(
  account: (pubkey: string) => Promise<AccountState>,
  pubkey: string,
  sleepFn: (ms: number) => Promise<void>,
): Promise<AccountState | null> {
  for (let i = 0; i < 10; i++) {
    const st = await account(pubkey);
    if (st.exists && st.balance > 0n) return st;
    await sleepFn(500);
  }
  return null;
}

export async function runRefill(a: RefillArgs, deps: RefillDeps = {}): Promise<{ line: string; summary: RefillSummary }> {
  const rpc = deps.rpc ?? createRpc(a.rpc);
  const log = deps.log ?? openLog(a.log);
  const balances = deps.balances ?? ((addr: string) => fetchBalances(a.horizon, addr));
  const friendbot = deps.friendbot ?? defaultFriendbot(a.friendbot);
  const account = deps.account ?? ((pub: string) => readAccount(rpc, pub));
  const sleepFn = deps.sleep ?? sleep;
  const submit = deps.submit ?? ((xdr: string) => submitAndWait(rpc, xdr, sleepFn));
  const keygen = deps.keygen ?? (() => StellarSdk.Keypair.random());

  let merges = 0;
  let swaps = 0;
  let errors = 0;

  // Maker XLM: merge whole friendbot throwaways in until the target is met.
  const makerXlm = (await balances(a.maker)).XLM ?? null;
  if (makerXlm == null) {
    // fetchBalances swallows transport errors into {}; refusing to fund on a
    // blind read beats topping up an account we cannot see.
    log.record("maker", "err", { reason: "no XLM balance from horizon", addr: a.maker });
    errors += 1;
  } else if (makerXlm >= a.xlmFloor) {
    log.record("maker", "ok", { xlm: makerXlm, floor: a.xlmFloor });
  } else {
    const count = Math.min(xlmAccountsNeeded(makerXlm, a.xlmTarget), a.maxAccounts);
    if (a.dryRun) {
      log.record("maker", "dry", { xlm: makerXlm, target: a.xlmTarget, accounts: count });
    } else {
      log.record("maker", "low", { xlm: makerXlm, floor: a.xlmFloor, target: a.xlmTarget, accounts: count });
      for (let i = 0; i < count; i++) {
        const kp = keygen();
        const fb = await friendbot(kp.publicKey());
        if (!fb.ok) {
          log.record("friendbot", "err", { addr: kp.publicKey(), error: fb.error });
          errors += 1;
          break;
        }
        const st = await waitFunded(account, kp.publicKey(), sleepFn);
        if (!st) {
          log.record("merge", "err", { from: kp.publicKey(), error: "funded account never appeared" });
          errors += 1;
          break;
        }
        const res = await submit(buildMergeTx(kp.secret(), st.sequence, a.maker));
        log.record("merge", res.ok ? "ok" : "err", {
          to: a.maker,
          from: kp.publicKey(),
          xlm: stroopsToAmount(st.balance),
          tx: res.hash ?? "",
          ...(res.ok ? {} : { error: res.error }),
        });
        if (!res.ok) {
          errors += 1;
          break;
        }
        merges += 1;
      }
    }
  }

  // Trader USDC: the DEX rate is unknowable up front, so swap one throwaway
  // at a time and re-read the balance until the target (or the cap) is hit.
  let traderUsdc = (await balances(a.trader)).USDC ?? null;
  if (traderUsdc == null) {
    log.record("trader", "err", { reason: "no USDC balance from horizon", addr: a.trader });
    errors += 1;
  } else if (traderUsdc >= a.usdcFloor) {
    log.record("trader", "ok", { usdc: traderUsdc, floor: a.usdcFloor });
  } else if (a.dryRun) {
    log.record("trader", "dry", { usdc: traderUsdc, target: a.usdcTarget, maxAccounts: a.maxAccounts });
  } else {
    log.record("trader", "low", { usdc: traderUsdc, floor: a.usdcFloor, target: a.usdcTarget });
    for (let i = 0; i < a.maxAccounts && traderUsdc < a.usdcTarget; i++) {
      const kp = keygen();
      const fb = await friendbot(kp.publicKey());
      if (!fb.ok) {
        log.record("friendbot", "err", { addr: kp.publicKey(), error: fb.error });
        errors += 1;
        break;
      }
      const st = await waitFunded(account, kp.publicKey(), sleepFn);
      if (!st) {
        log.record("swap", "err", { from: kp.publicKey(), error: "funded account never appeared" });
        errors += 1;
        break;
      }
      const res = await submit(
        buildSwapMergeTx({
          secret: kp.secret(),
          sequence: st.sequence,
          dest: a.trader,
          usdcIssuer: a.usdcIssuer,
          sendXlm: stroopsToAmount(swapSendStroops(st)),
        }),
      );
      log.record("swap", res.ok ? "ok" : "err", {
        to: a.trader,
        from: kp.publicKey(),
        xlm: stroopsToAmount(swapSendStroops(st)),
        tx: res.hash ?? "",
        ...(res.ok ? {} : { error: res.error }),
      });
      if (!res.ok) {
        errors += 1;
        break;
      }
      swaps += 1;
      // Horizon can lag the RPC's SUCCESS by a ledger; poll briefly for the
      // credit, and fall back to the stale reading (the account cap still
      // bounds the loop) if it never shows.
      for (let tries = 0; tries < 5; tries++) {
        const b = (await balances(a.trader)).USDC;
        if (b != null && b > traderUsdc) {
          traderUsdc = b;
          break;
        }
        await sleepFn(2000);
      }
    }
  }

  const summary: RefillSummary = { makerXlm, traderUsdc, merges, swaps, errors, dry: a.dryRun };
  const outcome = errors ? "err" : a.dryRun ? "dry" : "ok";
  log.record("summary", outcome, { ...summary });
  const line = `REFILL ${outcome} ${JSON.stringify(summary)}`;
  return { line, summary };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const a = parseRefillArgs(argv);
  if (a.network !== "testnet") throw new Error("refill is friendbot-funded and only makes sense on testnet");
  const r = await runRefill(a);
  process.stdout.write(r.line + "\n");
  return r.summary.errors ? 1 : 0;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) {
  main()
    .then((code) => {
      if (code) process.exit(code);
    })
    .catch((e) => {
      process.stderr.write(String(e) + "\n");
      process.exit(1);
    });
}
