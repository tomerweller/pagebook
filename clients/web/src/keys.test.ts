import { expect, test } from "vitest";
import { ck, orderKey, instanceKey, sacBalanceKey } from "./keys";

const CONTRACT = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO";
const OWNER = "GAV6TNH2DIK4MDH2RZRXH6N2KF24VT4WIZNRQJYZKJSIEGGG2RCQV3QT";
const SAC = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";
const HOLDER = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO";

test("ck BestTick matches dashboard keys.mjs", () => {
  expect(ck(CONTRACT, "BestTick", 0, true).base64).toBe(
    "AAAABgAAAAHvu1S48avdp3efdsa8nT1UA0xH/y2wWMxHNqoVXZyu6gAAABAAAAABAAAAAwAAAA8AAAAIQmVzdFRpY2sAAAADAAAAAAAAAAAAAAABAAAAAQ==",
  );
});

test("ck Market matches dashboard keys.mjs", () => {
  expect(ck(CONTRACT, "Market", 0).base64).toBe(
    "AAAABgAAAAHvu1S48avdp3efdsa8nT1UA0xH/y2wWMxHNqoVXZyu6gAAABAAAAABAAAAAgAAAA8AAAAGTWFya2V0AAAAAAADAAAAAAAAAAE=",
  );
});

test("ck TickWord matches dashboard keys.mjs", () => {
  expect(ck(CONTRACT, "TickWord", 0, false, 5).base64).toBe(
    "AAAABgAAAAHvu1S48avdp3efdsa8nT1UA0xH/y2wWMxHNqoVXZyu6gAAABAAAAABAAAABAAAAA8AAAAIVGlja1dvcmQAAAADAAAAAAAAAAAAAAAAAAAAAwAAAAUAAAAB",
  );
});

test("ck FeeAccrual matches dashboard keys.mjs", () => {
  expect(ck(CONTRACT, "FeeAccrual", 0, SAC).base64).toBe(
    "AAAABgAAAAHvu1S48avdp3efdsa8nT1UA0xH/y2wWMxHNqoVXZyu6gAAABAAAAABAAAAAwAAAA8AAAAKRmVlQWNjcnVhbAAAAAAAAwAAAAAAAAASAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAQ==",
  );
});

test("orderKey matches dashboard keys.mjs", () => {
  expect(orderKey(CONTRACT, 0, OWNER, 17n).base64).toBe(
    "AAAABgAAAAHvu1S48avdp3efdsa8nT1UA0xH/y2wWMxHNqoVXZyu6gAAABAAAAABAAAABAAAAA8AAAAFT3JkZXIAAAAAAAADAAAAAAAAABIAAAAAAAAAACvptPoaFcYM+o5jc/m6UXXKz5ZGWxgnGVJkghjG1EUKAAAABQAAAAAAAAARAAAAAQ==",
  );
});

test("instanceKey matches dashboard keys.mjs", () => {
  expect(instanceKey(CONTRACT).base64).toBe("AAAABgAAAAHvu1S48avdp3efdsa8nT1UA0xH/y2wWMxHNqoVXZyu6gAAABQAAAAB");
});

test("sacBalanceKey matches dashboard keys.mjs", () => {
  expect(sacBalanceKey(SAC, HOLDER).base64).toBe(
    "AAAABgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAABAAAAABAAAAAgAAAA8AAAAHQmFsYW5jZQAAAAASAAAAAe+7VLjxq92nd592xrydPVQDTEf/LbBYzEc2qhVdnK7qAAAAAQ==",
  );
});
