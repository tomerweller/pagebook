#!/usr/bin/env python3
"""PageBook testnet soak (05 M4 / ADR-019, ADR-025).

Drives four accounts against a deployed PageBook market through the stellar CLI:

  taker   places bids/asks that cross the book (padded footprints, §14)
  maker   keeps a two-sided book, re-quotes with replace / replace_batch,
          settles the replaced quotes later
  spam    quote-improving spammer: post-only rests inside the spread, then
          replaces away (arms stale bits and phantom bests)
  storm   same-level rest storms at the current best (append-window races),
          stepping out a tick on LevelFull and settling each burst 45 s later

Every transaction goes build (`contract invoke --build-only`) -> `tx simulate`
-> footprint union with the client pad (band Levels, words, summaries, bests,
own-side keys, Order, page windows, fee accruals) -> `xdr encode` -> `tx sign`
-> `tx send`, and the outcome is classified: OK, a typed PageBook error
(RetryRest, Crossed, ...), a footprint failure (a key outside the declared
set: the only failure the design allows and only when the walk passes
pad_end), or other. Runs for --ledgers ledgers and writes a JSON-lines log
plus a summary.

Usage:
  python3 tools/soak/soak.py --contract C... --market 0 --config-dir .stellar \
      --ledgers 2000 --log tools/soak/soak.log
"""
import argparse
import json
import random
import re
import subprocess
import threading
import time
import urllib.request

INLINE_SLOTS = 32
PAGE_SLOTS = 32
WORD_TICKS = 2048
CONSUME_WIDTH = 1


def page(seq):
    return 0 if seq < INLINE_SLOTS else (seq - INLINE_SLOTS) // PAGE_SLOTS


def word_of(tick):
    return tick // WORD_TICKS


class Cli:
    def __init__(self, contract, config_dir, network, rpc):
        self.contract = contract
        self.config_dir = config_dir
        self.network = network
        self.rpc = rpc

    def _run(self, args, stdin=None):
        r = subprocess.run(
            ["stellar", *args], input=stdin, capture_output=True, text=True
        )
        return r.returncode, r.stdout, r.stderr

    def address(self, key):
        rc, out, _ = self._run(["keys", "address", key, "--config-dir", self.config_dir])
        return out.strip().splitlines()[-1]

    def invoke_readonly(self, source, fn, args):
        rc, out, err = self._run(
            [
                "contract", "invoke", "--id", self.contract, "--source", source,
                "--config-dir", self.config_dir, "--network", self.network, "--", fn, *args,
            ]
        )
        if rc != 0:
            raise RuntimeError(f"{fn}: {err[-400:]}")
        return json.loads(out.strip().splitlines()[-1])

    def build(self, source, fn, args):
        rc, out, err = self._run(
            [
                "contract", "invoke", "--id", self.contract, "--source", source,
                "--config-dir", self.config_dir, "--network", self.network,
                "--build-only", "--", fn, *args,
            ]
        )
        if rc != 0:
            raise RuntimeError(f"build {fn}: {err[-400:]}")
        return out.strip().splitlines()[-1]

    def simulate(self, source, xdr):
        rc, out, err = self._run(
            [
                "tx", "simulate", "--source-account", source, "--config-dir",
                self.config_dir, "--network", self.network, xdr,
            ]
        )
        if rc != 0:
            raise SimError(err)
        return out.strip().splitlines()[-1]

    def decode(self, xdr):
        rc, out, err = self._run(
            ["xdr", "decode", "--type", "TransactionEnvelope", "--output", "json"], stdin=xdr
        )
        return json.loads(out)

    def encode(self, obj):
        rc, out, err = self._run(
            ["xdr", "encode", "--type", "TransactionEnvelope"], stdin=json.dumps(obj)
        )
        if rc != 0:
            raise RuntimeError(f"encode: {err[-300:]}")
        return out.strip()

    def sign(self, source, xdr):
        rc, out, err = self._run(
            [
                "tx", "sign", "--sign-with-key", source, "--config-dir", self.config_dir,
                "--network", self.network,
            ],
            stdin=xdr,
        )
        if rc != 0:
            raise RuntimeError(f"sign: {err[-300:]}")
        return out.strip().splitlines()[-1]

    def send(self, xdr):
        rc, out, err = self._run(
            ["tx", "send", "--config-dir", self.config_dir, "--network", self.network], stdin=xdr
        )
        return rc, out, err

    def rpc_call(self, method, params):
        req = urllib.request.Request(
            self.rpc,
            data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
            headers={"Content-Type": "application/json", "User-Agent": "pagebook-soak/0.1"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r).get("result", {})

    def diagnose(self, tx_hash):
        """Classify a Trapped transaction from its diagnostic events: a typed
        PageBook error, or a footprint violation, or unknown."""
        for _ in range(6):
            res = self.rpc_call("getTransaction", {"hash": tx_hash})
            if res.get("status") in ("SUCCESS", "FAILED"):
                break
            time.sleep(3)
        evs = res.get("diagnosticEventsXdr") or []
        text = ""
        for e in evs:
            rc, out, err = self._run(["xdr", "decode", "--type", "DiagnosticEvent", "--output", "json"], stdin=e)
            text += out
        m = re.search(r'"contract_error"[^0-9]*(\d+)|Error\(Contract, #(\d+)\)|"error":\s*\{"contract":\s*(\d+)\}', text)
        if m:
            code = int(m.group(1) or m.group(2) or m.group(3))
            return "typed:" + ERR_NAMES.get(code, str(code))
        if re.search(r"footprint|storage.*exceeded_limit|\"storage\"", text, re.I):
            return "footprint"
        return "trapped:unknown"

    def latest_ledger(self):
        req = urllib.request.Request(
            self.rpc,
            data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "getLatestLedger"}).encode(),
            headers={"Content-Type": "application/json", "User-Agent": "pagebook-soak/0.1"},
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)["result"]["sequence"]


