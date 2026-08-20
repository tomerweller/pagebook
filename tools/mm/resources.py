#!/usr/bin/env python3
"""Sample landed testnet transactions per invocation category and collect,
for each: the DECLARED resources (the padded footprint and limits the client
signed: entries, instructions, bytes, resource fee) from the envelope, the
ACTUAL usage the host metered (`core_metrics` diagnostic events: cpu
instructions, entries and bytes read/written, events), and the fee actually
charged (`TransactionResult.fee_charged`).

Categories come from the maker/trader logs (tools/mm/mm.log, trader.log):
post-only places, heal walks (bucketed by phantom levels crossed), replaces,
batch replaces, settles, trader takes (bucketed by levels crossed), trader
rests. RPC retains about a day of history, so sampling walks each log
backwards from the end.

  python3 tools/mm/resources.py --contract C... [--per-cat 30] --out r.json
"""
import argparse
import collections
import concurrent.futures
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "soak"))
import soak  # noqa: E402


def categorize(path, kind):
    """Yield (category, txhash, meta) newest-first."""
    lines = open(path).read().splitlines()
    for line in reversed(lines):
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("outcome") != "ok" or not d.get("tx"):
            continue
        a = d["action"]
        if kind == "mm":
            if a == "place":
                yield "place post-only (maker quote)", d["tx"], {}
            elif a == "heal":
                p = d.get("phantoms") or 0
                b = "heal walk, 1-8 phantom levels" if p <= 8 else "heal walk, 9+ phantom levels"
                yield b, d["tx"], {"phantoms": p}
            elif a == "replace":
                yield "replace (single quote)", d["tx"], {}
            elif a == "replace_batch":
                yield "replace_batch (6-8 quotes)", d["tx"], {}
            elif a == "settle":
                yield "settle", d["tx"], {}
        else:
            if a == "take":
                c = d.get("crossed") or 0
                if c <= 1:
                    b = "place take, 0-1 levels crossed"
                elif c <= 3:
                    b = "place take, 2-3 levels crossed"
                else:
                    b = "place take, 4+ levels crossed"
                yield b, d["tx"], {"crossed": c, "lots": d.get("lots")}
            elif a == "rest":
                yield "place rest inside spread (trader)", d["tx"], {}
            elif a == "settle":
                yield "settle", d["tx"], {}


def fetch(cli, cat, h, meta):
    try:
        r = cli.rpc_call("getTransaction", {"hash": h})
        if r.get("status") != "SUCCESS":
            return None
        rc, out, _ = cli._run(["xdr", "decode", "--type", "TransactionEnvelope", "--output", "json"], stdin=r["envelopeXdr"])
        env = json.loads(out)
        tx = env["tx"]["tx"]
        sd = tx["ext"]["v1"]
        res = sd["resources"]
        fp = res["footprint"]
        rec = {
            "cat": cat, "tx": h, **meta,
            "d_ro": len(fp["read_only"]), "d_rw": len(fp["read_write"]),
            "d_instr": int(res["instructions"]), "d_read_b": int(res["disk_read_bytes"]), "d_write_b": int(res["write_bytes"]),
            "d_fee": int(sd["resource_fee"]), "tx_fee": int(tx["fee"]),
        }
        rc, out, _ = cli._run(["xdr", "decode", "--type", "TransactionResult", "--output", "json"], stdin=r["resultXdr"])
        rec["fee_charged"] = int(json.loads(out)["fee_charged"])
        for e in r.get("diagnosticEventsXdr") or []:
            rc, out, _ = cli._run(["xdr", "decode", "--type", "DiagnosticEvent", "--output", "json"], stdin=e)
            b = json.loads(out)["event"]["body"]["v0"]
            t = b["topics"]
            if len(t) == 2 and t[0].get("symbol") == "core_metrics":
                rec["a_" + t[1]["symbol"]] = int(b["data"]["u64"])
        return rec
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--contract", required=True)
    ap.add_argument("--config-dir", default=".stellar")
    ap.add_argument("--network", default="testnet")
    ap.add_argument("--rpc", default="https://soroban-testnet.stellar.org")
    ap.add_argument("--mm-log", default="tools/mm/mm.log")
    ap.add_argument("--trader-log", default="tools/mm/trader.log")
    ap.add_argument("--per-cat", type=int, default=30)
    ap.add_argument("--out", default="resources.json")
    a = ap.parse_args()
    cli = soak.Cli(a.contract, a.config_dir, a.network, a.rpc)

    picked = collections.defaultdict(list)
    for path, kind in ((a.mm_log, "mm"), (a.trader_log, "trader")):
        if not os.path.exists(path):
            continue
        for cat, h, meta in categorize(path, kind):
            if len(picked[cat]) < a.per_cat:
                picked[cat].append((cat, h, meta))
    jobs = [j for v in picked.values() for j in v]
    print(f"{len(jobs)} transactions across {len(picked)} categories", file=sys.stderr)
    out = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        futs = [ex.submit(fetch, cli, *j) for j in jobs]
        for i, f in enumerate(concurrent.futures.as_completed(futs)):
            r = f.result()
            if r:
                out.append(r)
            if (i + 1) % 25 == 0:
                print(f"{i+1}/{len(jobs)}", file=sys.stderr)
    with open(a.out, "w") as f:
        json.dump(out, f)
    print(f"wrote {len(out)} records to {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
