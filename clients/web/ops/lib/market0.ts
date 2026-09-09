// Retired with the CDX3…U2RO deployment (ADR-036): the PBA/PBB scratch market
// existed only on that contract, which is no longer kept alive. These constants
// remain as provenance for ADR-027/028 (stress and decomposition runs). Create a
// scratch market on the live contract and repoint them before running
// `ops:stress` or the scratch compose overlay again.
// Flip to false after repointing the constants below at a live scratch market.
export const MARKET0_RETIRED = true;
export const MARKET0_CONTRACT = "CDX3WVFY6GV53J3XT53MNPE5HVKAGTCH74W3AWGMI43KUFK5TSXOU2RO";
export const MARKET0_ID = 0;
export const MARKET0_BASE_SAC = "CDAHSKHBGFENTV3XGWRWVIWE3ISAEYIZQNGD4GCWRDDIOIW4DVZ26FQG";
export const MARKET0_QUOTE_SAC = "CBEC6J5RWWWC7CYCHJTXIBDFTFRK6GTMLK4E47BECO5BDXVM7YHATUIK";
export const MARKET0_ISSUER = "GCBMNFRU74KLBUCVHJVQXRRMGEWUWC2WZ5KXLYABNFLXGCFTJPKBT4IB";
export const MARKET0_CODES = ["PBA", "PBB"] as const;
export const MARKET0_NONCE_BASE = 777_000_000;