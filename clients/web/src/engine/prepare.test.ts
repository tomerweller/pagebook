import { expect, test } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";
import type { Rpc } from "../book";
import { accessOf, hexToAccount, sameKey, toLedgerKey, type ClientKey } from "./clientKeys";
import { ck } from "../keys";
import { CREATE_SIZES, PAD_SWEEP_CHUNK } from "./liveness";
import { pad, type Quoted } from "./pad";
import { prepareInvocation, type Intent, type PrepareRequest } from "./prepare";
import { DEFAULT_GROWTH, flatWriteBytesPer, WRITE_BYTES_PER } from "./txdata";
import { accountLedgerKey } from "../wallet/account";

const PAGEBOOK = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO";
const T1 = "01".repeat(32);
const T2 = "02".repeat(32);
const T3 = "03".repeat(32);

function emptyData(ro: StellarSdk.xdr.LedgerKey[], rw: StellarSdk.xdr.LedgerKey[]): StellarSdk.xdr.SorobanTransactionData {
  return new StellarSdk.xdr.SorobanTransactionData({
    ext: new StellarSdk.xdr.SorobanTransactionDataExt(0),
    resources: new StellarSdk.xdr.SorobanResources({
      footprint: new StellarSdk.xdr.LedgerFootprint({ readOnly: ro, readWrite: rw }),
      instructions: 1_000_000,
      diskReadBytes: 100,
      writeBytes: 50,
    }),
    resourceFee: new StellarSdk.xdr.Int64(10_000),
  });
}

function dataWithExt(
  ro: StellarSdk.xdr.LedgerKey[],
  rw: StellarSdk.xdr.LedgerKey[],
  archivedIndexes: number[],
): StellarSdk.xdr.SorobanTransactionData {
  const base = emptyData(ro, rw);
  return new StellarSdk.xdr.SorobanTransactionData({
    ext: new StellarSdk.xdr.SorobanTransactionDataExt(
      1,
      new StellarSdk.xdr.SorobanResourcesExtV0({ archivedSorobanEntries: archivedIndexes }),
    ),
    resources: base.resources(),
    resourceFee: base.resourceFee(),
  });
}

function accountDataXdr(pubkey: string, seq = "10"): string {
  const kp = StellarSdk.Keypair.fromPublicKey(pubkey);
  const acc = new StellarSdk.xdr.AccountEntry({
    accountId: kp.xdrAccountId(),
    balance: new StellarSdk.xdr.Int64(10_000_000_000),
    seqNum: new StellarSdk.xdr.Int64(Number(seq)) as never,
    numSubEntries: 0,
    inflationDest: null,
    flags: 0,
    homeDomain: "",
    thresholds: Uint8Array.from([1, 0, 0, 0]) as never,
    signers: [],
    ext: new StellarSdk.xdr.AccountEntryExt(0),
  });
  return StellarSdk.xdr.LedgerEntryData.account(acc).toXDR("base64");
}

function keyB64(k: StellarSdk.xdr.LedgerKey): string {
  return k.toXDR("base64");
}

function liveEntryXdr(contract: string, key: StellarSdk.xdr.LedgerKey, payload: number): { xdr: string; size: number } {
  const data = StellarSdk.xdr.LedgerEntryData.contractData(
    new StellarSdk.xdr.ContractDataEntry({
      ext: new StellarSdk.xdr.ExtensionPoint(0),
      contract: new StellarSdk.Address(contract).toScAddress(),
      key: key.contractData().key(),
      durability: StellarSdk.xdr.ContractDataDurability.persistent(),
      val: StellarSdk.xdr.ScVal.scvBytes(new Uint8Array(payload)),
    }),
  );
  const xdr = data.toXDR("base64");
  return { xdr, size: data.toXDR().length + 8 };
}

function placeQuoted(over: Partial<Quoted> = {}): Quoted {
  return {
    market: 0,
    ownSide: true,
    limitTick: 20,
    startTick: 10,
    crossed: [{ tick: 10 }],
    taker: T1,
    nonce: 7n,
    base: T2,
    quote: T3,
    ...over,
  };
}

