#!/usr/bin/env python3
"""Outside-in health check for the live PageBook deployment.

Reads only public HTTP endpoints (Soroban RPC, Horizon, a spot feed), so it
runs anywhere: a laptop, CI, or an isolated cloud session with no fly.io
credentials and no stellar CLI keychain. It therefore cannot see the fly
machine, the bots' logs, or the on-machine watchdog; `clients/web/ops/check.ts`
does that and needs the bots' own log and state files. What this sees instead
is the ledger, which is the state the bots are supposed to be moving.

Three signals, in the order they answer "is the venue alive":

  liveness   contract events in the window, by type. A quoting maker emits
             `rested` and `top_changed`; crossing flow emits `filled` and
             `settled`. Silence means the bots are down or wedged.
  book       both recorded bests, read from the `BestTick` entries and priced
             through the market's own lot and tick size, against spot. Catches
             an empty, one-sided, crossed or drifted book.
  reserves   both bots' balances against the ADR-035 refill floors.

Configuration is read from the repo so this does not go stale after a
redeploy: contract and market from `clients/web/fly.toml`, bot addresses from
`clients/web/ops/refill.ts`. Flags override any of it.

Exit status is 0 whether or not anything is flagged: read the FLAGS line, or
use --json. Nothing here writes to the chain or needs a key.
"""

import argparse
import base64
import collections
import datetime
import json
import re
import struct
import sys
import urllib.error
import urllib.request
from pathlib import Path

# The RPC and Horizon answer the default urllib user agent with HTTP 403.
UA = {"User-Agent": "pagebook-health/1.0"}

REPO = Path(__file__).resolve().parents[2]
FLY_TOML = REPO / "clients" / "web" / "fly.toml"
REFILL_TS = REPO / "clients" / "web" / "ops" / "refill.ts"

# XDR discriminants, for building a LedgerKey and walking a stored ScVal map.
CONTRACT_DATA, ADDRESS_CONTRACT, PERSISTENT = 6, 1, 1
SCV_BOOL, SCV_U32, SCV_U64, SCV_SYMBOL, SCV_VEC = 0, 3, 5, 15, 16

NET_ERRORS = (urllib.error.URLError, OSError, KeyError, ValueError, TimeoutError)


def http_json(url, payload=None, timeout=45):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = dict(UA)
    if data:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


class Rpc:
    def __init__(self, url):
        self.url = url

    def __call__(self, method, params=None):
        body = {"jsonrpc": "2.0", "id": 1, "method": method}
        if params is not None:
            body["params"] = params
        out = http_json(self.url, body)
        if "error" in out:
            raise RuntimeError(f"{method}: {out['error']}")
        return out["result"]


def strkey_payload(addr):
    """The 32-byte payload of a `C...` or `G...` strkey address."""
    raw = base64.b32decode(addr + "=" * (-len(addr) % 8))
    if len(raw) != 35:  # version byte + 32 payload + 2 CRC
        raise ValueError(f"unexpected strkey length for {addr}")
    return raw[1:33]


def scv_symbol(name):
    body = name.encode()
    return struct.pack(">II", SCV_SYMBOL, len(body)) + body + b"\0" * (-len(body) % 4)


def scv_u32(v):
    return struct.pack(">II", SCV_U32, v)


def scv_bool(v):
    return struct.pack(">II", SCV_BOOL, 1 if v else 0)


def datakey(contract, variant, *fields):
    """A PageBook `DataKey` enum value as a base64 LedgerKey (see keys.rs).

    A full-word enum variant encodes as an ScVal vec of the variant symbol
    followed by its fields, under a persistent contract-data key.
    """
    words = [scv_symbol(variant)]
    for f in fields:
        words.append(scv_bool(f) if isinstance(f, bool) else scv_u32(f))
    body = struct.pack(">I", CONTRACT_DATA)
    body += struct.pack(">I", ADDRESS_CONTRACT) + strkey_payload(contract)
    body += struct.pack(">III", SCV_VEC, 1, len(words)) + b"".join(words)
    body += struct.pack(">I", PERSISTENT)
    return base64.b64encode(body).decode()


def field_after(raw, name, tag, width):
    """Read one numeric field out of a stored ScVal map by its symbol name.

    A `#[contracttype]` struct is a symbol-keyed map, so a field's value sits
    directly after its name: the tag word, then the number. Reading the two or
    three fields this check needs is cheaper than decoding the whole map, and
    the tag check makes a coincidental name match harmless.
    """
    marker = name.encode()
    at = raw.find(marker)
    while at >= 0:
        cursor = at + len(marker)
        cursor += -cursor % 4  # symbol bodies are padded to a 4-byte boundary
        if raw[cursor:cursor + 4] == struct.pack(">I", tag):
            chunk = raw[cursor + 4:cursor + 4 + width]
            if len(chunk) == width:
                return int.from_bytes(chunk, "big")
        at = raw.find(marker, at + 1)
    return None


