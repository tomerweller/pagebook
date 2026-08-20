#!/usr/bin/env python3
"""Resource-limit stress for PageBook on testnet (market 0).

Each account holds 40 resting quotes dispersed across all 32 tick words of
market 0's band, and re-quotes all 40 in one `replace_batch` as fast as the
chain admits it. With the section 14 pad, one such batch declares close to
the 200 read-write-entry per-transaction cap and 40 to 60 KB of write bytes:
the largest legal writer the contract has. N accounts firing together
oversubscribe the per-ledger caps (1,000 write entries, 286,720 write bytes),
which is the point: watch which cap rations inclusion and how.

Phases:
  seed    rest the 40 quotes per account (idempotent: skips live nonces)
  run     fire batches for --ledgers, log every outcome with submit ledger
  analyze read the log, join with getTransaction ledgers, print per-ledger
          admitted totals and inclusion delay percentiles

  python3 tools/stress/stress.py seed|run|analyze --accounts 8 [--ledgers 250]
"""
import argparse
import collections
import concurrent.futures
import json
import os
import random
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "soak"))
import soak  # noqa: E402

CONTRACT = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO"
MARKET = 0
BASE_SAC = "CDAHSKHBGFENTV3XGWRWVIWE3ISAEYIZQNGD4GCWRDDIOIW4DVZ26FQG"
QUOTE_SAC = "CBEC6J5RWWWC7CYCHJTXIBDFTFRK6GTMLK4E47BECO5BDXVM7YHATUIK"
ISSUER = "GCBMNFRU74KLBUCVHJVQXRRMGEWUWC2WZ5KXLYABNFLXGCFTJPKBT4IB"
CODES = ["PBA", "PBB"]
NONCE_BASE = 777_000_000


def ticks_for(acct_i):
    """40 ask ticks for account i: one per word 0..31, plus 8 more in words
    0..7; offset per account so accounts do not share levels."""
    ts = [2048 * w + 200 + acct_i * 17 for w in range(32)]
    ts += [2048 * w + 1200 + acct_i * 17 for w in range(8)]
    return ts


