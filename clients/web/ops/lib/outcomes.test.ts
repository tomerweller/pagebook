import { expect, test } from "vitest";
import { classifyText, diagnoseEvents, ERR_NAMES, outcomeOf } from "./outcomes";

test("ERR_NAMES matches the soak table", () => {
  expect(ERR_NAMES[9]).toBe("Crossed");
  expect(ERR_NAMES[11]).toBe("LevelFull");
  expect(ERR_NAMES[24]).toBe("SelfTrade");
  expect(Object.keys(ERR_NAMES).length).toBe(24);
});

test("outcomeOf maps engine result kinds", () => {
  expect(outcomeOf({ kind: "ok", hash: "aa" })).toBe("ok");
  expect(outcomeOf({ kind: "typed", errorCode: 11, errorName: "LevelFull", at: "apply" })).toBe("typed:LevelFull");
  expect(outcomeOf({ kind: "typed", errorCode: 11, errorName: "LevelFull", at: "simulation" })).toBe("sim:typed:LevelFull");
  expect(outcomeOf({ kind: "footprint" })).toBe("footprint");
  expect(outcomeOf({ kind: "footprint", at: "simulation" })).toBe("sim:footprint");
  expect(outcomeOf({ kind: "txBadSeq", message: "txBadSeq" })).toBe("bad_seq");
  expect(outcomeOf({ kind: "txBadSeq", message: "txBadSeq", at: "simulation" })).toBe("sim:bad_seq");
  expect(outcomeOf({ kind: "resourceLimit", message: "ResourceLimitExceeded" })).toBe("resource_limit");
  expect(outcomeOf({ kind: "resourceLimit", message: "ResourceLimitExceeded", at: "simulation" })).toBe("sim:resource_limit");
  expect(outcomeOf({ kind: "sorobanInvalid", message: "TxSorobanInvalid" })).toBe("soroban_invalid");
  expect(outcomeOf({ kind: "sorobanInvalid", message: "TxSorobanInvalid", at: "simulation" })).toBe("sim:soroban_invalid");
  expect(outcomeOf({ kind: "timeout", message: "timed out", hash: "ff" })).toBe("rpc_timeout");
  expect(outcomeOf({ kind: "build_error" })).toBe("build_error");
  expect(outcomeOf({ kind: "sign_error" })).toBe("sign_error");
  expect(outcomeOf({ kind: "rpc", message: "nope" })).toBe("other");
  expect(outcomeOf({ kind: "rpc", message: "nope", at: "simulation" })).toBe("sim:other");
  expect(outcomeOf({ kind: "trapped" })).toBe("trapped:unknown");
  expect(outcomeOf({ kind: "trapped", at: "simulation" })).toBe("sim:trapped:unknown");
  expect(outcomeOf({ kind: "archived", keyName: "TickSummary(1,false)", keyXdr: "aa", at: "apply" })).toBe(
    "archived:TickSummary(1,false)",
  );
  expect(outcomeOf({ kind: "archived", keyName: "TickSummary(1,false)", keyXdr: "aa", at: "simulation" })).toBe(
    "sim:archived:TickSummary(1,false)",
  );
  expect(outcomeOf({ kind: "typed", errorCode: 15, errorName: "UnknownOrder", at: "apply" })).toBe("typed:UnknownOrder");
});

test("classifyText matches canned RPC and SDK strings", () => {
  expect(classifyText('HostError: Error(Contract, #13)')).toBe("typed:OrderExists");
  expect(classifyText('{"error":{"contract":9}}')).toBe("typed:Crossed");
  expect(classifyText("trying to access contract data key outside of the footprint")).toBe("footprint");
  expect(classifyText("Error(Storage, ExceededLimit)")).toBe("footprint");
  expect(classifyText("status: TxSorobanInvalid")).toBe("soroban_invalid");
  expect(classifyText("txBadSeq")).toBe("bad_seq");
  expect(classifyText("TransactionResultCode.txBAD_SEQ")).toBe("bad_seq");
  expect(classifyText("InvokeHostFunction(ResourceLimitExceeded)")).toBe("resource_limit");
  expect(classifyText("submission timeout after 30s")).toBe("rpc_timeout");
  expect(classifyText("timed out waiting for transaction")).toBe("rpc_timeout");
  expect(classifyText("connection reset")).toBe("other");
  expect(classifyText("Error(Contract, #11)", { sim: true })).toBe("sim:typed:LevelFull");
  expect(classifyText("trying to access an archived contract data entry")).toBe("archived:unknown");
  expect(classifyText("HostError: EntryArchived", { sim: true })).toBe("sim:archived:unknown");
});

test("diagnoseEvents classifies a Trapped diagnostic JSON path", () => {
  const typed = {
    event: {
      type: "diagnostic",
      contract_event: {
        body: {
          v0: {
            topics: ["error"],
            data: { error: { contract: 12 } },
          },
        },
      },
    },
  };
  expect(diagnoseEvents(typed)).toBe("typed:RetryRest");
  expect(
    diagnoseEvents({
      failed: true,
      reason: "trying to access contract data key outside of the footprint",
    }),
  ).toBe("footprint");
  expect(
    diagnoseEvents({
      error: { storage: "exceeded_limit" },
    }),
  ).toBe("footprint");
  expect(diagnoseEvents({ note: "Trapped with no contract code" })).toBe("trapped:unknown");
  expect(diagnoseEvents({ reason: "trying to access an archived contract data entry" })).toBe("archived:unknown");
  expect(
    outcomeOf({ kind: "rpc", message: "Trapped", hash: "ab" }, { events: typed }),
  ).toBe("typed:RetryRest");
});
