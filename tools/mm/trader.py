#!/usr/bin/env python3
"""Traffic generator against the PageBook XLM/USDC market maker (tools/mm/mm.py).

A separate identity crosses the maker's book: mostly immediate-or-cancel takes
(`place` with `no_rest`) of varied size, some deep enough to sweep several
levels; now and then a resting limit order inside the spread that it settles
a few minutes later. Every transaction goes through the padded-footprint
pipeline of tools/soak/soak.py with the §14 band pad from `quote_place`.

  python3 tools/mm/trader.py --contract C... --market 1 --identity pb-trader \
      --base-sac C... --quote-sac C... --usdc-issuer G...
"""
import argparse
import json
import os
import random
import signal
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "soak"))
import soak  # noqa: E402

TICK_MIN, TICK_MAX = 1, 4_194_304


class Trader:
    def __init__(self, a):
        self.a = a
        self.cli = soak.Cli(a.contract, a.config_dir, a.network, a.rpc)
        self.addr = self.cli.address(a.identity)
        self.log = open(a.log, "a")
        self.nonce = int(time.time()) * 1000
        self.resting = []  # (t_cancel, nonce, is_bid, tick)
        self.stop = False
        self.stats = {"takes": 0, "lots_taken": 0, "rests": 0, "settles": 0}
        signal.signal(signal.SIGTERM, self._sigterm)
        signal.signal(signal.SIGINT, self._sigterm)

    def _sigterm(self, *_):
        self.stop = True

    def record(self, action, outcome, **kw):
        d = {"t": time.time(), "action": action, "outcome": outcome}
        d.update(kw)
        self.log.write(json.dumps(d) + "\n")
        self.log.flush()

    def next_nonce(self):
        self.nonce += 1
        return self.nonce

    def token_keys(self):
        a = self.a
        keys = []
        for sac in (a.base_sac, a.quote_sac):
            keys.append({"contract_data": {"contract": sac, "key": "ledger_key_contract_instance", "durability": "persistent"}})
            keys.append({"contract_data": {"contract": sac, "key": {"vec": [{"symbol": "Balance"}, {"address": a.contract}]}, "durability": "persistent"}})
        keys.append({"account": {"account_id": self.addr}})
        keys.append({"trustline": {"account_id": self.addr, "asset": {"credit_alphanum4": {"asset_code": a.usdc_code, "issuer": a.usdc_issuer}}}})
        keys.append(soak.ck(a.contract, "FeeAccrual", a.market, a.base_sac))
        keys.append(soak.ck(a.contract, "FeeAccrual", a.market, a.quote_sac))
        return keys

    def submit(self, fn, args, pad, label=None, **extra):
        src = self.a.identity
        label = label or fn
        try:
            xdr = self.cli.build(src, fn, args)
            sim = self.cli.simulate(src, xdr)
        except soak.SimError as e:
            e = str(e)
            out = "sim:" + soak.classify(1, "", e)
            self.record(label, out, detail=e[:300] + " ... " + e[-160:] if len(e) > 460 else e, **extra)
            return out, None
        except Exception as e:
            self.record(label, "build_error", detail=str(e)[-300:], **extra)
            return "build_error", None
        obj = self.cli.decode(sim)
        soak.apply_pad(obj, pad)
        final = self.cli.encode(obj)
        try:
            signed = self.cli.sign(src, final)
        except Exception as e:
            self.record(label, "sign_error", detail=str(e)[-300:], **extra)
            return "sign_error", None
        rc, out, err = self.cli.send(signed)
        outcome = soak.classify(rc, out, err)
        text = out + err
        import re
        m = re.search(r"Transaction hash is ([0-9a-f]{64})", text)
        h = m.group(1) if m else ""
        if outcome in ("other", "trapped") and "Trapped" in text and h:
            outcome = self.cli.diagnose(h)
        # place returns (rested, filled_lots, quote_atoms): read it from the
        # transaction's returnValue (tx send does not print it)
        ret = None
        if outcome == "ok" and fn == "place" and h:
            ret = self.return_value(h)
        self.record(label, outcome, tx=h, ret=ret, detail=text[-160:] if outcome != "ok" else "", **extra)
        return outcome, ret

    def return_value(self, tx_hash):
        try:
            res = self.cli.rpc_call("getTransaction", {"hash": tx_hash})
            meta = res.get("resultMetaXdr")
            if not meta:
                return None
            rc, out, err = self.cli._run(["xdr", "decode", "--type", "TransactionMeta", "--output", "json"], stdin=meta)
            m = json.loads(out)
            v = next(iter(m.values()))["soroban_meta"]["return_value"]["vec"]
            return {"rested": v[0]["bool"], "filled_lots": int(v[1]["u64"]), "quote_atoms": int(v[2]["i128"])}
        except Exception:
            return None

    def best(self, is_bid):
        try:
            return self.cli.invoke_readonly(self.a.identity, "best", ["--market", str(self.a.market), "--is_bid", str(is_bid).lower()])
        except Exception:
            return None

    def place(self, is_bid, limit, lots, no_rest, label):
        a = self.a
        q = self.cli.invoke_readonly(a.identity, "quote_place", ["--market", str(a.market), "--is_bid", str(is_bid).lower(), "--limit_tick", str(limit), "--qty", str(lots)])
        nonce = self.next_nonce()
        window = soak.window_json(q, None)
        flags = json.dumps({"post_only": False, "fill_or_kill": False, "no_rest": no_rest})
        args = ["--taker", self.addr, "--market", str(a.market), "--is_bid", str(is_bid).lower(), "--limit_tick", str(limit), "--qty_lots", str(lots),
                "--start_tick", str(q["start_tick"]), "--nonce", str(nonce), "--window", window, "--flags", flags]
        pad = soak.pad_keys(a.contract, a.market, is_bid, limit, q, limit, self.addr, nonce, a.base_sac, a.quote_sac) + self.token_keys()
        out, ret = self.submit("place", args, pad, label=label, side="bid" if is_bid else "ask", limit=limit, lots=lots,
                               quoted_fill=q.get("filled_lots"), crossed=len(q.get("crossed", [])), band=abs(limit - q["start_tick"]) + 1)
        return out, ret, nonce

    def settle(self, nonce, is_bid, tick):
        a = self.a
        pad = self.token_keys()
        for pg in (0, 1):
            pad.append(soak.ck(a.contract, "LevelPage", a.market, is_bid, tick, pg))
        out, _ = self.submit("settle", ["--owner", self.addr, "--market", str(a.market), "--nonce", str(nonce)], pad, nonce=nonce)
        return out

    def step(self):
        a = self.a
        # cancel resting orders that are due
        now = time.time()
        due = [r for r in self.resting if r[0] <= now]
        self.resting = [r for r in self.resting if r[0] > now]
        for (_, n, b, t) in due:
            if self.settle(n, b, t) == "ok":
                self.stats["settles"] += 1

        is_bid = random.random() < 0.5
        bb, ba = self.best(True), self.best(False)
        if bb is None or ba is None:
            self.record("book", "one_sided", bid=bb, ask=ba)
            return
        touch = ba if is_bid else bb
        r = random.random()
        if r < a.rest_share and len(self.resting) < a.max_resting and ba - bb >= 3:
            # rest inside the spread (between the recorded bests), cancel later
            tick = random.randint(bb + 1, ba - 1)
            lots = random.randint(1, 5)
            out, ret, nonce = self.place(is_bid, tick, lots, False, "rest")
            if out == "ok" and ret and ret.get("rested"):
                self.stats["rests"] += 1
                self.resting.append((time.time() + random.uniform(a.rest_min_s, a.rest_max_s), nonce, is_bid, tick))
            return
        # an immediate take: size and depth
        u = random.random()
        if u < 0.6:
            lots, depth = random.randint(1, 12), 0          # inside the touch level
        elif u < 0.9:
            lots, depth = random.randint(20, 80), 12        # about two levels
        else:
            lots, depth = random.randint(100, 260), 40      # a deeper sweep, 4 to 6 levels
        limit = touch + depth if is_bid else max(TICK_MIN + 1, touch - depth)
        out, ret, _ = self.place(is_bid, limit, lots, True, "take")
        if out == "ok":
            self.stats["takes"] += 1
            if ret:
                self.stats["lots_taken"] += int(ret["filled_lots"])

    def run(self):
        a = self.a
        while not self.stop:
            t0 = time.time()
            try:
                self.step()
            except Exception as e:
                self.record("step", "error", detail=repr(e)[-300:])
            self.record("stats", "tick", **self.stats, resting=len(self.resting))
            time.sleep(max(0.0, random.uniform(a.min_wait, a.max_wait) - (time.time() - t0)))
        for (_, n, b, t) in self.resting:
            self.settle(n, b, t)
        self.record("shutdown", "done")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--contract", required=True)
    ap.add_argument("--market", type=int, required=True)
    ap.add_argument("--identity", default="pb-trader")
    ap.add_argument("--base-sac", required=True)
    ap.add_argument("--quote-sac", required=True)
    ap.add_argument("--usdc-issuer", required=True)
    ap.add_argument("--usdc-code", default="USDC")
    ap.add_argument("--config-dir", default=".stellar")
    ap.add_argument("--network", default="testnet")
    ap.add_argument("--rpc", default="https://soroban-testnet.stellar.org")
    ap.add_argument("--min-wait", type=float, default=20)
    ap.add_argument("--max-wait", type=float, default=75)
    ap.add_argument("--rest-share", type=float, default=0.15)
    ap.add_argument("--max-resting", type=int, default=3)
    ap.add_argument("--rest-min-s", type=float, default=120)
    ap.add_argument("--rest-max-s", type=float, default=360)
    ap.add_argument("--log", default="tools/mm/trader.log")
    a = ap.parse_args()
    Trader(a).run()


if __name__ == "__main__":
    main()
