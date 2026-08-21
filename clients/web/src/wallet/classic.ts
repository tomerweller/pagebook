import * as StellarSdk from "@stellar/stellar-sdk";
import type { Rpc } from "../book";
import { NETWORK_PASSPHRASE } from "./network";
import { readAccount, type CreditAsset } from "./account";

export type SubmitResult = {
  status: "SUCCESS" | "FAILED" | "ALREADY_FUNDED";
  hash?: string;
  error?: string;
};

const FRIENDBOT = "https://friendbot.stellar.org/";
const FEE_STROOPS_PER_OP = 100;
const TX_TIMEOUT_SEC = 60;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fundWithFriendbot(pubkey: string): Promise<SubmitResult> {
  try {
    const url = `${FRIENDBOT}?addr=${encodeURIComponent(pubkey)}`;
    const res = await fetch(url);
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const hash = typeof body.hash === "string" ? body.hash : undefined;
    if (res.ok) return { status: "SUCCESS", hash };
    const detail = [body.detail, body.title, body.invalid_field].filter((x) => typeof x === "string").join(" ");
    const extras = body.extras && typeof body.extras === "object" ? JSON.stringify(body.extras) : "";
    const msg = detail || extras || `friendbot ${res.status}`;
    if (res.status === 400 && /already|exist/i.test(msg + extras)) {
      return { status: "ALREADY_FUNDED", hash, error: msg };
    }
    return { status: "FAILED", error: msg };
  } catch (e) {
    return { status: "FAILED", error: `friendbot: ${errMsg(e)}` };
  }
}

async function waitForTx(rpc: Rpc, hash: string): Promise<SubmitResult> {
  let delay = 400;
  for (let i = 0; i < 20; i++) {
    await sleep(delay);
    try {
      const r = await rpc.getTransaction(hash);
      if (r.status === "SUCCESS") return { status: "SUCCESS", hash };
      if (r.status === "FAILED") return { status: "FAILED", hash, error: "transaction failed" };
    } catch (e) {
      return { status: "FAILED", hash, error: errMsg(e) };
    }
    delay = Math.min(Math.round(delay * 1.5), 2000);
  }
  return { status: "FAILED", hash, error: "timed out waiting for transaction" };
}

export async function addTrustline(rpc: Rpc, secret: string, asset: CreditAsset): Promise<SubmitResult> {
  try {
    const kp = StellarSdk.Keypair.fromSecret(secret);
    const acc = await readAccount(rpc, kp.publicKey());
    if (!acc.exists) return { status: "FAILED", error: "account not funded" };
    const stellarAsset = new StellarSdk.Asset(asset.code, asset.issuer);
    const source = new StellarSdk.Account(kp.publicKey(), acc.sequence.toString());
    const tx = new StellarSdk.TransactionBuilder(source, {
      fee: String(FEE_STROOPS_PER_OP),
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(StellarSdk.Operation.changeTrust({ asset: stellarAsset }))
      .setTimeout(TX_TIMEOUT_SEC)
      .build();
    tx.sign(kp);
    const sent = await rpc.sendTransaction(tx.toXDR());
    const hash = sent.hash;
    if (!hash) return { status: "FAILED", error: sent.message || sent.status || "sendTransaction returned no hash" };
    if (sent.status === "ERROR") {
      return { status: "FAILED", hash, error: sent.message || "sendTransaction ERROR" };
    }
    if (sent.status === "TRY_AGAIN_LATER") {
      return { status: "FAILED", hash, error: "RPC asked to try again later" };
    }
    return waitForTx(rpc, hash);
  } catch (e) {
    return { status: "FAILED", error: errMsg(e) };
  }
}