def entry_payloads(rpc, keys):
    """Decoded `LedgerEntryData` per requested key; None where absent."""
    res = rpc("getLedgerEntries", {"keys": keys})
    found = {}
    for e in res.get("entries", []):
        blob = e.get("xdr") or e.get("val")
        if isinstance(blob, str):
            found[e["key"]] = base64.b64decode(blob)
    return [found.get(k) for k in keys]


def from_repo(path, pattern, label):
    try:
        text = path.read_text()
    except OSError:
        print(f"note: {path} is unreadable; pass --{label} explicitly", file=sys.stderr)
        return None
    m = re.search(pattern, text)
    if not m:
        print(f"note: no {label} in {path.name}; pass --{label} explicitly", file=sys.stderr)
        return None
    return m.group(1)


def collect_events(rpc, contract, latest, window, flags):
    """Event counts, total and newest close time over the last `window` ledgers.

    Retries with a shorter window if the RPC has already pruned that far back.
    """
    while True:
        counts, total, newest, cursor = collections.Counter(), 0, None, None
        try:
            for _ in range(20):  # 20k events is far past any healthy hour
                page = {"filters": [{"type": "contract", "contractIds": [contract]}],
                        "pagination": {"limit": 1000}}
                if cursor:
                    page["pagination"]["cursor"] = cursor
                else:
                    page["startLedger"] = max(latest - window, 1)
                res = rpc("getEvents", page)
                batch = res.get("events", [])
                total += len(batch)
                for e in batch:
                    topic = base64.b64decode(e["topic"][0])
                    name = "".join(chr(c) for c in topic if 32 <= c < 127).strip()
                    counts[name or "?"] += 1
                    newest = e.get("ledgerClosedAt") or newest
                cursor = res.get("cursor")
                if len(batch) < 1000 or not cursor:
                    break
            return counts, total, newest, window
        except RuntimeError as exc:
            if window <= 90:
                flags.append(f"could not read contract events: {exc}")
                return counts, total, newest, window
            window //= 4