class Stress:
    def __init__(self, a):
        self.a = a
        self.cli = soak.Cli(CONTRACT, a.config_dir, a.network, a.rpc)
        self.log = open(a.log, "a")
        self.lock = threading.Lock()
        self.counts = collections.Counter()

    def record(self, **kw):
        kw["t"] = time.time()
        with self.lock:
            self.counts[kw.get("outcome", "?")] += 1
            self.log.write(json.dumps(kw) + "\n")
            self.log.flush()

    def token_keys(self, addr):
        keys = []
        for sac, code in ((BASE_SAC, "PBA"), (QUOTE_SAC, "PBB")):
            keys.append({"contract_data": {"contract": sac, "key": "ledger_key_contract_instance", "durability": "persistent"}})
            keys.append({"contract_data": {"contract": sac, "key": {"vec": [{"symbol": "Balance"}, {"address": CONTRACT}]}, "durability": "persistent"}})
            keys.append({"trustline": {"account_id": addr, "asset": {"credit_alphanum4": {"asset_code": code, "issuer": ISSUER}}}})
        keys.append(soak.ck(CONTRACT, "FeeAccrual", MARKET, BASE_SAC))
        keys.append(soak.ck(CONTRACT, "FeeAccrual", MARKET, QUOTE_SAC))
        return keys

    def submit(self, source, fn, args, pad, **extra):
        addr = extra.pop("addr", None)
        t0 = time.time()
        try:
            l0 = self.cli.latest_ledger()
        except Exception:
            l0 = None
        try:
            xdr = self.cli.build(source, fn, args)
            sim = self.cli.simulate(source, xdr)
        except soak.SimError as e:
            e = str(e)
            self.record(acct=source, action=fn, outcome="sim:" + soak.classify(1, "", e), detail=e[-260:], **extra)
            return None
        except Exception as e:
            self.record(acct=source, action=fn, outcome="build_error", detail=str(e)[-260:], **extra)
            return None
        obj = self.cli.decode(sim)
        added = soak.apply_pad(obj, pad)
        sd = obj["tx"]["tx"]["ext"]["v1"]
        res = sd["resources"]
        decl = {"rw": len(res["footprint"]["read_write"]), "ro": len(res["footprint"]["read_only"]),
                "instr": int(res["instructions"]), "wb": int(res["write_bytes"]), "fee": int(sd["resource_fee"])}
        final = self.cli.encode(obj)
        try:
            signed = self.cli.sign(source, final)
        except Exception as e:
            self.record(acct=source, action=fn, outcome="sign_error", detail=str(e)[-260:], **extra)
            return None
        rc, out, err = self.cli.send(signed)
        outcome = soak.classify(rc, out, err)
        text = out + err
        import re
        m = re.search(r"Transaction hash is ([0-9a-f]{64})", text)
        h = m.group(1) if m else ""
        if outcome in ("other", "trapped") and "Trapped" in text and h:
            outcome = self.cli.diagnose(h)
        self.record(acct=source, action=fn, outcome=outcome, tx=h, submit_ledger=l0, wall_s=round(time.time() - t0, 2),
                    detail=text[-200:] if outcome != "ok" else "", **decl, **extra)
        return outcome

    # ---- phases
    def seed(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            list(ex.map(self._seed_one, range(self.a.accounts)))

    def _seed_one(self, i):
        if True:
            src = f"pb-stress{i+1}"
            addr = self.cli.address(src)
            for j, tick in enumerate(ticks_for(i)):
                nonce = NONCE_BASE + i * 1000 + j
                try:
                    self.cli.invoke_readonly(src, "order", ["--market", str(MARKET), "--owner", addr, "--nonce", str(nonce)])
                    continue  # already live
                except Exception:
                    pass
                window = json.dumps({"consume": [], "append": {"first": 0, "last": 1}})
                flags = json.dumps({"post_only": True, "fill_or_kill": False, "no_rest": False})
                args = ["--taker", addr, "--market", str(MARKET), "--is_bid", "false", "--limit_tick", str(tick),
                        "--qty_lots", "2", "--start_tick", str(65535), "--nonce", str(nonce), "--window", window, "--flags", flags]
                pad = soak.rest_keys(CONTRACT, MARKET, False, tick) + [soak.order_key(CONTRACT, MARKET, addr, nonce)] + self.token_keys(addr)
                self.submit(src, "place", args, pad, addr=addr, seed=1)
            print(f"{src} seeded", file=sys.stderr)

    def batch_once(self, i):
        src = f"pb-stress{i+1}"
        addr = self.cli.address(src)
        items = []
        pad = self.token_keys(addr)
        for j, tick in enumerate(ticks_for(i)):
            nonce = NONCE_BASE + i * 1000 + j
            items.append({"nonce": nonce, "is_bid": False, "tick": tick, "qty_lots": random.randint(2, 5),
                          "window": {"consume": [], "append": {"first": 0, "last": 1}}})
            # own-side keys per item; page 0 only (queues stay inline at 2-5 lots)
            pad.append(soak.ck(CONTRACT, "Level", MARKET, False, tick))
            pad.append(soak.ck(CONTRACT, "TickWord", MARKET, False, soak.word_of(tick)))
            pad.append(soak.ck(CONTRACT, "LevelPage", MARKET, False, tick, 0))
        pad.append(soak.ck(CONTRACT, "TickSummary", MARKET, False))
        pad.append(soak.ck(CONTRACT, "BestTick", MARKET, False))
        pad.append(soak.ck(CONTRACT, "BestTick", MARKET, True))
        # top up with a neighbor account's existing levels to sit just under the
        # 200 read-write cap (existing entries also cost declared write bytes)
        for tick in ticks_for((i + 1) % self.a.accounts)[:self.a.extra_pad]:
            pad.append(soak.ck(CONTRACT, "Level", MARKET, False, tick))
        return self.submit(src, "replace_batch", ["--owner", addr, "--market", str(MARKET), "--items", json.dumps(items)], pad, addr=addr)

    def run(self):
        start = self.cli.latest_ledger()
        end = start + self.a.ledgers
        stop = threading.Event()

        def worker(i):
            while not stop.is_set():
                self.batch_once(i)
                time.sleep(self.a.pause)

        threads = [threading.Thread(target=worker, args=(i,), daemon=True) for i in range(self.a.accounts)]
        for t in threads:
            t.start()
        last = start
        while True:
            time.sleep(10)
            try:
                cur = self.cli.latest_ledger()
            except Exception:
                continue
            if cur >= end:
                break
            if cur - last >= 30:
                last = cur
                self.record(acct="stress", action="progress", outcome="tick", detail=f"ledger {cur}/{end} counts={json.dumps(dict(self.counts))}")
        stop.set()
        time.sleep(20)
        self.record(acct="stress", action="done", outcome="summary", detail=json.dumps({"start": start, "end": end, "counts": dict(self.counts)}))
        print(json.dumps({"start": start, "end": end, "counts": dict(self.counts)}, indent=1))

    def analyze(self):
        recs = []
        for line in open(self.a.log):
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("action") == "replace_batch" and d.get("outcome") == "ok" and d.get("tx"):
                recs.append(d)
        print(f"{len(recs)} landed batches", file=sys.stderr)

        def ledger_of(r):
            try:
                g = self.cli.rpc_call("getTransaction", {"hash": r["tx"]})
                return g.get("ledger"), int(json.loads(self.cli._run(["xdr", "decode", "--type", "TransactionResult", "--output", "json"], stdin=g["resultXdr"])[1])["fee_charged"])
            except Exception:
                return None, None
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            got = list(ex.map(ledger_of, recs))
        per = collections.defaultdict(lambda: {"n": 0, "rw": 0, "wb": 0, "instr": 0, "fee": 0})
        delays = []
        for r, (led, fee) in zip(recs, got):
            if led is None:
                continue
            p = per[led]
            p["n"] += 1
            p["rw"] += r["rw"]
            p["wb"] += r["wb"]
            p["instr"] += r["instr"]
            p["fee"] += fee or 0
            if r.get("submit_ledger"):
                delays.append(led - r["submit_ledger"])
        out = {"ledgers_with_batches": len(per),
               "per_ledger": {"n": self._q([p["n"] for p in per.values()]),
                              "rw_declared": self._q([p["rw"] for p in per.values()]),
                              "write_bytes_declared": self._q([p["wb"] for p in per.values()]),
                              "instr_declared": self._q([p["instr"] for p in per.values()])},
               "inclusion_delay_ledgers": self._q(delays),
               "wall_s": self._q([r["wall_s"] for r in recs]),
               "fee_charged": self._q([f for (_, f) in got if f])}
        print(json.dumps(out, indent=1))
        top = sorted(per.items(), key=lambda kv: -kv[1]["wb"])[:10]
        print("busiest ledgers (by our declared write bytes):")
        for led, p in top:
            print(f"  {led}: {p['n']} batches, rw {p['rw']} ({p['rw']/10:.0f}% of cap), wb {p['wb']:,} ({p['wb']/2867.2:.0f}% of cap), instr {p['instr']/1e6:.0f}M ({p['instr']/5.8e6:.0f}% of cap)")

    @staticmethod
    def _q(v):
        if not v:
            return None
        v = sorted(v)
        def q(p):
            i = (len(v) - 1) * p
            lo = int(i)
            return v[lo] if lo == len(v) - 1 else v[lo] + (v[lo + 1] - v[lo]) * (i - lo)
        return {"min": v[0], "p50": round(q(.5), 2), "p95": round(q(.95), 2), "max": v[-1]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["seed", "run", "analyze"])
    ap.add_argument("--accounts", type=int, default=8)
    ap.add_argument("--ledgers", type=int, default=250)
    ap.add_argument("--pause", type=float, default=1.0)
    ap.add_argument("--extra-pad", type=int, default=28)
    ap.add_argument("--config-dir", default=".stellar")
    ap.add_argument("--network", default="testnet")
    ap.add_argument("--rpc", default="https://soroban-testnet.stellar.org")
    ap.add_argument("--log", default="tools/stress/stress.log")
    a = ap.parse_args()
    s = Stress(a)
    getattr(s, a.phase)()


if __name__ == "__main__":
    main()
