import { spawnSync } from "node:child_process";
import * as StellarSdk from "@stellar/stellar-sdk";
import { secretEnvName } from "./math";

export type Identity = {
  name: string;
  secret: string;
  address: string;
};

export type IdentityOpts = {
  env?: Record<string, string | undefined>;
  spawn?: typeof spawnSync;
};

function validSecret(s: string): boolean {
  if (!s.startsWith("S") || s.length !== 56) return false;
  try {
    StellarSdk.Keypair.fromSecret(s);
    return true;
  } catch {
    return false;
  }
}

export function loadIdentity(name: string, configDir: string, opts?: IdentityOpts): Identity {
  const env = opts?.env ?? process.env;
  const fromEnv = env[secretEnvName(name)] ?? env[`PB_SECRET_${name}`];
  let secret = typeof fromEnv === "string" ? fromEnv.trim() : "";
  if (!secret) {
    const spawn = opts?.spawn ?? spawnSync;
    const r = spawn("stellar", ["keys", "secret", name, "--config-dir", configDir], { encoding: "utf8" });
    secret = (r.stdout ?? "").trim().split(/\n/).pop() ?? "";
  }
  if (!validSecret(secret)) throw new Error(`could not load identity ${name}`);
  const kp = StellarSdk.Keypair.fromSecret(secret);
  return { name, secret, address: kp.publicKey() };
}
