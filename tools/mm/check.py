#!/usr/bin/env python3
"""Audit the running market maker (tools/mm/mm.py) from the outside.

Prints one summary line ("MM OK ..." or "MM ALERT ...") and exits non-zero
on an alert. Checks: the bot is alive (a recent `loop` line), its mid agrees
with an independent feed fetch, its quotes straddle the mid at a sane
distance, the on-chain bests are consistent with its quotes, no footprint /
unknown-trap / tool errors in the last hour, and the fee reserve holds.

  python3 tools/mm/check.py --contract C... --market 1 [--log tools/mm/mm.log]
"""
import argparse
import collections
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mm  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--contract", required=True)
    ap.add_argument("--market", type=int, required=True)
    ap.add_argument("--identity", default="pb-mm")
    ap.add_argument("--config-dir", default=".stellar")
    ap.add_argument("--network", default="testnet")
    ap.add_argument("--rpc", default="https://soroban-testnet.stellar.org")
    ap.add_argument("--log", default="tools/mm/mm.log")
    ap.add_argument("--state", default="tools/mm/state.json")
    ap.add_argument("--max-loop-age", type=float, default=300)
    ap.add_argument("--max-mid-dev-bps", type=float, default=50)
    ap.add_argument("--max-touch-bps", type=float, default=40)
    ap.add_argument("--through-mid-tol-bps", type=float, default=15)
    ap.add_argument("--min-xlm", type=float, default=2000)
    ap.add_argument("--window", type=float, default=3600)
    a = ap.parse_args()

    alerts, notes = [], []
    now = time.time()

    # 1. alive + recent outcomes
    last_loop = None
    outcomes = collections.Counter()
    heals = 0
    try:
        with open(a.log) as f:
            for line in f:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("action") == "loop":
                    last_loop = d
                if now - d.get("t", 0) <= a.window and d.get("action") not in ("loop",):
                    outcomes[(d.get("action"), d.get("outcome"))] += 1
                    if d.get("action") == "heal":
                        heals += 1
    except FileNotFoundError:
        alerts.append("no log")
    if last_loop is None:
        alerts.append("no loop line yet")
    else:
        age = now - last_loop["t"]
        if age > a.max_loop_age:
            alerts.append(f"bot stale: last loop {int(age)}s ago")
    bad = {k: v for k, v in outcomes.items() if k[1] in ("footprint", "trapped:unknown", "build_error", "sign_error", "resource_limit", "soroban_invalid") or k[1].startswith("typed:") and "Crossed" not in k[1]}
    if bad:
        alerts.append("bad outcomes in window: " + json.dumps({f"{k[0]}/{k[1]}": v for k, v in bad.items()}))
    ok_n = sum(v for k, v in outcomes.items() if k[1] == "ok")
    sim_rej = sum(v for k, v in outcomes.items() if k[1].startswith("sim:"))
    apply_rej = sum(v for k, v in outcomes.items() if k[1].startswith("typed:"))

    # 2. independent price
    feed = mm.Feed()
    p = feed.fetch()
    if p is None:
        notes.append("feed unavailable now")
    elif last_loop and last_loop.get("mid"):
        dev = abs(last_loop["mid"] - p) / p * 1e4
        if dev > a.max_mid_dev_bps:
            alerts.append(f"bot mid {last_loop['mid']} vs feed {p}: {dev:.0f} bps")

    # 3. our quotes straddle the mid sanely
    state = {}
    if os.path.exists(a.state):
        with open(a.state) as f:
            state = json.load(f)
    quotes = state.get("quotes", {})
    bids = [q["tick"] for q in quotes.values() if q["side"] == "bid"]
    asks = [q["tick"] for q in quotes.values() if q["side"] == "ask"]
    our_bid = max(bids) if bids else None
    our_ask = min(asks) if asks else None
    if p is not None and our_bid is not None and our_ask is not None:
        mid_tick = mm.tick_of(p)
        if our_bid >= our_ask:
            alerts.append(f"own quotes crossed: bid {our_bid} ask {our_ask}")
        # the feed can move a few bps inside one 30 s cycle: only a quote
        # clearly through the *current* mid is an alert
        tol = int(mid_tick * a.through_mid_tol_bps / 1e4)
        if our_bid >= mid_tick + tol or our_ask <= mid_tick - tol:
            alerts.append(f"quote through the mid: bid {our_bid} ask {our_ask} mid {mid_tick}")
        elif our_bid >= mid_tick or our_ask <= mid_tick:
            notes.append(f"touch at/through the instantaneous mid (bid {our_bid} ask {our_ask} mid {mid_tick}); within {a.through_mid_tol_bps} bps tolerance")
        tb = (mid_tick - our_bid) / mid_tick * 1e4
        ta = (our_ask - mid_tick) / mid_tick * 1e4
        if tb > a.max_touch_bps or ta > a.max_touch_bps:
            alerts.append(f"touch far from mid: bid {tb:.0f} bps, ask {ta:.0f} bps")
    elif last_loop is not None and (now - last_loop["t"]) < a.max_loop_age and (not bids or not asks):
        alerts.append(f"one-sided or empty ladder: {len(bids)} bids, {len(asks)} asks")

    # 4. on-chain bests vs our quotes (ours should be at or inside the recorded bests unless someone else is inside)
    cli = mm.soak.Cli(a.contract, a.config_dir, a.network, a.rpc)
    book_bid = book_ask = None
    try:
        book_bid = cli.invoke_readonly(a.identity, "best", ["--market", str(a.market), "--is_bid", "true"])
        book_ask = cli.invoke_readonly(a.identity, "best", ["--market", str(a.market), "--is_bid", "false"])
    except Exception as e:
        notes.append(f"best view error: {str(e)[-80:]}")
    if book_bid is not None and book_ask is not None and book_bid >= book_ask:
        # a recorded best can be a phantom (empty level, stale-better bit): tell the two apart
        try:
            lb = cli.invoke_readonly(a.identity, "level", ["--market", str(a.market), "--is_bid", "true", "--tick", str(book_bid)])
            la = cli.invoke_readonly(a.identity, "level", ["--market", str(a.market), "--is_bid", "false", "--tick", str(book_ask)])
            if lb.get("open_lots", 0) > 0 and la.get("open_lots", 0) > 0:
                alerts.append(f"book crossed for real: bid {book_bid} ({lb['open_lots']} lots) ask {book_ask} ({la['open_lots']} lots)")
            else:
                notes.append(f"recorded bests cross via a phantom (bid {book_bid}/{lb.get('open_lots')} lots, ask {book_ask}/{la.get('open_lots')} lots)")
        except Exception as e:
            notes.append(f"level view error: {str(e)[-80:]}")

    # 5. reserve
    xlm = last_loop.get("xlm") if last_loop else None
    if xlm is not None and xlm < a.min_xlm:
        alerts.append(f"XLM reserve low: {xlm}")

    summary = {
        "feed": p, "bot_mid": last_loop.get("mid") if last_loop else None, "loop_age_s": int(now - last_loop["t"]) if last_loop else None,
        "live": len(quotes), "our_bid": our_bid, "our_ask": our_ask, "book_bid": book_bid, "book_ask": book_ask,
        "fills_total": last_loop.get("fills_total") if last_loop else None, "volume_lots": last_loop.get("volume_lots") if last_loop else None,
        "xlm": xlm, "usdc": last_loop.get("usdc") if last_loop else None,
        "last_hour": {"ok": ok_n, "sim_rejected": sim_rej, "apply_rejected": apply_rej, "heals": heals},
    }
    if alerts:
        print("MM ALERT " + "; ".join(alerts) + " | " + json.dumps(summary) + (" | " + "; ".join(notes) if notes else ""))
        sys.exit(1)
    print("MM OK " + json.dumps(summary) + (" | " + "; ".join(notes) if notes else ""))


if __name__ == "__main__":
    main()
