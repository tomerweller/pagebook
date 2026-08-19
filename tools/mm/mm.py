#!/usr/bin/env python3
"""PageBook testnet market maker: XLM/USDC quoted off a real price feed.

Keeps a ladder of post-only quotes on both sides of a PageBook market (lot 10
XLM, tick 0.00001 USDC per XLM), centred on the spot XLM-USD price from
Coinbase (Kraken fallback), re-quoting slots whose target moved and
re-resting slots that filled (`replace` settles the old quote and rests the
new one atomically). Every transaction goes through the padded-footprint
pipeline of tools/soak/soak.py: build -> simulate -> pad -> sign -> send.

  python3 tools/mm/mm.py --contract C... --market 1 --identity pb-mm \
      --base-sac C... --quote-sac C... --usdc-issuer G... [--levels 20]

State (live quotes, nonces) lives in tools/mm/state.json so a restart picks
its own quotes back up; `--cancel-all` settles every live quote and exits.
The JSON-lines log (tools/mm/mm.log) carries one `loop` line per cycle
(mid, ladder edges, book bests, live quotes, fills, balances) plus one line
per transaction outcome; tools/mm/check.py audits it.
"""
import argparse
import json
import math
import os
import signal
import sys
import time
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "soak"))
import soak  # noqa: E402  (Cli, ck, order_key, rest_keys, apply_pad, classify)

LOT_XLM = 10                # lot_size 1e8 stroops
TICK_USD_PER_XLM = 0.00001  # tick_size 1000 quote atoms per lot of 10 XLM
TICK_MIN, TICK_MAX = 1, 4_194_304
NATIVE_ACCOUNT_KEY = "account"


def crosses(taker_is_bid, opp_tick, limit_tick):
    return opp_tick <= limit_tick if taker_is_bid else opp_tick >= limit_tick


def tick_of(price):
    return int(round(price / TICK_USD_PER_XLM))


def price_of(tick):
    return tick * TICK_USD_PER_XLM


