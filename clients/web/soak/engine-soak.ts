import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as StellarSdk from "@stellar/stellar-sdk";
import { createRpc } from "../src/book";
import { addrToHex } from "../src/engine/clientKeys";
import { errorName, parseContractError } from "../src/engine/errors";
import { keysForReplace, keysForSettle, pad, type WindowSpec } from "../src/engine/pad";
import { simulatePlace } from "../src/engine/quote";
import {
  submitPlace,
  submitReplace,
  submitSettle,
  type ClassicToken,
  type EngineResult,
  type PlaceFlags,
} from "../src/engine/submit";
import { readAccount } from "../src/wallet/account";
import { NETWORK_PASSPHRASE } from "../src/wallet/network";

const CONTRACT = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO";
const MARKET = 0;
const BASE = "CDAHSKHBGFENTV3XGWRWVIWE3ISAEYIZQNGD4GCWRDDIOIW4DVZ26FQG";
const QUOTE = "CBEC6J5RWWWC7CYCHJTXIBDFTFRK6GTMLK4E47BECO5BDXVM7YHATUIK";
const ISSUER = "GCBMNFRU74KLBUCVHJVQXRRMGEWUWC2WZ5KXLYABNFLXGCFTJPKBT4IB";
const RPC_URL = "https://soroban-testnet.stellar.org";
function findConfigDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const tries = [
    process.env.STELLAR_CONFIG_DIR,
    resolve(here, "../../../../.stellar"),
    resolve(here, "../../../../../.stellar"),
    join(process.env.HOME ?? "", "code/pagebook/.stellar"),
  ].filter((x): x is string => !!x);
  for (const t of tries) {
    if (existsSync(join(t, "identity/pb-maker.toml"))) return t;
  }
  return tries[0] ?? ".stellar";
}

const CONFIG_DIR = findConfigDir();
const LOG = resolve(dirname(fileURLToPath(import.meta.url)), "engine-soak.log");
const MIN_LEDGERS = 150;
const MIN_TXS = 120;

const TOKENS: ClassicToken[] = [
  { sac: BASE, code: "PBA", issuer: ISSUER },
  { sac: QUOTE, code: "PBB", issuer: ISSUER },
];

type Live = { nonce: bigint; isBid: boolean; tick: number };

function secretOf(name: string): string {
  const r = spawnSync("stellar", ["keys", "secret", name, "--config-dir", CONFIG_DIR], {
    encoding: "utf8",
  });
  const line = r.stdout.trim().split(/\n/).pop() ?? "";
  if (!line.startsWith("S") || line.length !== 56) {
    throw new Error(`could not load identity ${name}`);
  }
  return line;
}

function outcomeOf(res: EngineResult): string {
  if (res.kind === "ok") return "ok";
  if (res.kind === "typed") return `typed:${res.errorName}@${res.at}`;
  if (res.kind === "footprint") return "footprint";
  return `rpc:${res.message.slice(0, 80)}`;
}

class Soak {
  rpc = createRpc(RPC_URL);
  makerKp: StellarSdk.Keypair;
  takerKp: StellarSdk.Keypair;
  nonce = BigInt(Date.now()) * 1000n;
  counts: Record<string, number> = {};
  txs = 0;
  startLedger = 0;
  makerLive: Live[] = [];
  takerLive: Live[] = [];
  settleLater: { at: number; orders: Live[] }[] = [];

  constructor() {
    this.makerKp = StellarSdk.Keypair.fromSecret(secretOf("pb-maker"));
    this.takerKp = StellarSdk.Keypair.fromSecret(secretOf("pb-taker"));
    mkdirSync(dirname(LOG), { recursive: true });
  }

  nextNonce(): bigint {
    this.nonce += 1n;
    return this.nonce;
  }

  log(who: string, action: string, res: EngineResult, extra: Record<string, unknown> = {}): void {
    const outcome = outcomeOf(res);
    this.counts[outcome] = (this.counts[outcome] ?? 0) + 1;
    this.txs += 1;
    const line = JSON.stringify({
      t: Date.now() / 1000,
      who,
      action,
      outcome,
      hash: "hash" in res ? res.hash : undefined,
      ledger: res.kind === "ok" ? res.ledger : undefined,
      fee: res.kind === "ok" ? res.fee : undefined,
      ...extra,
    });
    appendFileSync(LOG, line + "\n");
    process.stdout.write(line + "\n");
  }

