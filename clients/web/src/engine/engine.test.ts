import { expect, test } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { ck, instanceKey } from "../keys";
import padConformance from "../../../../crates/pagebook-client/fixtures/pad-conformance.json";
import { ERROR_CODE_COUNT, ERROR_MESSAGES, ERROR_NAMES, hostErrorMessage, parseContractError } from "./errors";
import { keysForReplace, keysForSettle, pad, restoreMarks, windowJson, type Quoted } from "./pad";
import { outcomeOf } from "../../ops/lib/outcomes";
import { classifyFailedTx, classifySubmit, decodePlaceResult } from "./submit";
import { scValKeyName, sortedKeyStrs, type ClientKey } from "./clientKeys";
import { DEFAULT_GROWTH, PER_ADDED, WRITE_ENTRY_FEE, applyPad, type ApplyPadSizes } from "./txdata";

const T1 = "01".repeat(32);
const T2 = "02".repeat(32);
const T3 = "03".repeat(32);

function fixtureQuoted(): Quoted {
  return {
    market: 0,
    ownSide: true,
    limitTick: 20,
    startTick: 10,
    crossed: [
      { tick: 10, headSeq: 3, openLots: 5n },
      { tick: 11, headSeq: 0, openLots: 2n },
      { tick: 12, headSeq: 70, openLots: 1n },
    ],
    tailSeq: 0,
    taker: T1,
    nonce: 7n,
    base: T2,
    quote: T3,
  };
}

const PLACE_3CROSS = [
  "BestTick(0,false)",
  "BestTick(0,true)",
  "Config",
  "FeeAccrual(0,0202020202020202020202020202020202020202020202020202020202020202)",
  "FeeAccrual(0,0303030303030303030303030303030303030303030303030303030303030303)",
  "Level(0,false,10)",
  "Level(0,false,11)",
  "Level(0,false,12)",
  "Level(0,true,20)",
  "LevelPage(0,false,10,0)",
  "LevelPage(0,false,10,1)",
  "LevelPage(0,false,11,0)",
  "LevelPage(0,false,11,1)",
  "LevelPage(0,false,12,0)",
  "LevelPage(0,false,12,1)",
  "LevelPage(0,false,12,2)",
  "LevelPage(0,true,20,0)",
  "LevelPage(0,true,20,1)",
  "Market(0)",
  "Order(0,0101010101010101010101010101010101010101010101010101010101010101,7)",
  "TickSummary(0,false)",
  "TickSummary(0,true)",
  "TickWord(0,false,0)",
  "TickWord(0,true,0)",
  "UserBalance(0202020202020202020202020202020202020202020202020202020202020202)",
  "UserBalance(0303030303030303030303030303030303030303030303030303030303030303)",
  "VaultBalance(0202020202020202020202020202020202020202020202020202020202020202)",
  "VaultBalance(0303030303030303030303030303030303030303030303030303030303030303)",
];

const SETTLE = [
  "Level(0,true,20)",
  "LevelPage(0,true,20,0)",
  "Market(0)",
  "Order(0,0101010101010101010101010101010101010101010101010101010101010101,7)",
  "UserBalance(0202020202020202020202020202020202020202020202020202020202020202)",
  "UserBalance(0303030303030303030303030303030303030303030303030303030303030303)",
  "VaultBalance(0202020202020202020202020202020202020202020202020202020202020202)",
  "VaultBalance(0303030303030303030303030303030303030303030303030303030303030303)",
];

const REPLACE_CROSS_SIDE = [
  "BestTick(0,false)",
  "BestTick(0,true)",
  "Config",
  "Level(0,false,22)",
  "Level(0,true,20)",
  "LevelPage(0,false,22,0)",
  "LevelPage(0,false,22,1)",
  "LevelPage(0,true,20,0)",
  "Market(0)",
  "Order(0,0101010101010101010101010101010101010101010101010101010101010101,7)",
  "TickSummary(0,false)",
  "TickWord(0,false,0)",
  "UserBalance(0202020202020202020202020202020202020202020202020202020202020202)",
  "UserBalance(0303030303030303030303030303030303030303030303030303030303030303)",
  "VaultBalance(0202020202020202020202020202020202020202020202020202020202020202)",
  "VaultBalance(0303030303030303030303030303030303030303030303030303030303030303)",
];