function placeIntent(quoted: Quoted, padEnd: number): Intent {
  return {
    kind: "place",
    taker: hexToAccount(quoted.taker),
    market: quoted.market,
    isBid: quoted.ownSide,
    limitTick: quoted.limitTick,
    qtyLots: 1n,
    startTick: quoted.startTick,
    nonce: quoted.nonce,
    flags: { post_only: false, fill_or_kill: false, no_rest: false },
    quoted,
    padEnd,
  };
}

function simOk(data: StellarSdk.xdr.SorobanTransactionData, latestLedger = 200) {
  return {
    transactionData: data.toXDR("base64"),
    minResourceFee: "12000",
    results: [{ xdr: StellarSdk.xdr.ScVal.scvVoid().toXDR("base64") }],
    latestLedger,
  };
}

function fakeRpc(opts: {
  kp: StellarSdk.Keypair;
  simData: StellarSdk.xdr.SorobanTransactionData;
  entries?: Map<string, { xdr: string; liveUntil: number }>;
  latestLedger?: number;
  onGet?: (keys: StellarSdk.xdr.LedgerKey[]) => void;
  sendTransaction?: Rpc["sendTransaction"];
}): Rpc {
  const accKey = accountLedgerKey(opts.kp.publicKey()).toXDR("base64");
  const latest = opts.latestLedger ?? 200;
  return {
    getLatestLedger: async () => ({ sequence: latest }),
    getLedgerEntries: async (...keys) => {
      const list = keys as StellarSdk.xdr.LedgerKey[];
      opts.onGet?.(list);
      const want = list.map((k) => (typeof k === "string" ? k : keyB64(k)));
      if (want.length === 1 && want[0] === accKey) {
        return { entries: [{ key: accKey, xdr: accountDataXdr(opts.kp.publicKey()) }], latestLedger: latest };
      }
      const entries = [];
      for (const k of list) {
        const b64 = keyB64(k);
        const hit = opts.entries?.get(b64);
        if (hit) entries.push({ key: b64, xdr: hit.xdr, liveUntilLedgerSeq: hit.liveUntil });
      }
      return { entries, latestLedger: latest };
    },
    getEvents: async () => ({ events: [] }),
    getNetwork: async () => ({ passphrase: "Test SDF Network ; September 2015" }),
    sendTransaction: opts.sendTransaction ?? (async () => {
      throw new Error("sendTransaction should not run");
    }),
    getTransaction: async () => ({ status: "SUCCESS", txHash: "aa".repeat(32) }),
    simulateTransaction: async () => simOk(opts.simData, latest),
  };
}

function reqFor(kp: StellarSdk.Keypair, intent: Intent, extra: Partial<PrepareRequest> = {}): PrepareRequest {
  return {
    contract: PAGEBOOK,
    source: kp.publicKey(),
    intent,
    tokens: [],
    ...extra,
  };
}

test("live, absent, and archived band entries", async () => {
  const kp = StellarSdk.Keypair.random();
  const ctx = { contract: PAGEBOOK, caller: kp.publicKey() };
  const quoted = placeQuoted();
  const liveK = { t: "Level" as const, market: 0, isBid: false, tick: 10 };
  const archK = { t: "Level" as const, market: 0, isBid: false, tick: 11 };
  const absK = { t: "Level" as const, market: 0, isBid: false, tick: 12 };
  const liveXdr = toLedgerKey(ctx, liveK).xdr;
  const archXdr = toLedgerKey(ctx, archK).xdr;
  const absXdr = toLedgerKey(ctx, absK).xdr;
  const live = liveEntryXdr(PAGEBOOK, liveXdr, 80);
  const arch = liveEntryXdr(PAGEBOOK, archXdr, 40);
  const padKeys = pad(quoted, 12);
  const rest = padKeys.filter((k) => ![liveK, archK, absK].some((x) => sameKey(x, k)));
  const simData = emptyData(
    rest.filter((k) => accessOf(k) === "ro").map((k) => toLedgerKey(ctx, k).xdr),
    rest.filter((k) => accessOf(k) === "rw").map((k) => toLedgerKey(ctx, k).xdr),
  );
  const rpc = fakeRpc({
    kp,
    simData,
    entries: new Map([
      [keyB64(liveXdr), { xdr: live.xdr, liveUntil: 500 }],
      [keyB64(archXdr), { xdr: arch.xdr, liveUntil: 50 }],
    ]),
  });
  const got = await prepareInvocation(rpc, reqFor(kp, placeIntent(quoted, 12)));
  expect(got.kind).toBe("prepared");
  if (got.kind !== "prepared") return;
  expect(got.dropped).toBe(1);
  expect(got.footprint.rw.map(keyB64)).not.toContain(keyB64(archXdr));
  expect(got.footprint.rw.map(keyB64)).toContain(keyB64(liveXdr));
  expect(got.footprint.rw.map(keyB64)).toContain(keyB64(absXdr));
  expect(got.declared.wb).toBe(50 + live.size + DEFAULT_GROWTH + CREATE_SIZES.Level);
});