  async latest(): Promise<number> {
    return (await this.rpc.getLatestLedger()).sequence;
  }

  async seqOf(pub: string): Promise<string> {
    const a = await readAccount(this.rpc, pub);
    if (!a.exists) throw new Error("unfunded");
    return a.sequence.toString();
  }

  async best(isBid: boolean): Promise<number | null> {
    try {
      const src = this.takerKp.publicKey();
      const account = new StellarSdk.Account(src, await this.seqOf(src));
      const c = new StellarSdk.Contract(CONTRACT);
      const op = c.call("best", StellarSdk.nativeToScVal(MARKET, { type: "u32" }), StellarSdk.nativeToScVal(isBid));
      const tx = new StellarSdk.TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(op)
        .setTimeout(30)
        .build();
      const sim = await this.rpc.simulateTransaction(tx.toXDR());
      const xdr = sim.results?.[0]?.xdr;
      if (!xdr) return null;
      const native = StellarSdk.scValToNative(StellarSdk.xdr.ScVal.fromXDR(xdr, "base64")) as unknown;
      if (native == null) return null;
      return Number(native);
    } catch {
      return null;
    }
  }

  async place(
    who: "pb-maker" | "pb-taker",
    isBid: boolean,
    limit: number,
    qty: bigint,
    flags: PlaceFlags,
  ): Promise<{ res: EngineResult; nonce: bigint; quotedStart?: number }> {
    const kp = who === "pb-maker" ? this.makerKp : this.takerKp;
    const nonce = this.nextNonce();
    let quoted;
    try {
      const q = await simulatePlace(this.rpc, {
        contract: CONTRACT,
        source: kp.publicKey(),
        sequence: await this.seqOf(kp.publicKey()),
        market: MARKET,
        isBid,
        limitTick: limit,
        qty,
        taker: kp.publicKey(),
        nonce,
        base: BASE,
        quote: QUOTE,
      });
      quoted = q.quoted;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = parseContractError(msg);
      const res: EngineResult =
        code != null
          ? { kind: "typed", errorCode: code, errorName: errorName(code), at: "simulation" }
          : { kind: "rpc", message: msg };
      this.log(who, "place", res, { isBid, limit, qty: qty.toString() });
      return { res, nonce };
    }
    const out = pad(quoted, limit);
    const res = await submitPlace(this.rpc, {
      contract: CONTRACT,
      secret: kp.secret(),
      taker: kp.publicKey(),
      market: MARKET,
      isBid,
      limitTick: limit,
      qtyLots: qty,
      startTick: quoted.startTick,
      nonce,
      window: out.window,
      flags,
      quoted,
      tokens: TOKENS,
      padEnd: limit,
    });
    this.log(who, "place", res, { isBid, limit, qty: qty.toString(), crossed: quoted.crossed.length });
    return { res, nonce, quotedStart: quoted.startTick };
  }

  async settle(who: "pb-maker" | "pb-taker", live: Live): Promise<void> {
    const kp = who === "pb-maker" ? this.makerKp : this.takerKp;
    const keys = keysForSettle(
      MARKET,
      addrToHex(kp.publicKey()),
      live.nonce,
      live.isBid,
      live.tick,
      0,
      addrToHex(BASE),
      addrToHex(QUOTE),
    );
    const res = await submitSettle(this.rpc, {
      contract: CONTRACT,
      secret: kp.secret(),
      owner: kp.publicKey(),
      market: MARKET,
      nonce: live.nonce,
      padKeys: keys,
      tokens: TOKENS,
    });
    this.log(who, "settle", res, { nonce: live.nonce.toString(), tick: live.tick });
  }

  async replace(who: "pb-maker", live: Live, newTick: number): Promise<Live> {
    const kp = this.makerKp;
    const window: WindowSpec = { consume: [], append: { first: 0, last: 1 } };
    const { keys } = keysForReplace(
      MARKET,
      addrToHex(kp.publicKey()),
      live.nonce,
      live.isBid,
      live.tick,
      0,
      live.isBid,
      newTick,
      0,
      addrToHex(BASE),
      addrToHex(QUOTE),
    );
    const res = await submitReplace(this.rpc, {
      contract: CONTRACT,
      secret: kp.secret(),
      owner: kp.publicKey(),
      market: MARKET,
      nonce: live.nonce,
      isBid: live.isBid,
      tick: newTick,
      qtyLots: 3n,
      window,
      padKeys: keys,
      tokens: TOKENS,
    });
    this.log(who, "replace", res, { from: live.tick, to: newTick });
    if (res.kind === "ok") return { ...live, tick: newTick };
    return live;
  }