test("pad fixture matches rust js_fixtures", () => {
  const q = fixtureQuoted();
  const out = pad(q, 12);
  expect(sortedKeyStrs(out.keys)).toEqual(PLACE_3CROSS);
  expect(out.window.consume).toEqual([
    { tick: 10, pages: { first: 0, last: 1 } },
    { tick: 11, pages: { first: 0, last: 1 } },
    { tick: 12, pages: { first: 1, last: 2 } },
  ]);
  expect(out.window.append).toEqual({ first: 0, last: 1 });
});

test("settle fixture matches rust js_fixtures", () => {
  expect(sortedKeyStrs(keysForSettle(0, T1, 7n, true, 20, 5, T2, T3))).toEqual(SETTLE);
});

test("replace fixture matches rust js_fixtures", () => {
  const { keys, append } = keysForReplace(0, T1, 7n, true, 20, 5, false, 22, 0, T2, T3);
  expect(sortedKeyStrs(keys)).toEqual(REPLACE_CROSS_SIDE);
  expect(append).toEqual({ first: 0, last: 1 });
});

test("restore_marks fixture matches rust js_fixtures", () => {
  const q = fixtureQuoted();
  const out = pad(q, 12);
  const archived = [
    { t: "Level" as const, market: 0, isBid: false, tick: 10 },
    { t: "Level" as const, market: 0, isBid: false, tick: 11 },
    { t: "Level" as const, market: 0, isBid: false, tick: 99 },
    { t: "Level" as const, market: 0, isBid: true, tick: 20 },
  ];
  expect(sortedKeyStrs(restoreMarks(q, out, archived))).toEqual([
    "Level(0,false,10)",
    "Level(0,false,11)",
    "Level(0,true,20)",
  ]);
});

type FixtureCase = {
  name: string;
  quoted: {
    market: number;
    is_bid: boolean;
    limit_tick: number;
    start_tick: number;
    qty: number;
    crossed: { tick: number; head_seq: number; open_lots: number }[];
    tail_seq: number;
    filled_lots: number;
  };
  options: { pad_end: number; pages_for_empty: boolean };
  settle?: { is_bid: boolean; tick: number; seq: number };
  replace?: {
    old_is_bid: boolean;
    old_tick: number;
    old_seq: number;
    new_is_bid: boolean;
    new_tick: number;
    new_tail_seq: number;
  };
  archived?: string[];
  expected: {
    keys: string[];
    window: { consume: { tick: number; pages: { first: number; last: number } }[]; append: { first: number; last: number } };
    keys_for_settle?: string[];
    keys_for_replace?: string[];
    restore_marks?: string[];
  };
};

type FixtureFile = {
  taker: string;
  nonce: number;
  base: string;
  quote: string;
  cases: FixtureCase[];
};

function loadPadFixture(): FixtureFile {
  return padConformance as FixtureFile;
}

function parseKey(s: string): ClientKey {
  if (s === "Config") return { t: "Config" };
  const open = s.indexOf("(");
  const name = s.slice(0, open);
  const inner = s.slice(open + 1, -1);
  const parts = inner.split(",");
  const n = (i: number) => Number(parts[i]);
  const b = (i: number) => parts[i] === "true";
  switch (name) {
    case "Market":
      return { t: "Market", market: n(0) };
    case "Level":
      return { t: "Level", market: n(0), isBid: b(1), tick: n(2) };
    case "LevelPage":
      return { t: "LevelPage", market: n(0), isBid: b(1), tick: n(2), page: n(3) };
    case "Order":
      return { t: "Order", market: n(0), owner: parts[1], nonce: BigInt(parts[2]) };
    case "FeeAccrual":
      return { t: "FeeAccrual", market: n(0), token: parts[1] };
    case "BestTick":
      return { t: "BestTick", market: n(0), isBid: b(1) };
    case "TickSummary":
      return { t: "TickSummary", market: n(0), isBid: b(1) };
    case "TickWord":
      return { t: "TickWord", market: n(0), isBid: b(1), word: n(2) };
    case "VaultBalance":
      return { t: "VaultBalance", token: parts[0] };
    case "UserBalance":
      return { t: "UserBalance", token: parts[0] };
    default:
      throw new Error(`unknown key ${s}`);
  }
}

