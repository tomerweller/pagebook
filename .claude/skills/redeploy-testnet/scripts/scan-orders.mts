// List an identity's live `Order` entries on a PageBook contract by scanning a
// nonce range through batched getLedgerEntries. Order entries exist only while
// an order is live (settle deletes them), so every hit is an order that still
// holds escrow. Use it after a wind-down to find orders the maker's state file
// never recorded (a duplicate bot, a kill mid-cycle), and to build a state file
// for `mm.ts --cancel-all`.
//
// Bot nonces are `boot_seconds * 1000 + k`: the maker's from its state file's
// creation, the trader's from its last boot. Read the base from the state file
// (`next_nonce`) or from one known transaction of the identity, and scan a few
// thousand past it.
//
//   cd clients/web
//   npx tsx ../../.claude/skills/redeploy-testnet/scripts/scan-orders.mts <contract> <G-owner> <from-nonce> <to-nonce> [--market N] [--state out.json]
import { writeFileSync } from "node:fs";
import { orderKey } from "../../../../clients/web/src/keys";
import { createRpc, fetchEntries } from "../../../../clients/web/src/client/rpc";
import { indexByKey, readNative } from "../../../../clients/web/src/client/entries";

const args = process.argv.slice(2);
function opt(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const market = Number(opt("--market") ?? 0);
const stateOut = opt("--state");
const pos = args.filter((a, i) => !a.startsWith("--") && !["--market", "--state"].includes(args[i - 1] ?? ""));
const [contract, owner, fromS, toS] = pos;
if (!contract || !owner || !fromS || !toS) {
  console.error("usage: scan-orders.mts <contract> <G-owner> <from-nonce> <to-nonce> [--market N] [--state out.json]");
  process.exit(2);
}
const from = BigInt(fromS);
const to = BigInt(toS);
const rpc = createRpc(process.env.PB_RPC ?? "https://soroban-testnet.stellar.org");
const BATCH = 200n;
const found: Record<string, unknown>[] = [];
for (let n = from; n < to; n += BATCH) {
  const end = n + BATCH < to ? n + BATCH : to;
  const keys = [];
  for (let k = n; k < end; k++) keys.push(orderKey(contract, market, owner, k));
  const res = await fetchEntries(rpc, keys);
  const map = indexByKey(res.entries);
  for (let k = n; k < end; k++) {
    const key = orderKey(contract, market, owner, k);
    const o = readNative(map, key) as Record<string, unknown> | null;
    if (o) found.push({ nonce: k.toString(), ...o });
  }
}
console.log(`${found.length} live order(s) for ${owner} on ${contract} market ${market} in [${from}, ${to})`);
for (const o of found) console.log(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
if (stateOut) {
  // mm.ts state shape: quotes keyed by nonce with side, tick, lots, slot.
  const quotes: Record<string, unknown> = {};
  for (const o of found) {
    quotes[String(o.nonce)] = {
      side: o.is_bid ? "bid" : "ask",
      tick: Number(o.tick),
      lots: Number(o.qty_lots),
      slot: Number(o.slot ?? 0),
      t: Date.now() / 1000,
    };
  }
  writeFileSync(stateOut, JSON.stringify({ quotes, next_nonce: Number(to), fills: 0, volume_lots: 0 }, null, 1));
  console.log(`wrote ${stateOut}`);
}
