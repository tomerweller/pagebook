import { expect, test } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { classifyFailedTx } from "./diagnose";
import { errorMessageByName, errorTitleByName } from "./errors";

const PAGEBOOK = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO";
const SAC = "CB64D3G7SM2RTH6JSGG34DDTFTQ5CFDKVDZJZSODMCX4NJ2HV2KN7OHT";

function contractErrorEvent(code: number, raisedBy?: string): string {
  const errVal = StellarSdk.xdr.ScVal.scvError(StellarSdk.xdr.ScError.sceContract(code));
  const v0 = new StellarSdk.xdr.ContractEventV0({
    topics: [StellarSdk.xdr.ScVal.scvSymbol("error"), errVal],
    data: errVal,
  });
  return new StellarSdk.xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new StellarSdk.xdr.ContractEvent({
      ext: new StellarSdk.xdr.ExtensionPoint(0),
      contractId: raisedBy ? StellarSdk.StrKey.decodeContract(raisedBy) : null,
      type: StellarSdk.xdr.ContractEventType.diagnostic(),
      body: new StellarSdk.xdr.ContractEventBody(0, v0),
    }),
  }).toXDR("base64");
}

test("classifyFailedTx decodes a foreign raisedBy through the SAC table", () => {
  const got = classifyFailedTx(undefined, [contractErrorEvent(10, SAC)], undefined, "apply", PAGEBOOK);
  expect(got).toMatchObject({
    kind: "typed",
    errorCode: 10,
    errorName: "BalanceError",
    foreign: true,
    raisedBy: SAC,
  });
});

test("classifyFailedTx uses the PageBook table when raisedBy is the invoked contract", () => {
  const got = classifyFailedTx(undefined, [contractErrorEvent(10, PAGEBOOK)], undefined, "apply", PAGEBOOK);
  expect(got).toMatchObject({
    kind: "typed",
    errorCode: 10,
    errorName: "Unfilled",
    foreign: false,
    raisedBy: PAGEBOOK,
  });
});

test("a SAC error name reads as a sentence instead of an enum", () => {
  expect(errorMessageByName("BalanceError")).toBe("not enough token balance for this order");
  expect(errorTitleByName("BalanceError")).toBe("Token contract error (BalanceError)");
  expect(errorMessageByName("TrustlineMissingError")).toBe("no trustline for that token");
  // PageBook's own table still wins on a name it owns.
  expect(errorMessageByName("Crossed")).toBe("crossed the book: a post-only order would have taken");
  expect(errorTitleByName("Crossed")).toBe("Error 9 (Crossed)");
  // Anything unmapped falls through unchanged rather than inventing a message.
  expect(errorMessageByName("WhoKnows")).toBe("WhoKnows");
});