function quotedFrom(fx: FixtureFile, c: FixtureCase): Quoted {
  return {
    market: c.quoted.market,
    ownSide: c.quoted.is_bid,
    limitTick: c.quoted.limit_tick,
    startTick: c.quoted.start_tick,
    crossed: c.quoted.crossed.map((x) => ({
      tick: x.tick,
      headSeq: x.head_seq,
      openLots: BigInt(x.open_lots),
    })),
    tailSeq: c.quoted.tail_seq,
    taker: fx.taker,
    nonce: BigInt(fx.nonce),
    base: fx.base,
    quote: fx.quote,
  };
}

test("pad conformance matches the shared rust fixture", () => {
  const fx = loadPadFixture();
  expect(fx.cases.map((c) => c.name)).toEqual([
    "multi_cross",
    "page_boundaries",
    "empty_pages_true",
    "empty_pages_false",
    "mixed_empty_skip",
    "word_boundary",
    "wide_band",
    "ask_side",
    "start_eq_pad_end",
  ]);
  for (const c of fx.cases) {
    const q = quotedFrom(fx, c);
    const out = pad(q, c.options.pad_end, { pagesForEmpty: c.options.pages_for_empty });
    expect(sortedKeyStrs(out.keys), c.name).toEqual(c.expected.keys);
    expect(out.window, c.name).toEqual(c.expected.window);
    expect(windowJson(q), c.name).toBe(JSON.stringify(c.expected.window));
    if (c.settle && c.expected.keys_for_settle) {
      expect(
        sortedKeyStrs(keysForSettle(c.quoted.market, fx.taker, BigInt(fx.nonce), c.settle.is_bid, c.settle.tick, c.settle.seq, fx.base, fx.quote)),
        `${c.name} settle`,
      ).toEqual(c.expected.keys_for_settle);
    }
    if (c.replace && c.expected.keys_for_replace) {
      const { keys } = keysForReplace(
        c.quoted.market,
        fx.taker,
        BigInt(fx.nonce),
        c.replace.old_is_bid,
        c.replace.old_tick,
        c.replace.old_seq,
        c.replace.new_is_bid,
        c.replace.new_tick,
        c.replace.new_tail_seq,
        fx.base,
        fx.quote,
      );
      expect(sortedKeyStrs(keys), `${c.name} replace`).toEqual(c.expected.keys_for_replace);
    }
    if (c.archived && c.expected.restore_marks) {
      expect(sortedKeyStrs(restoreMarks(q, out, c.archived.map(parseKey))), `${c.name} restore`).toEqual(c.expected.restore_marks);
    }
  }
});

test("window_json matches soak window_json", () => {
  const q = fixtureQuoted();
  expect(windowJson(q)).toBe(
    JSON.stringify({
      consume: [
        { tick: 10, pages: { first: 0, last: 1 } },
        { tick: 11, pages: { first: 0, last: 1 } },
        { tick: 12, pages: { first: 1, last: 2 } },
      ],
      append: { first: 0, last: 1 },
    }),
  );
});

test("error-code map matches errors.rs", () => {
  expect(Object.keys(ERROR_NAMES).length).toBe(ERROR_CODE_COUNT);
  expect(Object.keys(ERROR_MESSAGES).length).toBe(ERROR_CODE_COUNT);
  for (let c = 1; c <= ERROR_CODE_COUNT; c++) {
    expect(ERROR_NAMES[c]).toBeTruthy();
    expect(ERROR_MESSAGES[c]).toBeTruthy();
    expect(ERROR_MESSAGES[c]).not.toBe(ERROR_NAMES[c]);
  }
  expect(ERROR_NAMES[9]).toBe("Crossed");
  expect(ERROR_MESSAGES[11]).toMatch(/queue is full/i);
});

test("SAC trustline miss is not PageBook OrderExists", () => {
  const text = `HostError: Error(Contract, #13)
    [Failed Diagnostic Event] contract:CBIELT, topics:[error, Error(Contract, #13)], data:["trustline entry is missing for account", GD3Q]`;
  expect(hostErrorMessage(text)).toMatch(/trustline is missing/);
  expect(parseContractError(text)).toBeNull();
  expect(parseContractError("HostError: Error(Contract, #13)")).toBe(13);
});

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

