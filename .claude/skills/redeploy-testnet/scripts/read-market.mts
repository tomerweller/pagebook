// Decode a PageBook contract's `Market(n)` entry straight from testnet RPC.
// The contract has no `market` view, so this is how you confirm a fresh
// deployment's market geometry and field layout (for example that a dropped
// field is really gone). Run from clients/web so tsx finds the workspace:
//
//   npx tsx ../../.claude/skills/redeploy-testnet/scripts/read-market.mts <contract> [<contract>...] [--market N]
import { ck } from "../../../../clients/web/src/keys";
import { createRpc, fetchEntries } from "../../../../clients/web/src/client/rpc";
import { entryDataSize, indexByKey, readNative } from "../../../../clients/web/src/client/entries";

const args = process.argv.slice(2);
const mi = args.indexOf("--market");
const market = mi >= 0 ? Number(args[mi + 1]) : 0;
const skip = mi >= 0 ? mi + 1 : -1;
const contracts = args.filter((a, i) => a !== "--market" && i !== skip);
if (contracts.length === 0) {
  console.error("usage: read-market.mts <contract> [<contract>...] [--market N]");
  process.exit(2);
}
const rpc = createRpc(process.env.PB_RPC ?? "https://soroban-testnet.stellar.org");
for (const c of contracts) {
  const k = ck(c, "Market", market);
  const res = await fetchEntries(rpc, [k]);
  const e = res.entries[0];
  console.log(`${c} Market(${market})`, e ? `entry bytes=${entryDataSize(e)}` : "NO ENTRY");
  if (!e) continue;
  const raw = readNative(indexByKey(res.entries), k);
  console.log(JSON.stringify(raw, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}
