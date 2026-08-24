import { expect, test } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { ck, instanceKey } from "../keys";
import { ERROR_CODE_COUNT, ERROR_MESSAGES, ERROR_NAMES, hostErrorMessage, parseContractError } from "./errors";
import { keysForReplace, keysForSettle, pad, restoreMarks, windowJson, type Quoted } from "./pad";
import { sortedKeyStrs } from "./clientKeys";
import { PER_ADDED, WRITE_ENTRY_FEE, applyPad } from "./txdata";

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
