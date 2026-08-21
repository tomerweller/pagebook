#!/usr/bin/env python3
"""Issue #5: decompose declared vs metered write bytes in padded transactions.

Measures, on testnet market 0 (PBA/PBB), the MINIMAL accepted write_bytes and
instructions declarations for three transaction shapes by bisection, fetches
the on-ledger sizes of the read-write footprint, and demonstrates the pad v2
(existence-aware, per-type sizes) declaration.

Shapes:
  a  post-only place: pb-stress1, fresh nonce, fresh far ask tick 62000+
  b  replace of one existing stress quote: pb-stress2, nonce 777_001_000
  c  word-dispersed batch40: pb-stress3, same composition as stress.py
     batch_once (extra pad from pb-stress4's levels)

Subcommands:
  baseline --shape a|b|c        submit once with the current pad, record all
  bisect --shape S --dim wb|instr [--tol N] [--lo N] [--hi N]
  sizes --shape c               getLedgerEntries over the padded RW footprint
  padv2 --shape c               apply_pad with sizes= and submit
  cleanup                       settle far-tick orders created by shape a

Every attempt is logged as a JSON line to tools/research/decompose.log.
"""
import argparse
import base64
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "soak"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stress"))
import soak  # noqa: E402
import stress  # noqa: E402

CONTRACT = stress.CONTRACT
MARKET = 0
BASE_SAC = stress.BASE_SAC
QUOTE_SAC = stress.QUOTE_SAC
ISSUER = stress.ISSUER
NONCE_BASE = stress.NONCE_BASE
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "decompose.log")


def token_keys(addr):
    keys = []
    for sac, code in ((BASE_SAC, "PBA"), (QUOTE_SAC, "PBB")):
        keys.append({"contract_data": {"contract": sac, "key": "ledger_key_contract_instance", "durability": "persistent"}})
        keys.append({"contract_data": {"contract": sac, "key": {"vec": [{"symbol": "Balance"}, {"address": CONTRACT}]}, "durability": "persistent"}})
        keys.append({"trustline": {"account_id": addr, "asset": {"credit_alphanum4": {"asset_code": code, "issuer": ISSUER}}}})
    keys.append(soak.ck(CONTRACT, "FeeAccrual", MARKET, BASE_SAC))
    keys.append(soak.ck(CONTRACT, "FeeAccrual", MARKET, QUOTE_SAC))
    return keys