test("applyPad unions, promotes, and floors fee per added RW key", () => {
  const contract = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO";
  const a = ck(contract, "Level", 0, false, 10).xdr;
  const b = ck(contract, "Level", 0, false, 11).xdr;
  const c = instanceKey(contract).xdr;
  const data = emptyData([a], [c]);
  const { data: out, added, resourceFee } = applyPad(data, [a, b], [0]);
  expect(added).toBe(2);
  const builder = new StellarSdk.SorobanDataBuilder(out);
  const ro = builder.getReadOnly().map((k) => k.toXDR("base64"));
  const rw = builder.getReadWrite().map((k) => k.toXDR("base64"));
  expect(ro).not.toContain(a.toXDR("base64"));
  expect(rw).toContain(a.toXDR("base64"));
  expect(rw).toContain(b.toXDR("base64"));
  expect(rw).toContain(c.toXDR("base64"));
  const bump = resourceFee - (10_000n * 13n) / 10n;
  expect(bump).toBeGreaterThanOrEqual(BigInt(WRITE_ENTRY_FEE * added));
  expect(Number(out.resources().writeBytes())).toBe(50 + 600 * added);
  // Instruction headroom must match tools/soak apply_pad (ADR-026 hardening):
  // 1.25x simulated + 120k per added key + 3M flat.
  expect(Number(out.resources().instructions())).toBe(Math.floor(1_000_000 * 1.25) + 120_000 * added + 3_000_000);
  expect(PER_ADDED).toBeGreaterThanOrEqual(WRITE_ENTRY_FEE);
  expect(out.ext().switch()).toBe(1);
});

function sizesOf(map: Map<string, { exists: boolean; actualSize: number }>, growth?: number, slack?: number): ApplyPadSizes {
  return {
    sizeOf(key) {
      return map.get(key.toXDR("base64"));
    },
    growth,
    slack,
  };
}

test("applyPad sizes covers an existing key at actual+growth", () => {
  const contract = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO";
  const a = ck(contract, "Level", 0, false, 10).xdr;
  const data = emptyData([], []);
  const map = new Map([[a.toXDR("base64"), { exists: true, actualSize: 404 }]]);
  const { data: out, added } = applyPad(data, [a], [], sizesOf(map));
  expect(added).toBe(1);
  expect(Number(out.resources().writeBytes())).toBe(50 + 404 + DEFAULT_GROWTH);
  expect(Number(out.resources().instructions())).toBe(Math.floor(1_000_000 * 1.25) + 120_000 * added + 3_000_000);
});

test("applyPad sizes covers a nonexistent key at zero", () => {
  const contract = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO";
  const a = ck(contract, "Level", 0, false, 10).xdr;
  const data = emptyData([], []);
  const map = new Map([[a.toXDR("base64"), { exists: false, actualSize: 404 }]]);
  const { data: out } = applyPad(data, [a], [], sizesOf(map, 16, 0));
  expect(Number(out.resources().writeBytes())).toBe(50);
});

function contractErrorEvent(code: number): string {
  const errVal = StellarSdk.xdr.ScVal.scvError(StellarSdk.xdr.ScError.sceContract(code));
  const v0 = new StellarSdk.xdr.ContractEventV0({
    topics: [StellarSdk.xdr.ScVal.scvSymbol("error"), errVal],
    data: errVal,
  });
  return new StellarSdk.xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new StellarSdk.xdr.ContractEvent({
      ext: new StellarSdk.xdr.ExtensionPoint(0),
      contractId: null,
      type: StellarSdk.xdr.ContractEventType.diagnostic(),
      body: new StellarSdk.xdr.ContractEventBody(0, v0),
    }),
  }).toXDR("base64");
}