  async makerStep(): Promise<void> {
    const side = Math.random() < 0.5;
    let tick = side ? 80 - Math.floor(Math.random() * 10) : 120 + Math.floor(Math.random() * 10);
    let placed: { res: EngineResult; nonce: bigint } | null = null;
    for (let step = 0; step < 6; step++) {
      const tryTick = side ? Math.max(1, tick - step) : tick + step;
      placed = await this.place("pb-maker", side, tryTick, BigInt(2 + Math.floor(Math.random() * 5)), {
        post_only: true,
        fill_or_kill: false,
        no_rest: false,
      });
      if (placed.res.kind === "ok") {
        this.makerLive.push({ nonce: placed.nonce, isBid: side, tick: tryTick });
        break;
      }
      if (!(placed.res.kind === "typed" && placed.res.errorName === "LevelFull")) break;
    }
    if (this.makerLive.length >= 4) {
      const batch = this.makerLive.splice(0, 2);
      const updated: Live[] = [];
      for (const o of batch) {
        const nt = Math.max(1, o.tick + (Math.random() < 0.5 ? 1 : -1));
        updated.push(await this.replace("pb-maker", o, nt));
      }
      this.settleLater.push({ at: Date.now() + 40_000, orders: updated });
    }
    const now = Date.now();
    const due = this.settleLater.filter((x) => now >= x.at);
    this.settleLater = this.settleLater.filter((x) => now < x.at);
    for (const g of due) {
      for (const o of g.orders) await this.settle("pb-maker", o);
    }
  }

  async takerStep(): Promise<void> {
    const isBid = Math.random() < 0.5;
    const b = await this.best(!isBid);
    if (b == null) return;
    const limit = isBid ? b + Math.floor(Math.random() * 4) : Math.max(1, b - Math.floor(Math.random() * 4));
    const qty = BigInt(1 + Math.floor(Math.random() * 4));
    const { res, nonce } = await this.place("pb-taker", isBid, limit, qty, {
      post_only: false,
      fill_or_kill: false,
      no_rest: Math.random() < 0.4,
    });
    if (res.kind === "ok") this.takerLive.push({ nonce, isBid, tick: limit });
    if (this.takerLive.length >= 3) {
      const o = this.takerLive.shift();
      if (o) await this.settle("pb-taker", o);
    }
  }

  async drain(): Promise<void> {
    for (const o of this.makerLive) await this.settle("pb-maker", o);
    this.makerLive = [];
    for (const g of this.settleLater) {
      for (const o of g.orders) await this.settle("pb-maker", o);
    }
    this.settleLater = [];
    for (const o of this.takerLive) await this.settle("pb-taker", o);
    this.takerLive = [];
  }

  async run(): Promise<void> {
    this.startLedger = await this.latest();
    process.stdout.write(JSON.stringify({ start: this.startLedger, maker: this.makerKp.publicKey(), taker: this.takerKp.publicKey() }) + "\n");
    while (true) {
      try {
        await this.makerStep();
        await this.takerStep();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        appendFileSync(LOG, JSON.stringify({ t: Date.now() / 1000, who: "soak", action: "loop", outcome: "rpc", error: msg.slice(0, 200) }) + "\n");
      }
      const cur = await this.latest();
      if (cur - this.startLedger >= MIN_LEDGERS && this.txs >= MIN_TXS) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    await this.drain();
    const end = await this.latest();
    const tally = { start_ledger: this.startLedger, end_ledger: end, txs: this.txs, counts: this.counts };
    appendFileSync(LOG, JSON.stringify({ t: Date.now() / 1000, who: "soak", action: "done", outcome: "summary", ...tally }) + "\n");
    process.stdout.write(JSON.stringify(tally, null, 2) + "\n");
    const footprints = Object.entries(this.counts).filter(([k]) => k === "footprint");
    if (footprints.length && footprints[0][1] > 0) {
      process.exitCode = 2;
    }
  }
}

const soak = new Soak();
soak.run().catch((e) => {
  process.stderr.write(String(e) + "\n");
  process.exit(1);
});