def main():
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--rpc", default="https://soroban-testnet.stellar.org")
    p.add_argument("--horizon", default="https://horizon-testnet.stellar.org")
    p.add_argument("--spot", default="https://api.coinbase.com/v2/prices/XLM-USD/spot")
    p.add_argument("--contract", help="default: CONTRACT in clients/web/fly.toml")
    p.add_argument("--market", type=int, help="default: MARKET in clients/web/fly.toml")
    p.add_argument("--maker", help="default: FLY_MAKER in clients/web/ops/refill.ts")
    p.add_argument("--trader", help="default: FLY_TRADER in clients/web/ops/refill.ts")
    p.add_argument("--xlm-floor", type=float, default=30_000,
                   help="maker XLM floor, ADR-035 (default: %(default)s)")
    p.add_argument("--usdc-floor", type=float, default=5_000,
                   help="trader USDC floor, ADR-035 (default: %(default)s)")
    p.add_argument("--window", type=int, default=720,
                   help="event window in ledgers, ~5s each (default: %(default)s, about an hour)")
    p.add_argument("--max-event-age", type=float, default=10.0,
                   help="minutes of silence before it is flagged (default: %(default)s)")
    p.add_argument("--max-spread-bps", type=float, default=200.0)
    p.add_argument("--max-drift-bps", type=float, default=300.0, help="mid against spot")
    p.add_argument("--json", action="store_true", help="emit the whole report as JSON")
    a = p.parse_args()

    contract = a.contract or from_repo(FLY_TOML, r'CONTRACT\s*=\s*"([A-Z0-9]+)"', "contract")
    if not contract:
        p.error("no contract to check: pass --contract")
    market = a.market if a.market is not None else int(
        from_repo(FLY_TOML, r'MARKET\s*=\s*"(\d+)"', "market") or 0)
    maker = a.maker or from_repo(REFILL_TS, r'FLY_MAKER\s*=\s*"([A-Z0-9]+)"', "maker")
    trader = a.trader or from_repo(REFILL_TS, r'FLY_TRADER\s*=\s*"([A-Z0-9]+)"', "trader")

    rpc = Rpc(a.rpc)
    flags = []
    report = {"contract": contract, "market": market}

    # --- liveness: what the bots have written to the ledger lately ---
    try:
        latest = rpc("getLatestLedger")["sequence"]
    except (RuntimeError, *NET_ERRORS) as exc:
        print(f"FLAGS: the RPC at {a.rpc} is unreachable: {exc}")
        return
    report["latest_ledger"] = latest

    counts, total, newest, window = collect_events(rpc, contract, latest, a.window, flags)
    age = None
    if newest:
        closed = datetime.datetime.strptime(newest, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=datetime.timezone.utc)
        age = round((datetime.datetime.now(datetime.timezone.utc) - closed).total_seconds() / 60, 1)
    report.update(event_window_ledgers=window, events=dict(counts.most_common()),
                  events_total=total, newest_event=newest, newest_event_age_min=age)

    if age is None:
        flags.append("no contract events in the window: the bots look down")
    else:
        if age > a.max_event_age:
            flags.append(f"newest contract event is {age} min old (over {a.max_event_age})")
        if counts["rested"] + counts["top_changed"] == 0:
            flags.append("no rested or top_changed events: the maker is not quoting")
        if counts["filled"] == 0:
            flags.append("no filled events: nothing is crossing")

    # --- book: both recorded bests, priced through the market's geometry ---
    try:
        market_raw, bid_raw, ask_raw = entry_payloads(rpc, [
            datakey(contract, "Market", market),
            datakey(contract, "BestTick", market, True),
            datakey(contract, "BestTick", market, False),
        ])
    except (RuntimeError, *NET_ERRORS) as exc:
        flags.append(f"could not read the book entries: {exc}")
        market_raw = bid_raw = ask_raw = None

    per_tick = None
    if market_raw is None:
        flags.append(f"no Market entry for market {market} on {contract[:8]}...")
    else:
        lot = field_after(market_raw, "lot_size", SCV_U64, 8)
        tick_size = field_after(market_raw, "tick_size", SCV_U64, 8)
        # Both assets are 7-decimal, so their 10^decimals factors cancel.
        per_tick = tick_size / lot if lot and tick_size else None
        if per_tick is None:
            flags.append("could not read lot_size/tick_size from the Market entry")
    report["price_per_tick"] = per_tick

    def best_of(raw):
        if raw is None:
            return None, None
        if field_after(raw, "empty", SCV_BOOL, 4):
            return None, None
        tick = field_after(raw, "tick", SCV_U32, 4)
        return tick, (tick * per_tick if tick is not None and per_tick else None)

    bid_tick, bid_px = best_of(bid_raw)
    ask_tick, ask_px = best_of(ask_raw)
    report["best_bid"] = {"tick": bid_tick, "price": bid_px}
    report["best_ask"] = {"tick": ask_tick, "price": ask_px}
    if market_raw is not None:
        if bid_tick is None or ask_tick is None:
            flags.append(f"empty or one-sided book (bid {bid_tick}, ask {ask_tick})")
        elif bid_tick >= ask_tick:
            flags.append(f"recorded bests cross: bid {bid_tick} is at or above ask {ask_tick} "
                         "(a phantom best, or a real cross)")

    spot = None
    try:
        spot = float(http_json(a.spot)["data"]["amount"])
    except NET_ERRORS as exc:
        flags.append(f"could not read the spot feed: {exc}")
    report["spot"] = spot

    if bid_px and ask_px:
        mid = (bid_px + ask_px) / 2
        spread_bps = (ask_px - bid_px) / mid * 10_000
        report.update(mid=mid, spread_bps=round(spread_bps, 1))
        if spread_bps > a.max_spread_bps:
            flags.append(f"spread is {spread_bps:.0f} bps (over {a.max_spread_bps:.0f})")
        if spot:
            drift_bps = (mid - spot) / spot * 10_000
            report["drift_bps"] = round(drift_bps, 1)
            if abs(drift_bps) > a.max_drift_bps:
                flags.append(f"mid {mid:.5f} is {drift_bps:+.0f} bps from spot {spot:.5f}")

    # --- reserves: the ADR-035 refill floors ---
    for label, addr, asset, floor in (("maker", maker, "XLM", a.xlm_floor),
                                      ("trader", trader, "USDC", a.usdc_floor)):
        if not addr:
            continue
        try:
            bal = {b.get("asset_code", "XLM"): float(b["balance"])
                   for b in http_json(f"{a.horizon}/accounts/{addr}")["balances"]}
        except NET_ERRORS as exc:
            flags.append(f"could not read the {label} balances: {exc}")
            continue
        report[label] = bal
        held = bal.get(asset, 0.0)
        if held < floor:
            flags.append(f"{label} {asset} {held:,.0f} is under its {floor:,.0f} floor "
                         "(the daily refill crank tops it up)")

    report["flags"] = flags
    if a.json:
        print(json.dumps(report, indent=2))
        return

    show = lambda v: f"{v:.5f}" if v else "-"
    print(f"contract {contract} market {market} at ledger {latest}")
    print(f"events over ~{window} ledgers: {report['events'] or 'none'} "
          f"total={total}, newest {age} min ago")
    line = f"book: bid {show(bid_px)} / ask {show(ask_px)}"
    if report.get("spread_bps") is not None:
        line += f", spread {report['spread_bps']:.0f} bps"
    if report.get("drift_bps") is not None:
        line += f", mid {report['drift_bps']:+.0f} bps against spot {spot:.5f}"
    print(line)
    for label, asset, floor in (("maker", "XLM", a.xlm_floor), ("trader", "USDC", a.usdc_floor)):
        bal = report.get(label)
        if bal:
            rest = " ".join(f"{k} {v:,.0f}" for k, v in sorted(bal.items()) if k != asset)
            print(f"{label}: {asset} {bal.get(asset, 0.0):,.0f} (floor {floor:,.0f}) {rest}")
    print("FLAGS: " + ("; ".join(flags) if flags else "none"))


if __name__ == "__main__":
    main()