function archivedEntryEvent(contract: string, key: StellarSdk.xdr.ScVal): string {
  const errVal = StellarSdk.xdr.ScVal.scvError(StellarSdk.xdr.ScError.sceValue(StellarSdk.xdr.ScErrorCode.scecInvalidInput()));
  const v0 = new StellarSdk.xdr.ContractEventV0({
    topics: [StellarSdk.xdr.ScVal.scvSymbol("error"), errVal],
    data: StellarSdk.xdr.ScVal.scvVec([
      StellarSdk.xdr.ScVal.scvString("trying to access an archived contract data entry"),
      new StellarSdk.Address(contract).toScVal(),
      key,
    ]),
  });
  return new StellarSdk.xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new StellarSdk.xdr.ContractEvent({
      ext: new StellarSdk.xdr.ExtensionPoint(0),
      contractId: null,
      type: StellarSdk.xdr.ContractEventType.diagnostic(),
      body: new StellarSdk.xdr.ContractEventBody(0, v0),
    }),
  }).toXDR("base64");
}

function storageLimitEvent(): string {
  const errVal = StellarSdk.xdr.ScVal.scvError(
    StellarSdk.xdr.ScError.sceStorage(StellarSdk.xdr.ScErrorCode.scecExceededLimit()),
  );
  const v0 = new StellarSdk.xdr.ContractEventV0({
    topics: [StellarSdk.xdr.ScVal.scvSymbol("error"), errVal],
    data: StellarSdk.xdr.ScVal.scvString("trying to access contract data key outside of the footprint"),
  });
  return new StellarSdk.xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new StellarSdk.xdr.ContractEvent({
      ext: new StellarSdk.xdr.ExtensionPoint(0),
      contractId: null,
      type: StellarSdk.xdr.ContractEventType.diagnostic(),
      body: new StellarSdk.xdr.ContractEventBody(0, v0),
    }),
  }).toXDR("base64");
}

function failedTx(code: "trapped" | "resource"): string {
  const ihf =
    code === "resource"
      ? StellarSdk.xdr.InvokeHostFunctionResult.invokeHostFunctionResourceLimitExceeded()
      : StellarSdk.xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped();
  return new StellarSdk.xdr.TransactionResult({
    feeCharged: new StellarSdk.xdr.Int64(100),
    result: StellarSdk.xdr.TransactionResultResult.txFailed([
      StellarSdk.xdr.OperationResult.opInner(StellarSdk.xdr.OperationResultTr.invokeHostFunction(ihf)),
    ]),
    ext: new StellarSdk.xdr.TransactionResultExt(0),
  }).toXDR("base64");
}

test("classifyFailedTx decodes real XDR fixtures", () => {
  expect(classifyFailedTx(failedTx("trapped"), [contractErrorEvent(15)])).toMatchObject({
    kind: "typed",
    errorCode: 15,
    errorName: "UnknownOrder",
    at: "apply",
  });
  expect(classifyFailedTx(failedTx("trapped"), [storageLimitEvent()])).toMatchObject({
    kind: "footprint",
    at: "apply",
  });
  expect(classifyFailedTx(failedTx("resource"), [])).toMatchObject({
    kind: "resourceLimit",
    at: "apply",
  });
  expect(classifyFailedTx(failedTx("trapped"), [])).toMatchObject({
    kind: "trapped",
    at: "apply",
  });
  expect(outcomeOf(classifyFailedTx(failedTx("trapped"), [contractErrorEvent(15)]))).toBe("typed:UnknownOrder");
  expect(outcomeOf(classifyFailedTx(failedTx("trapped"), [storageLimitEvent()]))).toBe("footprint");
  expect(outcomeOf(classifyFailedTx(failedTx("trapped"), []))).toBe("trapped:unknown");
});

test("classifyFailedTx names an archived TickSummary from the diagnostic data vec", () => {
  const contract = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO";
  const key = StellarSdk.xdr.ScVal.scvVec([
    StellarSdk.xdr.ScVal.scvSymbol("TickSummary"),
    StellarSdk.xdr.ScVal.scvU32(1),
    StellarSdk.xdr.ScVal.scvBool(false),
  ]);
  expect(scValKeyName(key)).toBe("TickSummary(1,false)");
  const ev = archivedEntryEvent(contract, key);
  const got = classifyFailedTx(failedTx("trapped"), [ev]);
  expect(got).toMatchObject({
    kind: "archived",
    keyName: "TickSummary(1,false)",
    at: "apply",
  });
  expect(got.kind === "archived" && got.keyXdr).toBe(key.toXDR("base64"));
  expect(outcomeOf(got)).toBe("archived:TickSummary(1,false)");
  expect(classifyFailedTx(undefined, [ev], undefined, "simulation")).toMatchObject({
    kind: "archived",
    keyName: "TickSummary(1,false)",
    at: "simulation",
  });
  expect(outcomeOf(classifyFailedTx(undefined, [ev], undefined, "simulation"))).toBe("sim:archived:TickSummary(1,false)");
});