class SimError(Exception):
    pass


def ck(contract, variant, *fields):
    """A PageBook DataKey as a ledger-key JSON object."""
    vec = [{"symbol": variant}]
    for f in fields:
        if isinstance(f, bool):
            vec.append({"bool": f})
        elif isinstance(f, int) and f > 0xFFFFFFFF:
            vec.append({"u64": str(f)})
        elif isinstance(f, int):
            vec.append({"u32": f})
        elif isinstance(f, str) and f.startswith(("G", "C")) and len(f) == 56:
            vec.append({"address": f})
        else:
            raise ValueError(f)
    return {"contract_data": {"contract": contract, "key": {"vec": vec}, "durability": "persistent"}}


def order_key(contract, market, owner, nonce):
    return {
        "contract_data": {
            "contract": contract,
            "key": {"vec": [{"symbol": "Order"}, {"u32": market}, {"address": owner}, {"u64": str(nonce)}]},
            "durability": "persistent",
        }
    }


def pad_keys(contract, market, is_bid, limit, q, pad_end, owner, nonce, base, quote, pages_for_empty=True):
    """The client pad of architecture §14 for a place, mirroring
    crates/pagebook-client pad(); returned as ledger-key JSON objects.
    `pages_for_empty=False` skips the consume-window pages of crossed levels
    that simulation saw empty (stale bits): their queues are inline even if a
    rest lands there in flight (§14), and a heal walk over a long phantom trail
    would otherwise blow the 200 read-write-entry cap."""
    opp = not is_bid
    keys = []
    start = q["start_tick"]
    lo, hi = min(start, pad_end), max(start, pad_end)
    for t in range(lo, hi + 1):
        keys.append(ck(contract, "Level", market, opp, t))
    words = {word_of(start), word_of(limit), word_of(pad_end)}
    for w in range(min(words), max(words) + 1):
        keys.append(ck(contract, "TickWord", market, opp, w))
    keys.append(ck(contract, "TickSummary", market, opp))
    keys.append(ck(contract, "BestTick", market, opp))
    for c in q["crossed"]:
        if not pages_for_empty and c.get("open_lots", 0) == 0:
            continue
        p = page(c["head_seq"])
        for pg in {0, p, p + CONSUME_WIDTH}:
            keys.append(ck(contract, "LevelPage", market, opp, c["tick"], pg))
    keys.append(ck(contract, "Level", market, is_bid, limit))
    keys.append(ck(contract, "TickWord", market, is_bid, word_of(limit)))
    keys.append(ck(contract, "TickSummary", market, is_bid))
    keys.append(ck(contract, "BestTick", market, is_bid))
    keys.append(order_key(contract, market, owner, nonce))
    p = page(q["tail_seq"])
    for pg in {0, p, p + 1}:
        keys.append(ck(contract, "LevelPage", market, is_bid, limit, pg))
    keys.append(ck(contract, "FeeAccrual", market, base))
    keys.append(ck(contract, "FeeAccrual", market, quote))
    return keys