class Feed:
    """Spot XLM-USD. Remembers the last good print and its age."""

    def __init__(self):
        self.last = None
        self.at = 0.0
        self.source = None

    def _get(self, url):
        req = urllib.request.Request(url, headers={"User-Agent": "pagebook-mm/0.1"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)

    def fetch(self):
        try:
            j = self._get("https://api.coinbase.com/v2/prices/XLM-USD/spot")
            p = float(j["data"]["amount"])
            self.last, self.at, self.source = p, time.time(), "coinbase"
            return p
        except Exception:
            pass
        try:
            j = self._get("https://api.kraken.com/0/public/Ticker?pair=XLMUSD")
            r = next(iter(j["result"].values()))
            p = (float(r["a"][0]) + float(r["b"][0])) / 2
            self.last, self.at, self.source = p, time.time(), "kraken"
            return p
        except Exception:
            return None

    def age(self):
        return time.time() - self.at if self.at else float("inf")


class MM:
    def __init__(self, a):
        self.a = a
        self.cli = soak.Cli(a.contract, a.config_dir, a.network, a.rpc)
        self.addr = self.cli.address(a.identity)
        self.feed = Feed()
        self.state_path = a.state
        self.log = open(a.log, "a")
        self.state = {"quotes": {}, "next_nonce": int(time.time()) * 1000, "fills": 0, "volume_lots": 0}
        if os.path.exists(self.state_path):
            with open(self.state_path) as f:
                self.state.update(json.load(f))
        self.stop = False
        signal.signal(signal.SIGTERM, self._sigterm)
        signal.signal(signal.SIGINT, self._sigterm)
        self.bad_ticks = {}  # (side, tick) -> until ts: LevelFull there, avoid
        self.healed = {}  # (side, tick) -> until ts: phantom heal attempted

    # ---- plumbing
    def _sigterm(self, *_):
        self.stop = True

    def save(self):
        tmp = self.state_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.state, f)
        os.replace(tmp, self.state_path)

    def record(self, action, outcome, **kw):
        d = {"t": time.time(), "action": action, "outcome": outcome}
        d.update(kw)
        self.log.write(json.dumps(d) + "\n")
        self.log.flush()

    def next_nonce(self):
        n = self.state["next_nonce"]
        self.state["next_nonce"] = n + 1
        return n

    def token_keys(self):
        """Both tokens: SAC instance, vault balance, and the maker's own
        balance entry (the account itself for native XLM, the trustline for
        USDC). Simulation lists only the token it moved."""
        a = self.a
        keys = []
        for sac in (a.base_sac, a.quote_sac):
            keys.append({"contract_data": {"contract": sac, "key": "ledger_key_contract_instance", "durability": "persistent"}})
            keys.append({"contract_data": {"contract": sac, "key": {"vec": [{"symbol": "Balance"}, {"address": a.contract}]}, "durability": "persistent"}})
        keys.append({NATIVE_ACCOUNT_KEY: {"account_id": self.addr}})
        keys.append({"trustline": {"account_id": self.addr, "asset": {"credit_alphanum4": {"asset_code": a.usdc_code, "issuer": a.usdc_issuer}}}})
        keys.append(soak.ck(a.contract, "FeeAccrual", a.market, a.base_sac))
        keys.append(soak.ck(a.contract, "FeeAccrual", a.market, a.quote_sac))
        return keys

    def submit(self, fn, args, pad, label=None, **extra):
        """build -> simulate -> pad -> sign -> send; returns the outcome string."""
        src = self.a.identity
        label = label or fn
        try:
            xdr = self.cli.build(src, fn, args)
            sim = self.cli.simulate(src, xdr)
        except soak.SimError as e:
            e = str(e)
            out = "sim:" + soak.classify(1, "", e)
            self.record(label, out, detail=e[:300] + " ... " + e[-160:] if len(e) > 460 else e, **extra)
            return out
        except Exception as e:
            self.record(label, "build_error", detail=str(e)[-300:])
            return "build_error"
        obj = self.cli.decode(sim)
        soak.apply_pad(obj, pad)
        final = self.cli.encode(obj)
        try:
            signed = self.cli.sign(src, final)
        except Exception as e:
            self.record(label, "sign_error", detail=str(e)[-300:])
            return "sign_error"
        rc, out, err = self.cli.send(signed)
        outcome = soak.classify(rc, out, err)
        text = out + err
        import re
        m = re.search(r"Transaction hash is ([0-9a-f]{64})", text)
        h = m.group(1) if m else ""
        if outcome in ("other", "trapped") and "Trapped" in text and h:
            outcome = self.cli.diagnose(h)
        self.record(label, outcome, tx=h, detail=text[-160:] if outcome != "ok" else "", **extra)
        return outcome

    # ---- views
    def best(self, is_bid):
        try:
            return self.cli.invoke_readonly(self.a.identity, "best", ["--market", str(self.a.market), "--is_bid", str(is_bid).lower()])
        except Exception:
            return None

    def order_info(self, nonce):
        """OrderInfo or None if the order no longer exists (settled/unknown)."""
        try:
            return self.cli.invoke_readonly(self.a.identity, "order", ["--market", str(self.a.market), "--owner", self.addr, "--nonce", str(nonce)])
        except RuntimeError as e:
            if "Contract, #" in str(e):
                return None
            raise

    def balances(self):
        try:
            req = urllib.request.Request(f"{self.a.horizon}/accounts/{self.addr}", headers={"User-Agent": "pagebook-mm/0.1"})
            with urllib.request.urlopen(req, timeout=15) as r:
                acc = json.load(r)
            out = {}
            for b in acc["balances"]:
                code = b.get("asset_code", "XLM")
                out[code] = float(b["balance"])
            return out
        except Exception:
            return {}

    # ---- ladder
    def ladder(self, mid_tick, skew_bps):
        """Desired (tick, lots) per slot per side. Slot i sits hs + i*sp bps
        from the (skewed) mid; sizes grow with depth."""
        a = self.a
        centre = mid_tick * (1 + skew_bps / 1e4)
        bids, asks = [], []
        for i in range(a.levels):
            off = centre * (a.half_spread_bps + i * a.spacing_bps) / 1e4
            bids.append((int(math.floor(centre - off)), a.base_lots + a.step_lots * i))
            asks.append((int(math.ceil(centre + off)), a.base_lots + a.step_lots * i))
        return bids, asks

    # ---- actions
    def place(self, is_bid, tick, lots, slot):
        a = self.a
        nonce = self.next_nonce()
        start = TICK_MAX - 1 if is_bid else TICK_MIN  # worst tick: a post-only never walks
        window = json.dumps({"consume": [], "append": {"first": 0, "last": 1}})
        flags = json.dumps({"post_only": True, "fill_or_kill": False, "no_rest": False})
        args = ["--taker", self.addr, "--market", str(a.market), "--is_bid", str(is_bid).lower(), "--limit_tick", str(tick),
                "--qty_lots", str(lots), "--start_tick", str(start), "--nonce", str(nonce), "--window", window, "--flags", flags]
        pad = soak.rest_keys(a.contract, a.market, is_bid, tick) + [soak.order_key(a.contract, a.market, self.addr, nonce)] + self.token_keys()
        out = self.submit("place", args, pad)
        if out == "ok":
            self.state["quotes"][str(nonce)] = {"side": "bid" if is_bid else "ask", "tick": tick, "lots": lots, "slot": slot, "t": time.time()}
            self.save()
        elif out == "sim:typed:LevelFull":
            self.bad_ticks[(is_bid, tick)] = time.time() + 600
        elif out == "sim:typed:Crossed":
            self.heal_to(is_bid, tick)
        return out

    def replace_items(self, items):
        """items: list of (nonce, is_bid, tick, lots, slot). One replace_batch
        (atomic) for several, a plain replace for one; on a batch failure fall
        back to singles so one bad slot does not block the rest."""
        a = self.a
        if not items:
            return
        if len(items) == 1:
            n, is_bid, tick, lots, slot = items[0]
            pad = soak.rest_keys(a.contract, a.market, is_bid, tick) + self.token_keys()
            window = json.dumps({"consume": [], "append": {"first": 0, "last": 1}})
            out = self.submit("replace", ["--owner", self.addr, "--market", str(a.market), "--nonce", str(n), "--is_bid", str(is_bid).lower(),
                                          "--tick", str(tick), "--qty_lots", str(lots), "--window", window], pad)
            if out == "ok":
                self.state["quotes"][str(n)] = {"side": "bid" if is_bid else "ask", "tick": tick, "lots": lots, "slot": slot, "t": time.time()}
                self.save()
            elif out == "sim:typed:LevelFull":
                self.bad_ticks[(is_bid, tick)] = time.time() + 600
            elif out == "sim:typed:Crossed":
                self.heal_to(is_bid, tick)
            elif out in ("sim:typed:UnknownOrder", "typed:UnknownOrder"):
                self.state["quotes"].pop(str(n), None)
                self.save()
            return out
        body = [{"nonce": n, "is_bid": b, "tick": t, "qty_lots": l, "window": {"consume": [], "append": {"first": 0, "last": 1}}} for (n, b, t, l, _) in items]
        pad = self.token_keys()
        for (_, b, t, _, _) in items:
            pad += soak.rest_keys(a.contract, a.market, b, t)
        out = self.submit("replace_batch", ["--owner", self.addr, "--market", str(a.market), "--items", json.dumps(body)], pad)
        if out == "ok":
            for (n, b, t, l, s) in items:
                self.state["quotes"][str(n)] = {"side": "bid" if b else "ask", "tick": t, "lots": l, "slot": s, "t": time.time()}
            self.save()
            return out
        # fall back to singles
        for it in items:
            self.replace_items([it])
        return out

    def heal_to(self, is_bid, target):
        """Our post-only on side `is_bid` at `target` would fail Crossed against
        the recorded opposite best. If that best is a phantom (an empty level
        whose bit is still set, §9: typically a level our own re-quotes vacated),
        send a 1-lot no-rest take with limit `target`: one walk clears every
        phantom level up to the target (at most MAX_LEVELS_CROSSED of them) and
        advances BestTick past them. A real resting order at the best means a
        real cross: leave it alone."""
        a = self.a
        b = self.best(not is_bid)
        if b is None or not crosses(is_bid, b, target):
            return "clear"
        try:
            lv = self.cli.invoke_readonly(a.identity, "level", ["--market", str(a.market), "--is_bid", str(not is_bid).lower(), "--tick", str(b)])
        except Exception:
            return "view_error"
        if lv.get("open_lots", 0) > 0:
            return "real_cross"
        key = (is_bid, b)
        if self.healed.get(key, 0) > time.time():
            return "recent"
        self.healed[key] = time.time() + 60
        # one walk clears at most MAX_LEVELS_CROSSED phantoms, and the band
        # pad is one Level key per tick: chunk a long trail (the next cycle
        # continues from the new recorded best)
        if crosses(is_bid, b, target) and abs(target - b) > a.heal_band:
            target = b + a.heal_band if is_bid else b - a.heal_band
        q = self.cli.invoke_readonly(a.identity, "quote_place", ["--market", str(a.market), "--is_bid", str(is_bid).lower(), "--limit_tick", str(target), "--qty", "1"])
        crossed = q.get("crossed", [])
        if len(crossed) >= 32:
            target = crossed[-1]["tick"]
        nonce = self.next_nonce()
        window = soak.window_json(q, None)
        flags = json.dumps({"post_only": False, "fill_or_kill": False, "no_rest": True})
        args = ["--taker", self.addr, "--market", str(a.market), "--is_bid", str(is_bid).lower(), "--limit_tick", str(target), "--qty_lots", "1",
                "--start_tick", str(q["start_tick"]), "--nonce", str(nonce), "--window", window, "--flags", flags]
        pad = soak.pad_keys(a.contract, a.market, is_bid, target, q, target, self.addr, nonce, a.base_sac, a.quote_sac, pages_for_empty=False) + self.token_keys()
        return self.submit("place", args, pad, label="heal", side="bid" if is_bid else "ask", phantom_tick=b, target=target,
                           phantoms=len(q.get("crossed", [])))

    def settle(self, nonce, is_bid, tick):
        a = self.a
        pad = self.token_keys()
        for pg in (0, 1):
            pad.append(soak.ck(a.contract, "LevelPage", a.market, is_bid, tick, pg))
        out = self.submit("settle", ["--owner", self.addr, "--market", str(a.market), "--nonce", str(nonce)], pad)
        if out == "ok" or "UnknownOrder" in out:
            self.state["quotes"].pop(str(nonce), None)
            self.save()
        return out

    def cancel_all(self):
        for n, q in list(self.state["quotes"].items()):
            self.settle(int(n), q["side"] == "bid", q["tick"])

    # ---- the loop
    def run(self):
        a = self.a
        loop = 0
        while not self.stop:
            t0 = time.time()
            try:
                self.cycle(loop)
            except Exception as e:  # never die on a transient
                self.record("cycle", "error", detail=repr(e)[-300:])
            loop += 1
            dt = time.time() - t0
            time.sleep(max(0.0, a.interval - dt))
        if a.cancel_on_exit:
            self.record("shutdown", "cancelling", n=len(self.state["quotes"]))
            self.cancel_all()
        self.record("shutdown", "done")

    def cycle(self, loop):
        a = self.a
        mid = self.feed.fetch()
        stale = self.feed.age() > a.max_feed_age
        if stale:
            # No trustworthy price: pull the book rather than quote blind.
            if self.state["quotes"]:
                self.record("feed", "stale", age=round(self.feed.age()), action="cancel_all")
                self.cancel_all()
            else:
                self.record("feed", "stale", age=round(self.feed.age()))
            return
        mid_tick = tick_of(self.feed.last)
        bal = self.balances()
        # inventory skew: lean quotes against what we have accumulated since
        # start (the account's resting holdings are deliberately lopsided), in
        # units of one side's ladder notional
        if "inv0" not in self.state and bal:
            self.state["inv0"] = {"xlm": bal.get("XLM", 0), "usdc": bal.get(a.usdc_code, 0)}
        skew = 0.0
        inv0 = self.state.get("inv0")
        if inv0 and bal and a.skew_bps > 0:
            side_lots = sum(a.base_lots + a.step_lots * i for i in range(a.levels))
            notional = max(1.0, side_lots * LOT_XLM * self.feed.last)
            d_xlm_v = (bal.get("XLM", 0) - inv0["xlm"]) * self.feed.last
            d_usd = bal.get(a.usdc_code, 0) - inv0["usdc"]
            imb = (d_xlm_v - d_usd) / (2 * notional)  # >0: accumulated XLM -> quote lower
            skew = -a.skew_bps * max(-1.0, min(1.0, imb))
        bids, asks = self.ladder(mid_tick, skew)

        # fills: check the touch slots every cycle, the whole ladder every Nth
        quotes = self.state["quotes"]
        by_slot = {}
        for n, q in quotes.items():
            by_slot[(q["side"], q["slot"])] = (int(n), q)
        full_scan = loop % a.full_scan_every == 0
        filled = []
        for (side, slot), (n, q) in list(by_slot.items()):
            if not (full_scan or slot < a.touch_slots):
                continue
            info = self.order_info(n)
            if info is None:
                quotes.pop(str(n), None)
                by_slot.pop((side, slot), None)
                continue
            if info.get("filled_lots", 0) > 0:
                filled.append(((side, slot), n, info))
                q["filled_lots"] = info["filled_lots"]
        if filled:
            self.state["fills"] += len(filled)
            self.state["volume_lots"] += sum(i["filled_lots"] for (_, _, i) in filled)
        self.save()

        # decide per slot
        to_replace, to_place = [], []
        now = time.time()
        for side_name, is_bid, ladder in (("bid", True, bids), ("ask", False, asks)):
            for slot, (tick, lots) in enumerate(ladder):
                if tick < TICK_MIN + 1 or tick >= TICK_MAX - 1:
                    continue
                while self.bad_ticks.get((is_bid, tick), 0) > now:
                    tick += -1 if is_bid else 1  # step away from a full level
                cur = by_slot.get((side_name, slot))
                if cur is None:
                    to_place.append((is_bid, tick, lots, slot))
                    continue
                n, q = cur
                moved = abs(q["tick"] - tick)
                thresh = a.requote_ticks if slot < a.touch_slots else a.requote_ticks * 2
                was_filled = any(f[1] == n for f in filled)
                if was_filled or moved >= thresh or q["lots"] != lots:
                    to_replace.append((n, is_bid, tick, lots, slot))

        # proactive heal: if a side's target touch crosses the recorded opposite
        # best (a phantom trail left by our own re-quotes in a trend), clear it
        # with one walk before the re-quotes, instead of failing them one by one
        book_bb, book_ba = self.best(True), self.best(False)
        if book_ba is not None and bids and book_ba <= bids[0][0]:
            self.heal_to(True, bids[0][0])
        if book_bb is not None and asks and book_bb >= asks[0][0]:
            self.heal_to(False, asks[0][0])

        # act: replaces in batches, places one by one (bounded per cycle)
        for i in range(0, len(to_replace), a.batch):
            self.replace_items(to_replace[i:i + a.batch])
        for (is_bid, tick, lots, slot) in to_place[: a.max_places_per_cycle]:
            self.place(is_bid, tick, lots, slot)

        quotes = self.state["quotes"]
        bb = max([q["tick"] for q in quotes.values() if q["side"] == "bid"], default=None)
        ba = min([q["tick"] for q in quotes.values() if q["side"] == "ask"], default=None)
        book_bb, book_ba = self.best(True), self.best(False)
        self.record(
            "loop", "ok", loop=loop, mid=self.feed.last, src=self.feed.source, mid_tick=mid_tick, skew_bps=round(skew, 2),
            our_bid=bb, our_ask=ba, book_bid=book_bb, book_ask=book_ba, live=len(quotes),
            n_bids=sum(1 for q in quotes.values() if q["side"] == "bid"), n_asks=sum(1 for q in quotes.values() if q["side"] == "ask"),
            replaced=len(to_replace), placed=min(len(to_place), a.max_places_per_cycle), fills_total=self.state["fills"],
            volume_lots=self.state["volume_lots"], xlm=bal.get("XLM"), usdc=bal.get(a.usdc_code),
        )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--contract", required=True)
    ap.add_argument("--market", type=int, required=True)
    ap.add_argument("--identity", default="pb-mm")
    ap.add_argument("--base-sac", required=True, help="native XLM SAC")
    ap.add_argument("--quote-sac", required=True, help="USDC SAC")
    ap.add_argument("--usdc-issuer", required=True)
    ap.add_argument("--usdc-code", default="USDC")
    ap.add_argument("--config-dir", default=".stellar")
    ap.add_argument("--network", default="testnet")
    ap.add_argument("--rpc", default="https://soroban-testnet.stellar.org")
    ap.add_argument("--horizon", default="https://horizon-testnet.stellar.org")
    ap.add_argument("--levels", type=int, default=20)
    ap.add_argument("--half-spread-bps", type=float, default=4.0)
    ap.add_argument("--spacing-bps", type=float, default=5.0)
    ap.add_argument("--base-lots", type=int, default=25, help="lots (of 10 XLM) at the touch")
    ap.add_argument("--step-lots", type=int, default=12, help="extra lots per level of depth")
    ap.add_argument("--skew-bps", type=float, default=3.0, help="max mid shift against inventory imbalance")
    ap.add_argument("--requote-ticks", type=int, default=4, help="re-quote a touch slot when its target moved this much")
    ap.add_argument("--touch-slots", type=int, default=3)
    ap.add_argument("--full-scan-every", type=int, default=8)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--max-places-per-cycle", type=int, default=6)
    ap.add_argument("--interval", type=float, default=30.0)
    ap.add_argument("--max-feed-age", type=float, default=240.0)
    ap.add_argument("--heal-band", type=int, default=150, help="max ticks one heal walk spans (band pad keys)")
    ap.add_argument("--state", default="tools/mm/state.json")
    ap.add_argument("--log", default="tools/mm/mm.log")
    ap.add_argument("--cancel-all", action="store_true")
    ap.add_argument("--cancel-on-exit", action="store_true")
    a = ap.parse_args()
    mm = MM(a)
    if a.cancel_all:
        mm.cancel_all()
        return
    mm.run()


if __name__ == "__main__":
    main()