test("classifySubmit treats the archived-entry diagnostic string as archived", () => {
  expect(classifySubmit("invalid_input: trying to access an archived contract data entry", "apply")).toMatchObject({
    kind: "archived",
    keyName: "unknown",
    at: "apply",
  });
  expect(classifySubmit("HostError: EntryArchived", "simulation")).toMatchObject({
    kind: "archived",
    at: "simulation",
  });
  expect(outcomeOf(classifySubmit("trying to access an archived contract data entry", "apply"))).toBe("archived:unknown");
});

test("classifySubmit splits send and apply failures", () => {
  expect(classifySubmit("txBadSeq from horizon", "send").kind).toBe("txBadSeq");
  expect(classifySubmit("txBadSeq from horizon", "send")).toMatchObject({ reachedLedger: false });
  expect(classifySubmit("txBAD_SEQ after inclusion", "apply")).toMatchObject({ kind: "txBadSeq", reachedLedger: true });
  expect(classifySubmit("InvokeHostFunction(ResourceLimitExceeded)", "apply").kind).toBe("resourceLimit");
  expect(classifySubmit("status: TxSorobanInvalid", "send").kind).toBe("sorobanInvalid");
  expect(classifySubmit("trying to access contract data key outside of the footprint", "apply").kind).toBe("footprint");
  expect(classifySubmit("trying to access contract data key outside of the footprint", "simulation")).toMatchObject({
    kind: "footprint",
    at: "simulation",
  });
  expect(classifySubmit("InvokeHostFunction(ResourceLimitExceeded)", "simulation")).toMatchObject({
    kind: "resourceLimit",
    at: "simulation",
  });
  expect(classifySubmit("status: TxSorobanInvalid", "simulation")).toMatchObject({
    kind: "sorobanInvalid",
    at: "simulation",
  });
  expect(classifySubmit("connection reset", "simulation")).toMatchObject({ kind: "rpc", at: "simulation" });
});

test("decodePlaceResult reads the place 3-tuple from TransactionMeta", () => {
  const ret = StellarSdk.xdr.ScVal.scvVec([
    StellarSdk.xdr.ScVal.scvBool(true),
    StellarSdk.nativeToScVal(5n, { type: "u64" }),
    StellarSdk.nativeToScVal(1234n, { type: "i128" }),
  ]);
  const sm = new StellarSdk.xdr.SorobanTransactionMeta({
    ext: new StellarSdk.xdr.SorobanTransactionMetaExt(0),
    events: [],
    returnValue: ret,
    diagnosticEvents: [],
  });
  const v3 = new StellarSdk.xdr.TransactionMetaV3({
    ext: new StellarSdk.xdr.ExtensionPoint(0),
    txChangesBefore: [],
    operations: [],
    txChangesAfter: [],
    sorobanMeta: sm,
  });
  const meta = new StellarSdk.xdr.TransactionMeta(3, v3);
  expect(decodePlaceResult(meta.toXDR("base64"))).toEqual({
    rested: true,
    filledLots: 5n,
    quoteAtoms: 1234n,
  });
});

test("applyPad sizes mixed set plus slack pooled once", () => {
  const contract = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO";
  const a = ck(contract, "Level", 0, false, 10).xdr;
  const b = ck(contract, "Level", 0, false, 11).xdr;
  const c = ck(contract, "Level", 0, false, 12).xdr;
  const data = emptyData([], []);
  const map = new Map([
    [a.toXDR("base64"), { exists: true, actualSize: 404 }],
    [b.toXDR("base64"), { exists: false, actualSize: 999 }],
  ]);
  const { data: out, added } = applyPad(data, [a, b, c], [], sizesOf(map, 16, 50));
  expect(added).toBe(3);
  expect(Number(out.resources().writeBytes())).toBe(50 + 404 + 16 + 50);
  expect(Number(out.resources().instructions())).toBe(Math.floor(1_000_000 * 1.25) + 120_000 * 3 + 3_000_000);
});