def rest_keys(contract, market, is_bid, tick):
    """The rest half of pagebook-client keys_for_replace (§14 own-side keys): the
    level, its word, summary and best, the opposite best, and the append pages.
    Simulation misses the word when the level had open lots (rest.rs sets the
    bit only on an empty level) and the level then empties in flight."""
    keys = [
        ck(contract, "Level", market, is_bid, tick),
        ck(contract, "TickWord", market, is_bid, word_of(tick)),
        ck(contract, "TickSummary", market, is_bid),
        ck(contract, "BestTick", market, is_bid),
        ck(contract, "BestTick", market, not is_bid),
    ]
    for pg in (0, 1):
        keys.append(ck(contract, "LevelPage", market, is_bid, tick, pg))
    return keys


def token_keys(pagebook, sacs, caller, issuer, codes):
    """Both tokens' entries a place may touch whatever the book does in flight:
    the SAC instance, the vault's SAC balance, the caller's classic trustline.
    Simulation lists only the tokens it happened to move."""
    keys = []
    for sac, code in zip(sacs, codes):
        keys.append({"contract_data": {"contract": sac, "key": "ledger_key_contract_instance", "durability": "persistent"}})
        keys.append({"contract_data": {"contract": sac, "key": {"vec": [{"symbol": "Balance"}, {"address": pagebook}]}, "durability": "persistent"}})
        keys.append({"trustline": {"account_id": caller, "asset": {"credit_alphanum4": {"asset_code": code, "issuer": issuer}}}})
    return keys


def window_json(q, consume_ticks):
    consume = []
    for c in q["crossed"]:
        p = page(c["head_seq"])
        consume.append({"tick": c["tick"], "pages": {"first": p, "last": p + CONSUME_WIDTH}})
    p = page(q["tail_seq"])
    return json.dumps({"consume": consume, "append": {"first": p, "last": p + 1}})


