import type { Rpc } from "../book";

export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

export function isTestnetPassphrase(passphrase: string): boolean {
  return passphrase === NETWORK_PASSPHRASE;
}

export type NetworkCheck =
  | { ok: true; passphrase: string }
  | { ok: false; reason: string; passphrase?: string };

export async function checkTestnet(rpc: Rpc): Promise<NetworkCheck> {
  try {
    const net = await rpc.getNetwork();
    const passphrase = String(net.passphrase ?? "");
    if (isTestnetPassphrase(passphrase)) return { ok: true, passphrase };
    return { ok: false, reason: "wallet disabled: not testnet", passphrase };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `wallet disabled: ${msg}` };
  }
}