test("archived touched rest Level is kept and marked; nonexistent Order is not", async () => {
  const kp = StellarSdk.Keypair.random();
  const ctx = { contract: PAGEBOOK, caller: kp.publicKey() };
  const quoted = placeQuoted({ crossed: [] });
  const restLevel: ClientKey = { t: "Level", market: 0, isBid: true, tick: 20 };
  const order: ClientKey = { t: "Order", market: 0, owner: quoted.taker, nonce: quoted.nonce };
  const restXdr = toLedgerKey(ctx, restLevel).xdr;
  const orderXdr = toLedgerKey(ctx, order).xdr;
  const rest = liveEntryXdr(PAGEBOOK, restXdr, 60);
  const padKeys = pad(quoted, 12);
  const others = padKeys.filter((k) => !sameKey(k, restLevel) && !sameKey(k, order));
  const simData = emptyData(
    others.filter((k) => accessOf(k) === "ro").map((k) => toLedgerKey(ctx, k).xdr),
    others.filter((k) => accessOf(k) === "rw").map((k) => toLedgerKey(ctx, k).xdr),
  );
  const rpc = fakeRpc({
    kp,
    simData,
    entries: new Map([[keyB64(restXdr), { xdr: rest.xdr, liveUntil: 50 }]]),
  });
  const got = await prepareInvocation(rpc, reqFor(kp, placeIntent(quoted, 12)));
  expect(got.kind).toBe("prepared");
  if (got.kind !== "prepared") return;
  const rw = got.footprint.rw;
  expect(rw.map(keyB64)).toContain(keyB64(restXdr));
  const restIdx = rw.findIndex((k) => keyB64(k) === keyB64(restXdr));
  expect(got.restoreMarked.map(keyB64)).toContain(keyB64(restXdr));
  expect(got.restoreMarked.some((k) => keyB64(k) === keyB64(orderXdr))).toBe(false);
  const data = got.tx.toEnvelope().v1().tx().ext().sorobanData();
  expect(data.ext().resourceExt().archivedSorobanEntries().map(Number)).toContain(restIdx);
});

test("preserved simulation restore marks keep the same key at its new index", async () => {
  const kp = StellarSdk.Keypair.random();
  const ctx = { contract: PAGEBOOK, caller: kp.publicKey() };
  const quoted = placeQuoted();
  const marked = ck(PAGEBOOK, "TickSummary", 0, false).xdr;
  const padKeys = pad(quoted, 12);
  const others = padKeys.filter((k) => keyB64(toLedgerKey(ctx, k).xdr) !== keyB64(marked));
  const simData = dataWithExt(
    others.filter((k) => accessOf(k) === "ro").map((k) => toLedgerKey(ctx, k).xdr),
    [marked, ...others.filter((k) => accessOf(k) === "rw").map((k) => toLedgerKey(ctx, k).xdr)],
    [0],
  );
  const rpc = fakeRpc({ kp, simData });
  const got = await prepareInvocation(rpc, reqFor(kp, placeIntent(quoted, 12)));
  expect(got.kind).toBe("prepared");
  if (got.kind !== "prepared") return;
  const rw = got.footprint.rw;
  const idx = rw.findIndex((k) => keyB64(k) === keyB64(marked));
  expect(idx).toBeGreaterThanOrEqual(0);
  const data = got.tx.toEnvelope().v1().tx().ext().sorobanData();
  expect(data.ext().resourceExt().archivedSorobanEntries().map(Number)).toContain(idx);
});

