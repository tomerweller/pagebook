import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
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
  cwd?: string;
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

export function findConfigDir(opts?: {
  start?: string;
  env?: Record<string, string | undefined>;
  fallback?: string;
}): string {
  const env = opts?.env ?? process.env;
  if (env.STELLAR_CONFIG_DIR) return env.STELLAR_CONFIG_DIR;
  let dir = opts?.start ?? process.cwd();
  for (;;) {
    const candidate = join(dir, ".stellar");
    if (existsSync(join(candidate, "identity"))) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return opts?.fallback ?? ".stellar";
}

export function resolveConfigDir(
  configDir: string,
  opts?: { start?: string; env?: Record<string, string | undefined> },
): string {
  if (existsSync(join(configDir, "identity"))) return configDir;
  return findConfigDir({ start: opts?.start, env: opts?.env, fallback: configDir });
}

export function loadIdentity(name: string, configDir: string, opts?: IdentityOpts): Identity {
  const env = opts?.env ?? process.env;
  const fromEnv = env[secretEnvName(name)] ?? env[`PB_SECRET_${name}`];
  let secret = typeof fromEnv === "string" ? fromEnv.trim() : "";
  if (!secret) {
    const resolved = resolveConfigDir(configDir, { start: opts?.cwd, env });
    const spawn = opts?.spawn ?? spawnSync;
    const r = spawn("stellar", ["keys", "secret", name, "--config-dir", resolved], { encoding: "utf8" });
    if (r.error) {
      const code = r.error.code;
      if (code === "ENOENT") throw new Error(`stellar CLI not found (needed to load identity ${name})`);
      throw new Error(`could not run stellar: ${r.error.message}`);
    }
    secret = (r.stdout ?? "").trim().split(/\n/).pop() ?? "";
  }
  if (!validSecret(secret)) throw new Error(`could not load identity ${name}`);
  const kp = StellarSdk.Keypair.fromSecret(secret);
  return { name, secret, address: kp.publicKey() };
}
