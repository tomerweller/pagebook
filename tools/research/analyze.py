#!/usr/bin/env python3
"""Issue #5 task 3: decompose the pad's declared write bytes per shape.

Builds and simulates each shape (no submission), unions the pad, classifies
every read-write footprint key (from simulation read-write, promoted from
read-only, added fresh) and existence/size via getLedgerEntries, then prints
the declared-write-byte decomposition:

  declared = sim_wb + 600 * added
  floor    = sum over existing RW keys of (data + 8) + created entries
  slices   = owed coverage for existing added keys, flat-600 overestimate on
             those, 600 for nonexistent added keys, sim-side slack

Run after decompose.py bisections; cross-checks the measured minimal values.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import decompose  # noqa: E402
import soak  # noqa: E402

MEASURED = {  # from decompose.log bisections/probes
    "a": {"min_wb": 3736, "metered_wb": 3736, "min_instr": (3065713, 3077029), "metered_instr": 3067565},
    "b": {"min_wb": 3736, "metered_wb": 3736, "min_instr": (3390000, 3395000), "metered_instr": 3394186},
    "c": {"min_wb": 53380, "metered_wb": 53380, "min_instr": (82440000, 82460000), "metered_instr": 82450807},
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shapes", default="a,b,c")
    ap.add_argument("--config-dir", default=".stellar")
    ap.add_argument("--network", default="testnet")
    ap.add_argument("--rpc", default="https://soroban-testnet.stellar.org")
    a = ap.parse_args()
    a.shape = None
    r = decompose.R(a)
    for shape in a.shapes.split(","):
        src, fn, args, pad, tag = r.shape(shape)
        xdr = r.cli.build(src, fn, args)
        sim = r.cli.simulate(src, xdr)
        obj = r.cli.decode(sim)
        res0 = obj["tx"]["tx"]["ext"]["v1"]["resources"]
        sim_wb = int(res0["write_bytes"])
        sim_rw = [json.dumps(k, sort_keys=True) for k in res0["footprint"]["read_write"]]
        sim_ro = [json.dumps(k, sort_keys=True) for k in res0["footprint"]["read_only"]]
        added = soak.apply_pad(obj, pad)
        res = obj["tx"]["tx"]["ext"]["v1"]["resources"]
        rw_keys = res["footprint"]["read_write"]
        decl_wb = int(res["write_bytes"])
        sizes = decompose.fetch_entry_sizes(r.cli, r.key_xdr, rw_keys)
        rows = []
        for k in rw_keys:
            s = json.dumps(k, sort_keys=True)
            exists, cov = sizes[s]
            origin = "sim_rw" if s in sim_rw else ("promoted" if s in sim_ro else "added")
            rows.append({"type": decompose.key_type_name(k), "origin": origin, "exists": exists, "cov": cov})
        n_added = sum(1 for x in rows if x["origin"] != "sim_rw")
        assert n_added == added
        ex_added = [x for x in rows if x["origin"] != "sim_rw" and x["exists"]]
        nx_added = [x for x in rows if x["origin"] != "sim_rw" and not x["exists"]]
        owed = sum(x["cov"] for x in ex_added)
        sim_cov = sum(x["cov"] for x in rows if x["origin"] == "sim_rw" and x["exists"])
        created_cov = MEASURED[shape]["min_wb"] - owed - sim_cov  # what creations must add
        m = MEASURED[shape]
        print(f"== shape {shape} ({fn}) ==")
        print(f"  final RW {len(rows)} = sim_rw {len(rows)-n_added} + promoted {sum(1 for x in rows if x['origin']=='promoted')} + added {sum(1 for x in rows if x['origin']=='added')}")
        print(f"  sim_wb {sim_wb:,}  declared {decl_wb:,} (= sim + 600 x {added})  minimal accepted {m['min_wb']:,}  metered {m['metered_wb']:,}")
        print(f"  floor check: sim-RW existing coverage {sim_cov:,} + owed(existing added) {owed:,} + creations {created_cov:,} = {sim_cov+owed+created_cov:,}")
        print(f"  decomposition of declared {decl_wb:,}:")
        print(f"    (i)   protocol floor                     {m['min_wb']:>8,}  ({m['min_wb']/decl_wb*100:.1f}%)")
        over_ex = 600 * len(ex_added) - owed
        print(f"    (ii)  flat-600 overestimate, {len(ex_added):>3} existing  {over_ex:>8,}  ({over_ex/decl_wb*100:.1f}%)")
        nx = 600 * len(nx_added)
        print(f"    (iii) 600 for {len(nx_added):>3} nonexistent keys       {nx:>8,}  ({nx/decl_wb*100:.1f}%)")
        slack = decl_wb - m["min_wb"] - over_ex - nx
        print(f"    (iv)  sim-side slack (sim_wb - sim need)  {slack:>7,}  ({slack/decl_wb*100:.1f}%)")
        print(f"    recoverable = declared - floor = {decl_wb - m['min_wb']:,} ({(decl_wb-m['min_wb'])/decl_wb*100:.1f}%)")
        lo, hi = m["min_instr"]
        print(f"  instructions: minimal in ({lo:,} .. {hi:,}], metered {m['metered_instr']:,}")
        print()


if __name__ == "__main__":
    main()