def apply_pad(sim_json, extra_keys, sizes=None):
    """Union the client pad into the simulated footprint and raise the
    declared resources to cover it.

    `sizes` (optional; default None keeps the flat per-key behavior) makes the
    write-byte coverage existence-aware. It is a dict with:
      exists  callable(key_json) -> bool: whether the entry is on the ledger
              now (e.g. from a getLedgerEntries sweep over the pad keys)
      actual  callable(key_json) -> int: the entry's write-byte coverage,
              its LedgerEntryData XDR size plus the 8-byte LedgerEntry
              framing (measured on testnet, ADR-028); consulted for existing
              keys only
      growth  int, extra bytes per existing key for entries the transaction
              may grow (default 0)
      slack   int, flat extra write bytes for the whole transaction
              (default 0)
    A nonexistent pad key gets zero write-byte coverage (nonexistent keys are
    free, ADR-025 finding 1). Instruction and fee headroom per key are
    unchanged: the host charges footprint processing and the write-entry fee
    whether or not the entry exists. Beware the race: a pad key created on the
    ledger between the existence check and apply must be covered or the
    transaction fails ResourceLimitExceeded at apply (fee charged); callers
    accept that risk when they pass `sizes`.
    """
    tx = sim_json["tx"]["tx"]
    sd = tx["ext"]["v1"]
    fp = sd["resources"]["footprint"]
    ro = {json.dumps(k, sort_keys=True): k for k in fp["read_only"]}
    rw = {json.dumps(k, sort_keys=True) for k in fp["read_write"]}
    added = 0
    added_keys = []
    for k in extra_keys:
        s = json.dumps(k, sort_keys=True)
        if s in rw:
            continue
        if s in ro:
            # Simulation saw this key read-only (an empty level, a word with
            # no bit); the book may move it in flight and the walk would then
            # WRITE it. Promote to read-write (measured on testnet, ADR-025).
            fp["read_only"] = [x for x in fp["read_only"] if json.dumps(x, sort_keys=True) != s]
            del ro[s]
        fp["read_write"].append(k)
        rw.add(s)
        added_keys.append(k)
        added += 1
    # Padded keys cost the host instructions to process (the simulated budget
    # is exact) and grow the tx: add instruction and fee headroom per key.
    res = sd["resources"]
    # Measured on testnet (ADR-026): a heal with 171 read-write keys and a
    # small simulated walk used 24.79M instructions, 169 more than
    # 1.2x + 100k/key + 300k declared, so the per-key cost is right at 100k
    # and the headroom above it must not depend on the simulated amount.
    # x1.25 + 3M flat: a walk can do more work at apply than simulation saw
    # (levels appear in flight during a trend); measured shortfalls of 146-169
    # instructions at 1.2x+1M during fast rallies (ADR-026, ADR-028 era logs).
    res["instructions"] = int(res["instructions"] * 1.25) + 120_000 * added + 3_000_000
    # An EXISTING entry declared read-write must be covered by write_bytes even
    # if never touched (measured on testnet, ADR-025); nonexistent keys and
    # read-only keys are free. Without existence knowledge (`sizes` is None)
    # cover each padded key at the largest entry size.
    if sizes is None:
        res["write_bytes"] = int(res["write_bytes"]) + 600 * added
    else:
        extra_wb = int(sizes.get("slack", 0))
        for k in added_keys:
            if sizes["exists"](k):
                extra_wb += int(sizes["actual"](k)) + int(sizes.get("growth", 0))
        res["write_bytes"] = int(res["write_bytes"]) + extra_wb
    # classic entries (trustlines) live on disk: cover their read bytes too
    res["disk_read_bytes"] = int(res["disk_read_bytes"]) + 400 * added
    # Every read-write footprint entry pays the write-entry fee (2,500 stroops)
    # at submission whether or not it is written, plus write bytes at 875/KB,
    # instructions at 7 per 10k, and tx size at ~406/KB (measured on testnet,
    # ADR-025); a fee below that minimum is TxSorobanInvalid.
    rf = int(sd["resource_fee"])
    rf = int(rf * 1.3) + (2_500 + 600 * 875 // 1024 + 400 * 447 // 1024 + 1_563 + 120 * 7 + 100) * added + 3_000_000 * 7 // 10_000
    sd["resource_fee"] = str(rf)
    tx["fee"] = rf + 1000
    return added


ERR_NAMES = {
    1: "NotAdmin", 2: "Paused", 3: "SameToken", 4: "UnknownMarket", 5: "BadQuantization",
    6: "TickOutOfBand", 7: "BadStartTick", 8: "QtyOutOfBounds", 9: "Crossed", 10: "Unfilled",
    11: "LevelFull", 12: "RetryRest", 13: "OrderExists", 14: "NotOwner", 15: "UnknownOrder",
    16: "Overflow", 17: "FeeTooHigh", 18: "TooManyLegs", 19: "BadWindow", 20: "BatchTooLarge",
    21: "TokenNotAuthorized", 22: "CorruptEntry", 23: "NotInitialized", 24: "SelfTrade",
}


def classify(rc, out, err):
    text = out + err
    if rc == 0 and '"status": "SUCCESS"' in text:
        return "ok"
    m = re.search(r"Error\(Contract, #(\d+)\)", text)
    if m:
        return "typed:" + ERR_NAMES.get(int(m.group(1)), m.group(1))
    if re.search(r"Error\(Storage, ", text) or "footprint" in text.lower() and "TxSorobanInvalid" not in text:
        return "footprint"
    if "TxSorobanInvalid" in text:
        return "soroban_invalid"
    if "txBadSeq" in text or "BAD_SEQ" in text:
        return "bad_seq"
    if "ResourceLimitExceeded" in text:
        return "resource_limit"
    if "submission timeout" in text or "timed out" in text.lower():
        return "rpc_timeout"
    return "other"


class Soak:
    def __init__(self, a):
        self.a = a
        self.cli = Cli(a.contract, a.config_dir, a.network, a.rpc)
        self.lock = threading.Lock()
        self.log = open(a.log, "a")
        self.counts = {}
        self.stop = threading.Event()
        self.addr = {k: self.cli.address(k) for k in ["pb-taker", "pb-maker", "pb-spam", "pb-storm"]}
        self.nonce = {k: int(time.time()) % 1_000_000 * 1000 for k in self.addr}

    def record(self, role, action, outcome, detail=""):
        with self.lock:
            self.counts[outcome] = self.counts.get(outcome, 0) + 1
            self.log.write(json.dumps({"t": time.time(), "role": role, "action": action, "outcome": outcome, "detail": detail if len(detail) <= 600 else detail[:400] + " ... " + detail[-200:]}) + "\n")
            self.log.flush()

    def next_nonce(self, role):
        self.nonce[role] += 1
        return self.nonce[role]

    def submit(self, role, fn, args, pad=None):
        source = role
        try:
            xdr = self.cli.build(source, fn, args)
            sim = self.cli.simulate(source, xdr)
        except SimError as e:
            e = str(e)
            outcome = "sim:" + classify(1, "", e)
            self.record(role, fn, outcome, e[:400] + " ... " + e[-200:] if len(e) > 600 else e)
            return outcome
        except Exception as e:
            self.record(role, fn, "build_error", str(e))
            return None
        obj = self.cli.decode(sim)
        if pad:
            apply_pad(obj, pad)
        final = self.cli.encode(obj)
        try:
            signed = self.cli.sign(source, final)
        except Exception as e:
            self.record(role, fn, "sign_error", str(e))
            return None
        rc, out, err = self.cli.send(signed)
        outcome = classify(rc, out, err)
        m = re.search(r"Transaction hash is ([0-9a-f]{64})", out + err)
        h = m.group(1) if m else ""
        if outcome in ("other", "trapped") and "Trapped" in out + err and h:
            outcome = self.cli.diagnose(h)
        self.record(role, fn, outcome, h + " " + (out + err)[-160:])
        return outcome

    # ---- roles
    def best(self, is_bid):
        try:
            v = self.cli.invoke_readonly("pb-taker", "best", ["--market", str(self.a.market), "--is_bid", str(is_bid).lower()])
            return v
        except Exception:
            return None

    def place(self, role, is_bid, limit, qty, flags, pad=True):
        market = self.a.market
        q = self.cli.invoke_readonly(role, "quote_place", ["--market", str(market), "--is_bid", str(is_bid).lower(), "--limit_tick", str(limit), "--qty", str(qty)])
        nonce = self.next_nonce(role)
        w = window_json(q, None)
        args = ["--taker", self.addr[role], "--market", str(market), "--is_bid", str(is_bid).lower(), "--limit_tick", str(limit), "--qty_lots", str(qty), "--start_tick", str(q["start_tick"]), "--nonce", str(nonce), "--window", w, "--flags", json.dumps(flags)]
        keys = None
        if pad:
            keys = pad_keys(self.a.contract, market, is_bid, limit, q, limit, self.addr[role], nonce, self.a.base, self.a.quote)
            keys += token_keys(self.a.contract, [self.a.base, self.a.quote], self.addr[role], self.a.issuer, self.a.codes.split(","))
        return self.submit(role, "place", args, keys), nonce

    def settle(self, role, nonce, is_bid, tick):
        """settle(owner, market, nonce): simulation sees the order's level and pages;
        the pad adds both tokens (a fill in flight pays the other one) and the
        level's pages (a page turn in flight)."""
        pad = token_keys(self.a.contract, [self.a.base, self.a.quote], self.addr[role], self.a.issuer, self.a.codes.split(","))
        for pg in (0, 1):
            pad.append(ck(self.a.contract, "LevelPage", self.a.market, is_bid, tick, pg))
        return self.submit(role, "settle", ["--owner", self.addr[role], "--market", str(self.a.market), "--nonce", str(nonce)], pad)

    def taker_loop(self):
        while not self.stop.is_set():
            is_bid = random.random() < 0.5
            b = self.best(not is_bid)
            if b is None:
                time.sleep(4)
                continue
            limit = b + random.randint(0, 3) if is_bid else max(1, b - random.randint(0, 3))
            qty = random.randint(1, 4)
            self.place("pb-taker", is_bid, limit, qty, {"post_only": False, "fill_or_kill": False, "no_rest": random.random() < 0.5})
            time.sleep(random.uniform(1, 4))

    def maker_loop(self):
        mid = self.a.mid
        live = []
        settle_later = []
        while not self.stop.is_set():
            # keep ~4 quotes each side; rest missing ones, occasionally replace_batch them 1 tick
            side = random.random() < 0.5
            tick = mid + random.randint(1, 5) if not side else mid - random.randint(1, 5)
            out, nonce = self.place("pb-maker", side, tick, random.randint(2, 6), {"post_only": True, "fill_or_kill": False, "no_rest": False})
            if out == "ok":
                live.append((nonce, side, tick))
            if len(live) >= 6:
                items = []
                for (n, s, t) in live[:6]:
                    nt = t + (1 if random.random() < 0.5 else -1)
                    if nt < 1:
                        nt = t
                    items.append({"nonce": n, "is_bid": s, "tick": nt, "qty_lots": random.randint(2, 6), "window": {"consume": [], "append": {"first": 0, "last": 1}}})
                pad = token_keys(self.a.contract, [self.a.base, self.a.quote], self.addr["pb-maker"], self.a.issuer, self.a.codes.split(","))
                for it in items:
                    pad += rest_keys(self.a.contract, self.a.market, it["is_bid"], it["tick"])
                out = self.submit("pb-maker", "replace_batch", ["--owner", self.addr["pb-maker"], "--market", str(self.a.market), "--items", json.dumps(items)], pad)
                if out == "ok":
                    settle_later.append((time.time(), [(it["nonce"], it["is_bid"], it["tick"]) for it in items]))
                else:
                    settle_later.append((time.time(), live[:6]))
                live = live[6:]
            now = time.time()
            for (t0, orders) in [x for x in settle_later if now - x[0] > 40]:
                settle_later.remove((t0, orders))
                for (n, s, t) in orders:
                    self.settle("pb-maker", n, s, t)
            time.sleep(random.uniform(2, 6))

    def spam_loop(self):
        while not self.stop.is_set():
            ba, bb = self.best(False), self.best(True)
            if ba is None or bb is None or ba - bb < 2:
                time.sleep(5)
                continue
            inside = bb + 1
            out, nonce = self.place("pb-spam", True, inside, 1, {"post_only": True, "fill_or_kill": False, "no_rest": False})
            if out == "ok":
                time.sleep(random.uniform(1, 3))
                nt = max(1, bb - 20)
                pad = token_keys(self.a.contract, [self.a.base, self.a.quote], self.addr["pb-spam"], self.a.issuer, self.a.codes.split(","))
                pad += rest_keys(self.a.contract, self.a.market, True, nt)
                self.submit("pb-spam", "replace", ["--owner", self.addr["pb-spam"], "--market", str(self.a.market), "--nonce", str(nonce), "--is_bid", "true", "--tick", str(nt), "--qty_lots", "1", "--window", json.dumps({"consume": [], "append": {"first": 0, "last": 1}})], pad)
            time.sleep(random.uniform(3, 8))

    def storm_loop(self):
        pending = []
        while not self.stop.is_set():
            ba = self.best(False)
            if ba is None:
                time.sleep(5)
                continue
            for _ in range(random.randint(3, 8)):
                # a full level is a simulation-time LevelFull: step out one tick at a time
                for k in range(0, 4):
                    out, nonce = self.place("pb-storm", False, ba + k, 1, {"post_only": True, "fill_or_kill": False, "no_rest": False})
                    if out == "ok":
                        pending.append((time.time(), nonce, ba + k))
                    if out != "sim:typed:LevelFull":
                        break
            now = time.time()
            due = [p for p in pending if now - p[0] > 45]
            pending = [p for p in pending if now - p[0] <= 45]
            for (_, n, t) in due:
                self.settle("pb-storm", n, False, t)
            time.sleep(random.uniform(8, 20))

    def run(self):
        start = self.cli.latest_ledger()
        end = start + self.a.ledgers
        threads = [threading.Thread(target=f, daemon=True) for f in [self.taker_loop, self.maker_loop, self.spam_loop, self.storm_loop]]
        for t in threads:
            t.start()
        last = start
        while True:
            time.sleep(15)
            cur = self.cli.latest_ledger()
            if cur >= end:
                break
            if cur - last >= 100:
                last = cur
                self.record("soak", "progress", "tick", f"ledger {cur}/{end} counts={json.dumps(self.counts)}")
        self.stop.set()
        summary = {"start_ledger": start, "end_ledger": self.cli.latest_ledger(), "counts": self.counts}
        self.record("soak", "done", "summary", json.dumps(summary))
        print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--contract", required=True)
    ap.add_argument("--market", type=int, default=0)
    ap.add_argument("--base", required=True)
    ap.add_argument("--quote", required=True)
    ap.add_argument("--config-dir", default=".stellar")
    ap.add_argument("--network", default="testnet")
    ap.add_argument("--rpc", default="https://soroban-testnet.stellar.org")
    ap.add_argument("--ledgers", type=int, default=2000)
    ap.add_argument("--mid", type=int, default=100)
    ap.add_argument("--issuer", required=True, help="classic issuer of both assets")
    ap.add_argument("--codes", required=True, help="asset codes base,quote (e.g. PBA,PBB)")
    ap.add_argument("--log", default="tools/soak/soak.log")
    Soak(ap.parse_args()).run()