class R:
    def __init__(self, a):
        self.a = a
        self.cli = soak.Cli(CONTRACT, a.config_dir, a.network, a.rpc)
        self.log = open(LOG, "a")
        self.addr = {}

    def address(self, key):
        if key not in self.addr:
            self.addr[key] = self.cli.address(key)
        return self.addr[key]

    def record(self, **kw):
        kw["t"] = time.time()
        self.log.write(json.dumps(kw) + "\n")
        self.log.flush()
        print(json.dumps(kw), file=sys.stderr)

    # ---- shapes: return (source, fn, args, pad, tag)
    def shape_a(self):
        src = "pb-stress1"
        addr = self.address(src)
        nonce = 999_000_000 + int(time.time()) % 1_000_000
        tick = 62000 + nonce % 3000
        window = json.dumps({"consume": [], "append": {"first": 0, "last": 1}})
        flags = json.dumps({"post_only": True, "fill_or_kill": False, "no_rest": False})
        args = ["--taker", addr, "--market", str(MARKET), "--is_bid", "false", "--limit_tick", str(tick),
                "--qty_lots", "1", "--start_tick", "65535", "--nonce", str(nonce), "--window", window, "--flags", flags]
        pad = soak.rest_keys(CONTRACT, MARKET, False, tick) + [soak.order_key(CONTRACT, MARKET, addr, nonce)] + token_keys(addr)
        return src, "place", args, pad, {"nonce": nonce, "tick": tick}

    def shape_b(self):
        src = "pb-stress2"
        addr = self.address(src)
        nonce = NONCE_BASE + 1 * 1000 + 0
        tick = stress.ticks_for(1)[0]
        window = json.dumps({"consume": [], "append": {"first": 0, "last": 1}})
        args = ["--owner", addr, "--market", str(MARKET), "--nonce", str(nonce), "--is_bid", "false",
                "--tick", str(tick), "--qty_lots", "3", "--window", window]
        pad = token_keys(addr) + soak.rest_keys(CONTRACT, MARKET, False, tick)
        return src, "replace", args, pad, {"nonce": nonce, "tick": tick}

    def shape_c(self):
        i = 2  # pb-stress3
        src = f"pb-stress{i+1}"
        addr = self.address(src)
        items = []
        pad = token_keys(addr)
        for j, tick in enumerate(stress.ticks_for(i)):
            nonce = NONCE_BASE + i * 1000 + j
            items.append({"nonce": nonce, "is_bid": False, "tick": tick, "qty_lots": 3,
                          "window": {"consume": [], "append": {"first": 0, "last": 1}}})
            pad.append(soak.ck(CONTRACT, "Level", MARKET, False, tick))
            pad.append(soak.ck(CONTRACT, "TickWord", MARKET, False, soak.word_of(tick)))
            pad.append(soak.ck(CONTRACT, "LevelPage", MARKET, False, tick, 0))
        pad.append(soak.ck(CONTRACT, "TickSummary", MARKET, False))
        pad.append(soak.ck(CONTRACT, "BestTick", MARKET, False))
        pad.append(soak.ck(CONTRACT, "BestTick", MARKET, True))
        for tick in stress.ticks_for((i + 1) % 8)[:28]:
            pad.append(soak.ck(CONTRACT, "Level", MARKET, False, tick))
        args = ["--owner", addr, "--market", str(MARKET), "--items", json.dumps(items)]
        return src, "replace_batch", args, pad, {"items": len(items)}

    def shape(self, name):
        return getattr(self, "shape_" + name)()

    # ---- pipeline with declaration override
    def attempt(self, shape_name, wb=None, instr=None, sizes=None):
        """Build, simulate, pad, optionally override declarations, submit.
        Returns a record dict (also logged)."""
        src, fn, args, pad, tag = self.shape(shape_name)
        rec = {"shape": shape_name, "fn": fn, **tag, "wb_override": wb, "instr_override": instr,
               "padv2": bool(sizes)}
        try:
            xdr = self.cli.build(src, fn, args)
            sim = self.cli.simulate(src, xdr)
        except Exception as e:
            rec["outcome"] = "sim_error"
            rec["detail"] = str(e)[-300:]
            self.record(**rec)
            return rec
        obj = self.cli.decode(sim)
        res0 = dict(obj["tx"]["tx"]["ext"]["v1"]["resources"])
        rec["sim_wb"] = int(res0["write_bytes"])
        rec["sim_instr"] = int(res0["instructions"])
        rec["sim_rw"] = len(res0["footprint"]["read_write"])
        rec["sim_ro"] = len(res0["footprint"]["read_only"])
        added = soak.apply_pad(obj, pad, sizes=sizes)
        sd = obj["tx"]["tx"]["ext"]["v1"]
        res = sd["resources"]
        rec["added"] = added
        rec["pad_wb"] = int(res["write_bytes"])
        rec["pad_instr"] = int(res["instructions"])
        rec["rw"] = len(res["footprint"]["read_write"])
        rec["ro"] = len(res["footprint"]["read_only"])
        rec["fee"] = int(sd["resource_fee"])
        if wb is not None:
            res["write_bytes"] = int(wb)
        if instr is not None:
            res["instructions"] = int(instr)
        rec["decl_wb"] = int(res["write_bytes"])
        rec["decl_instr"] = int(res["instructions"])
        final = self.cli.encode(obj)
        signed = self.cli.sign(src, final)
        rc, out, err = self.cli.send(signed)
        text = out + err
        rec["outcome"] = soak.classify(rc, out, err)
        m = re.search(r"Transaction hash is ([0-9a-f]{64})", text)
        rec["tx"] = m.group(1) if m else ""
        if rec["outcome"] != "ok":
            rec["detail"] = text[-300:]
        self.record(**rec)
        return rec

    def metered(self, tx_hash):
        """core_metrics + fee_charged of a landed (or failed-at-apply) tx."""
        for _ in range(8):
            g = self.cli.rpc_call("getTransaction", {"hash": tx_hash})
            if g.get("status") in ("SUCCESS", "FAILED"):
                break
            time.sleep(3)
        out = {"status": g.get("status"), "ledger": g.get("ledger")}
        try:
            rc, o, _ = self.cli._run(["xdr", "decode", "--type", "TransactionResult", "--output", "json"], stdin=g["resultXdr"])
            out["fee_charged"] = int(json.loads(o)["fee_charged"])
        except Exception:
            pass
        for e in g.get("diagnosticEventsXdr") or []:
            rc, o, _ = self.cli._run(["xdr", "decode", "--type", "DiagnosticEvent", "--output", "json"], stdin=e)
            try:
                b = json.loads(o)["event"]["body"]["v0"]
                t = b["topics"]
                if len(t) == 2 and t[0].get("symbol") == "core_metrics":
                    out[t[1]["symbol"]] = int(b["data"]["u64"])
            except Exception:
                continue
        return out

    # ---- subcommands
    def baseline(self):
        rec = self.attempt(self.a.shape)
        if rec.get("tx"):
            m = self.metered(rec["tx"])
            self.record(shape=self.a.shape, kind="metered", tx=rec["tx"], **m)

    def bisect(self):
        dim = self.a.dim
        shape = self.a.shape
        # known-good starting point: full pad
        base = self.attempt(shape)
        if base["outcome"] != "ok":
            print("baseline failed, aborting", file=sys.stderr)
            return
        met = self.metered(base["tx"])
        self.record(shape=shape, kind="metered", tx=base["tx"], **met)
        if dim == "wb":
            lo = self.a.lo if self.a.lo is not None else base["sim_wb"]
            hi = self.a.hi if self.a.hi is not None else base["decl_wb"]
            tol = self.a.tol or max(64, (hi - lo) // 200)
        else:
            lo = self.a.lo if self.a.lo is not None else base["sim_instr"]
            hi = self.a.hi if self.a.hi is not None else base["decl_instr"]
            tol = self.a.tol or max(50_000, (hi - lo) // 100)
        # probe the low end first: if it passes, extend downward
        n = 0
        while hi - lo > tol and n < self.a.max_steps:
            mid = (lo + hi) // 2
            kw = {"wb": mid} if dim == "wb" else {"instr": mid}
            rec = self.attempt(shape, **kw)
            n += 1
            if rec["outcome"] == "ok":
                hi = mid
            elif rec["outcome"] in ("resource_limit", "soroban_invalid"):
                lo = mid
                if rec.get("tx"):
                    m = self.metered(rec["tx"])
                    self.record(shape=shape, kind="fail_cost", tx=rec["tx"], dim=dim, at=mid, **{k: v for k, v in m.items() if k in ("status", "fee_charged")})
            else:
                print(f"unexpected outcome {rec['outcome']}, stopping", file=sys.stderr)
                break
            time.sleep(self.a.pause)
        self.record(shape=shape, kind="bisect_result", dim=dim, minimal_accepted_le=hi, rejected_ge=lo, tol=tol, steps=n,
                    sim=base["sim_wb" if dim == "wb" else "sim_instr"],
                    padded=base["pad_wb" if dim == "wb" else "pad_instr"],
                    metered=met.get("ledger_write_byte" if dim == "wb" else "cpu_insn"))
        print(json.dumps({"minimal_accepted_le": hi, "rejected_ge": lo, "steps": n}))

    def probe(self):
        """One attempt at an exact declaration value (--dim, --lo as value)."""
        kw = {"wb": self.a.lo} if self.a.dim == "wb" else {"instr": self.a.lo}
        rec = self.attempt(self.a.shape, **kw)
        print(json.dumps({"value": self.a.lo, "outcome": rec["outcome"]}))

    def key_xdr(self, k):
        rc, out, err = self.cli._run(["xdr", "encode", "--type", "LedgerKey"], stdin=json.dumps(k))
        if rc != 0:
            raise RuntimeError(err[-200:])
        return out.strip()

    def sizes(self):
        """On-ledger sizes of every RW footprint key of the padded shape."""
        src, fn, args, pad, tag = self.shape(self.a.shape)
        xdr = self.cli.build(src, fn, args)
        sim = self.cli.simulate(src, xdr)
        obj = self.cli.decode(sim)
        soak.apply_pad(obj, pad)
        fp = obj["tx"]["tx"]["ext"]["v1"]["resources"]["footprint"]
        rows = []
        for group, keys in (("rw", fp["read_write"]), ("ro", fp["read_only"])):
            b64s = [self.key_xdr(k) for k in keys]
            found = {}
            for i in range(0, len(b64s), 100):
                chunk = b64s[i:i + 100]
                r = self.cli.rpc_call("getLedgerEntries", {"keys": chunk})
                for e in r.get("entries") or []:
                    found[e["key"]] = e
            for k, b in zip(keys, b64s):
                e = found.get(b)
                rows.append({
                    "group": group, "type": key_type_name(k),
                    "key_bytes": len(base64.b64decode(b)),
                    "exists": e is not None,
                    "data_bytes": len(base64.b64decode(e["xdr"])) if e else 0,
                })
        out_path = self.a.out or os.path.join(os.path.dirname(LOG), f"sizes-{self.a.shape}.json")
        json.dump(rows, open(out_path, "w"), indent=1)
        # summary
        import collections
        agg = collections.defaultdict(lambda: [0, 0, 0, 0])  # n, n_exist, sum_data, sum_key
        for r in rows:
            if r["group"] != "rw":
                continue
            a = agg[r["type"]]
            a[0] += 1
            a[1] += r["exists"]
            a[2] += r["data_bytes"]
            a[3] += r["key_bytes"] if r["exists"] else 0
        print(f"{'type':<22}{'n':>4}{'exist':>6}{'sum data B':>12}{'sum key B':>11}")
        tot = [0, 0, 0, 0]
        for t, a in sorted(agg.items()):
            print(f"{t:<22}{a[0]:>4}{a[1]:>6}{a[2]:>12,}{a[3]:>11,}")
            for i in range(4):
                tot[i] += a[i]
        print(f"{'TOTAL rw':<22}{tot[0]:>4}{tot[1]:>6}{tot[2]:>12,}{tot[3]:>11,}")
        print(f"wrote {out_path}")

    def padv2(self):
        """Submit the shape with the existence-aware pad and report margin."""
        src, fn, args, pad, tag = self.shape(self.a.shape)
        exist_map = fetch_entry_sizes(self.cli, self.key_xdr, pad)
        sizes = {
            "exists": lambda k: exist_map.get(json.dumps(k, sort_keys=True), (False, 0))[0],
            "actual": lambda k: exist_map.get(json.dumps(k, sort_keys=True), (False, 0))[1],
            "growth": self.a.growth,
        }
        rec = self.attempt(self.a.shape, sizes=sizes)
        if rec.get("tx") and rec["outcome"] == "ok":
            m = self.metered(rec["tx"])
            self.record(shape=self.a.shape, kind="metered_padv2", tx=rec["tx"], **m)
        v1 = rec.get("sim_wb", 0) + 600 * rec.get("added", 0)
        print(json.dumps({"outcome": rec["outcome"], "decl_wb": rec.get("decl_wb"),
                          "pad_v1_wb": v1, "growth": self.a.growth}))

    def cleanup(self):
        """Settle every shape-a far-tick order still live (nonce 999xxxxxx)."""
        src = "pb-stress1"
        addr = self.address(src)
        done = 0
        for line in open(LOG):
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("shape") == "a" and d.get("outcome") == "ok" and d.get("nonce"):
                nonce, tick = d["nonce"], d["tick"]
                try:
                    self.cli.invoke_readonly(src, "order", ["--market", str(MARKET), "--owner", addr, "--nonce", str(nonce)])
                except Exception:
                    continue  # not live
                pad = token_keys(addr)
                for pg in (0, 1):
                    pad.append(soak.ck(CONTRACT, "LevelPage", MARKET, False, tick, pg))
                sargs = ["--owner", addr, "--market", str(MARKET), "--nonce", str(nonce)]
                try:
                    xdr = self.cli.build(src, "settle", sargs)
                    sim = self.cli.simulate(src, xdr)
                    obj = self.cli.decode(sim)
                    soak.apply_pad(obj, pad)
                    signed = self.cli.sign(src, self.cli.encode(obj))
                    rc, out, err = self.cli.send(signed)
                    self.record(shape="a", kind="cleanup", nonce=nonce, tick=tick, outcome=soak.classify(rc, out, err))
                    done += 1
                except Exception as e:
                    self.record(shape="a", kind="cleanup", nonce=nonce, tick=tick, outcome="error", detail=str(e)[-200:])
        print(f"settled {done}")


def key_type_name(k):
    if "trustline" in k:
        return "trustline"
    cd = k.get("contract_data", {})
    kk = cd.get("key")
    if kk == "ledger_key_contract_instance":
        return "sac_instance"
    if isinstance(kk, dict) and "vec" in kk:
        sym = kk["vec"][0].get("symbol", "?")
        if sym == "Balance":
            return "sac_balance"
        return sym
    return "other"


def fetch_entry_sizes(cli, key_xdr, keys):
    """key_str -> (exists, coverage_bytes) for a list of key JSONs.

    Coverage is the write-byte cost of declaring an existing entry
    read-write: the LedgerEntryData XDR plus the 8-byte LedgerEntry framing
    (lastModifiedLedgerSeq and ext). Key bytes are not counted; measured by
    bisection on testnet (ADR-028)."""
    b64s = [key_xdr(k) for k in keys]
    found = {}
    for i in range(0, len(b64s), 100):
        chunk = b64s[i:i + 100]
        r = cli.rpc_call("getLedgerEntries", {"keys": chunk})
        for e in r.get("entries") or []:
            found[e["key"]] = e
    out = {}
    for k, b in zip(keys, b64s):
        e = found.get(b)
        s = json.dumps(k, sort_keys=True)
        if e:
            out[s] = (True, len(base64.b64decode(e["xdr"])) + 8)
        else:
            out[s] = (False, 0)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["baseline", "bisect", "probe", "sizes", "padv2", "cleanup"])
    ap.add_argument("--shape", choices=["a", "b", "c"], default="c")
    ap.add_argument("--dim", choices=["wb", "instr"], default="wb")
    ap.add_argument("--tol", type=int)
    ap.add_argument("--lo", type=int)
    ap.add_argument("--hi", type=int)
    ap.add_argument("--max-steps", type=int, default=10)
    ap.add_argument("--pause", type=float, default=2.0)
    ap.add_argument("--growth", type=int, default=0)
    ap.add_argument("--out")
    ap.add_argument("--config-dir", default=".stellar")
    ap.add_argument("--network", default="testnet")
    ap.add_argument("--rpc", default="https://soroban-testnet.stellar.org")
    a = ap.parse_args()
    getattr(R(a), a.cmd)()


if __name__ == "__main__":
    main()
