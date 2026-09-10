# 043: Shared client layer

Date: 2026-09-10. `clients/web/src/client/` holds the code browser controllers
and operational loops share: JSON-RPC transport, ledger-entry decoding,
network constants, classic account reads, and contract value codecs.
`src/engine/` depends on `client/`, `keys.ts`, and `decode.ts`. It does not
import `book.ts`, `wallet/`, `view/`, `demo/`, or `ops/`. `book.ts` is the
browser book model (snapshot types, depth walk, market listing, event
polling). Bots import `createRpc` and codecs from `src/client/` and
pad/prepare/submit from `src/engine/`. The layer stays in the web package.
A published SDK is out of scope (ADR-031).

## Ledger entries and quote results

The JSON-RPC transport yields ledger entries as `{ key, xdr,
liveUntilLedgerSeq? }`, with `xdr` a base64 `LedgerEntryData`.
`client/entries.ts` decodes that shape. Anything else throws `RpcShapeError`
naming the entry key. Callers that only need presence or
`liveUntilLedgerSeq` do not decode. `parseQuoteResult` reads the contract's
snake_case field names (`start_tick`, `crossed`, `filled_lots`,
`quote_atoms`) and throws `Error("malformed QuoteResult: missing <field>")`
when a field is absent. Malformed protocol data is an error, not a zero.

## Diagnostics

Submit-failure decoding lives in `engine/diagnose.ts` and does not take an
`Rpc`. `classifyFailedTx` still takes `invokedContract` and attributes a
foreign raiser through the SAC table (ADR-034). Orchestration and argument
building stay in `submit.ts` and `op.ts`.