test("oversized sparse band returns resourceLimit at prepare without signing", async () => {
  const kp = StellarSdk.Keypair.random();
  const quoted = placeQuoted({ startTick: 1, limitTick: 300, crossed: [] });
  const padEnd = 300;
  let sent = 0;
  const rpc = fakeRpc({
    kp,
    simData: emptyData([], []),
    sendTransaction: async () => {
      sent += 1;
      return { status: "PENDING", hash: "aa".repeat(32) };
    },
  });
  const intent = placeIntent(quoted, padEnd);
  const got = await prepareInvocation(rpc, reqFor(kp, intent));
  expect(got).toMatchObject({ kind: "resourceLimit", at: "prepare" });
  if (got.kind !== "resourceLimit") return;
  expect(got.message).toMatch(/read-write entries|write bytes|footprint entries/);
  expect(got.message).toMatch(/200|132,096|400/);
  expect(got.message).toMatch(/band 300 levels/);
  expect(sent).toBe(0);
  expect(quoted.limitTick).toBe(300);
  expect(padEnd).toBe(300);
});

test("batched sweep chunks planned keys by 100", async () => {
  const kp = StellarSdk.Keypair.random();
  const accKey = accountLedgerKey(kp.publicKey()).toXDR("base64");
  const quoted = placeQuoted({ startTick: 1, limitTick: 234, crossed: [] });
  const padEnd = 234;
  expect(pad(quoted, padEnd)).toHaveLength(250);
  const batches: number[] = [];
  const rpc = fakeRpc({
    kp,
    simData: emptyData([], []),
    onGet: (keys) => {
      if (keys.length === 1 && keyB64(keys[0]) === accKey) return;
      batches.push(keys.length);
    },
  });
  const got = await prepareInvocation(rpc, reqFor(kp, placeIntent(quoted, padEnd)));
  expect(got.kind === "prepared" || got.kind === "resourceLimit").toBe(true);
  expect(batches).toEqual([PAD_SWEEP_CHUNK, PAD_SWEEP_CHUNK, 50]);
  expect(batches.reduce((a, b) => a + b, 0)).toBe(250);
});

test("cover flat uses the flat rate; cached sweep skips covered keys", async () => {
  const kp = StellarSdk.Keypair.random();
  const ctx = { contract: PAGEBOOK, caller: kp.publicKey() };
  const quoted = placeQuoted({ startTick: 10, limitTick: 10, crossed: [] });
  const padEnd = 10;
  const planned = pad(quoted, padEnd);
  expect(planned.length).toBeGreaterThan(2);
  const cachedKey = toLedgerKey(ctx, planned[0]).xdr;
  const cached = {
    sizeOf(key: StellarSdk.xdr.LedgerKey) {
      return keyB64(key) === keyB64(cachedKey) ? { exists: true, actualSize: 10, liveness: "live" as const } : undefined;
    },
    coverBytes: true,
    latestLedger: 9,
  };
  const fetched: string[] = [];
  const rpc = fakeRpc({
    kp,
    simData: emptyData([], []),
    onGet: (keys) => {
      const accKey = accountLedgerKey(kp.publicKey()).toXDR("base64");
      if (keys.length === 1 && keyB64(keys[0]) === accKey) return;
      for (const k of keys) fetched.push(keyB64(k));
    },
  });
  const flat = await prepareInvocation(
    rpc,
    reqFor(kp, placeIntent(quoted, padEnd), { policy: { cover: "flat" } }),
  );
  expect(flat.kind).toBe("prepared");
  if (flat.kind !== "prepared") return;
  expect(flat.declared.wb).toBe(50 + flatWriteBytesPer() * flat.declared.rw);
  expect(flatWriteBytesPer()).toBe(WRITE_BYTES_PER);

  fetched.length = 0;
  const sized = await prepareInvocation(
    rpc,
    reqFor(kp, placeIntent(quoted, padEnd), { policy: { sweep: cached } }),
  );
  expect(sized.kind).toBe("prepared");
  expect(fetched).not.toContain(keyB64(cachedKey));
  expect(fetched.length).toBeGreaterThan(0);
});
