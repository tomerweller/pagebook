import type { BookSnapshot, MarketInfo, Rpc } from "../book";
import { formatAtoms, formatInt, formatRatio } from "../decode";
import { accessOf } from "../engine/clientKeys";
import { allocNonce, pad } from "../engine/pad";
import { simulatePlace } from "../engine/quote";
import { submitPlace, type ClassicToken, type EngineResult, type PlaceFlags } from "../engine/submit";
import { createRequestGate, scopeOf } from "../request";
import { estimatePaddedFee } from "../engine/txdata";
import { errorMessageByName, errorName, errorTitleByName, parseContractError } from "../engine/errors";
import { countLabel, esc, txLink } from "../view/format";
import { tokenDecimals, tokenLabel, type UrlOverrides } from "../view/format";
import { parseAssetFromSacName, type AccountState, type TrustlineState } from "./account";
import { MarkupCache } from "../view/stable";
import type { Store } from "../store";
import type { AppState } from "../view/market";
import {
  lotsToQty,
  minLotLabel,
  oneLotQtyStep,
  oneTickPriceStep,
  parseDecimal,
  priceToTick,
  qtyToLots,
  stepLots,
  stepTick,
  tickToPrice,
  type Quant,
} from "./units";

export const FEE_BPS_DENOM = 10_000n;
export const XLM_FEE_HEADROOM = 2_000_000n;

export type RemainderKind = "rests" | "refunds" | "unfilled" | "crossed";

export function escrowQuoteAtoms(lots: bigint, tick: number, tickSize: bigint): bigint {
  return lots * BigInt(tick) * tickSize;
}

export function escrowBaseAtoms(lots: bigint, lotSize: bigint): bigint {
  return lots * lotSize;
}

export function takerFeeAtoms(output: bigint, feeBps: number): bigint {
  if (output <= 0n || feeBps <= 0) return 0n;
  const bps = BigInt(feeBps);
  const hi = (output / FEE_BPS_DENOM) * bps;
  const rem = (output % FEE_BPS_DENOM) * bps;
  const lo = rem === 0n ? 0n : (rem + FEE_BPS_DENOM - 1n) / FEE_BPS_DENOM;
  return hi + lo;
}

export function tickInBand(tick: number, tickMin: number, tickMax: number): boolean {
  return Number.isInteger(tick) && tick >= tickMin && tick < tickMax;
}

export function lotsInBounds(lots: bigint, minLots: bigint, maxLots: bigint): boolean {
  return lots >= minLots && lots <= maxLots;
}

export function remainderDisposition(filled: bigint, qty: bigint, flags: PlaceFlags): RemainderKind {
  if (flags.post_only && filled > 0n) return "crossed";
  const rem = qty - filled;
  if (rem <= 0n) return "refunds";
  if (flags.fill_or_kill) return "unfilled";
  if (flags.no_rest) return "refunds";
  return "rests";
}

export type TicketFields = {
  isBid: boolean;
  tick: number;
  lots: bigint;
  flags: PlaceFlags;
};

export type TicketBalances = {
  funded: boolean;
  xlmSpendable: bigint;
  baseAtoms: bigint;
  quoteAtoms: bigint | null;
  baseIsNative: boolean;
  quoteIsNative: boolean;
  quoteSymbol: string;
  baseSymbol: string;
  baseDec: number;
  quoteDec: number;
};

export type TicketCheck = { ok: true } | { ok: false; reason: string; title?: string };

export function validateTicket(fields: TicketFields, market: MarketInfo, bal: TicketBalances): TicketCheck {
  if (!bal.funded) return { ok: false, reason: "account not funded" };
  if (!tickInBand(fields.tick, market.tick_min, market.tick_max)) {
    return { ok: false, reason: `tick outside the band [${market.tick_min}, ${market.tick_max})` };
  }
  if (fields.lots < market.min_order_lots) {
    return { ok: false, reason: minLotLabel({ lotSize: market.lot_size, tickSize: market.tick_size, baseDec: bal.baseDec, quoteDec: bal.quoteDec, tickMin: market.tick_min, tickMax: market.tick_max, minLots: market.min_order_lots }, bal.baseSymbol) };
  }
  if (!lotsInBounds(fields.lots, market.min_order_lots, market.max_order_lots)) {
    return { ok: false, reason: `lots outside ${market.min_order_lots} / ${market.max_order_lots}` };
  }
  if (bal.xlmSpendable < XLM_FEE_HEADROOM) return { ok: false, reason: "need at least 0.2 XLM for the padded fee" };
  if (fields.isBid) {
    if (bal.quoteAtoms == null) return { ok: false, reason: `no ${bal.quoteSymbol} trustline` };
    const need = escrowQuoteAtoms(fields.lots, fields.tick, market.tick_size);
    if (bal.quoteAtoms < need) {
      const hint = bal.quoteAtoms === 0n ? ` · you hold ${bal.baseSymbol} only — try sell` : "";
      return {
        ok: false,
        reason: `need ${formatAtoms(need, bal.quoteDec)} ${bal.quoteSymbol} for this bid${hint}`,
        title: `${need.toString()} atoms`,
      };
    }
  } else {
    const need = escrowBaseAtoms(fields.lots, market.lot_size);
    const avail = bal.baseIsNative ? bal.xlmSpendable - XLM_FEE_HEADROOM : bal.baseAtoms;
    if (avail < need) {
      return {
        ok: false,
        reason: `need ${formatAtoms(need, bal.baseDec)} ${bal.baseSymbol} for this ask`,
        title: `${need.toString()} atoms`,
      };
    }
  }
  return { ok: true };
}

export function plainError(name: string): string {
  return errorMessageByName(name);
}

export function typedErrorHtml(name: string): string {
  return `<span title="${esc(errorTitleByName(name))}">${esc(errorMessageByName(name))}</span>`;
}

export type TicketHandle = {
  attach(root: HTMLElement): void;
  prefill(side: "bid" | "ask", tick: number): void;
  preview(): Promise<void>;
  submit(): Promise<void>;
};

export type TradeIntent = Readonly<{
  contract: string;
  market: number;
  taker: string;
  sequence: string;
  isBid: boolean;
  tick: number;
  lots: bigint;
  flags: Readonly<PlaceFlags>;
  base: string;
  quote: string;
  tokens: readonly ClassicToken[];
  levelCap: number | undefined;
  version: number;
}>;

export function buildTradeIntent(fields: {
  contract: string;
  market: number;
  taker: string;
  sequence: string;
  isBid: boolean;
  tick: number;
  lots: bigint;
  flags: PlaceFlags;
  base: string;
  quote: string;
  tokens: ClassicToken[];
  levelCap: number | undefined;
  version: number;
}): TradeIntent {
  return Object.freeze({
    contract: fields.contract,
    market: fields.market,
    taker: fields.taker,
    sequence: fields.sequence,
    isBid: fields.isBid,
    tick: fields.tick,
    lots: fields.lots,
    flags: Object.freeze({ ...fields.flags }),
    base: fields.base,
    quote: fields.quote,
    tokens: Object.freeze(fields.tokens.slice()),
    levelCap: fields.levelCap,
    version: fields.version,
  });
}

export type TicketEngine = {
  simulatePlace: typeof simulatePlace;
  allocNonce: typeof allocNonce;
  submitPlace: typeof submitPlace;
};

type PreviewOk = {
  kind: "ok";
  filledLots: bigint;
  quoteAtoms: bigint;
  feeAtoms: bigint;
  feeIsQuote: boolean;
  remainder: bigint;
  disposition: RemainderKind;
  crossed: number;
  padFee: bigint;
  avg: string;
};

export type PreviewState = PreviewOk | { kind: "typed"; name: string } | { kind: "err"; message: string } | { kind: "idle" } | { kind: "loading" };

export type SubmitPhase = "idle" | "simulating" | "signing" | "sending" | "confirmed" | "failed";

export type TicketDomain = {
  isBid: boolean;
  tick: number;
  lots: bigint;
  priceStr: string;
  qtyStr: string;
  priceSnapped: boolean;
  flags: PlaceFlags;
  preview: PreviewState;
  phase: SubmitPhase;
  phaseDetail: string;
  lastHash: string;
  lastNonce: bigint | null;
  focusQty: boolean;
  previewQuoteKey: string;
  submitting: boolean;
  sideLocked: boolean;
};

export function emptyTicketDomain(): TicketDomain {
  return {
    isBid: true,
    tick: 1,
    lots: 1n,
    priceStr: "",
    qtyStr: "",
    priceSnapped: false,
    flags: { post_only: false, fill_or_kill: false, no_rest: false },
    preview: { kind: "idle" },
    phase: "idle",
    phaseDetail: "",
    lastHash: "",
    lastNonce: null,
    focusQty: false,
    previewQuoteKey: "",
    submitting: false,
    sideLocked: false,
  };
}

export function quoteCanFundMinBid(bal: TicketBalances, market: MarketInfo, tick: number): boolean {
  if (bal.quoteAtoms == null) return false;
  return bal.quoteAtoms >= escrowQuoteAtoms(market.min_order_lots, tick, market.tick_size);
}

export function baseCanFundMinAsk(bal: TicketBalances, market: MarketInfo): boolean {
  const need = escrowBaseAtoms(market.min_order_lots, market.lot_size);
  const avail = bal.baseIsNative ? bal.xlmSpendable - XLM_FEE_HEADROOM : bal.baseAtoms;
  return avail >= need;
}

export function preferSellSide(bal: TicketBalances, market: MarketInfo, bidTick: number): boolean {
  return !quoteCanFundMinBid(bal, market, bidTick) && baseCanFundMinAsk(bal, market);
}

export function createTicket(opts: {
  store: Store<AppState>;
  rpc: Rpc;
  contract: string;
  getSecret: () => string | null;
  getPublic: () => string | null;
  onRefresh: () => void;
  onRested: (nonce: bigint, intent: TradeIntent) => void;
  onLog: (text: string, hash?: string, taker?: string) => void;
  engine?: TicketEngine;
}): TicketHandle {
  const app = opts.store;
  const engine = opts.engine ?? { simulatePlace, allocNonce, submitPlace };
  const previewGate = createRequestGate<TicketFields>();
  let submitVersion = 0;
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let rootEl: HTMLElement | null = null;
  let bound = false;
  const cache = new MarkupCache();

  function snap(): BookSnapshot | null {
    return app.read().book.snapshot;
  }

  function account(): AccountState | null {
    return app.read().wallet.account;
  }

  function trustlines(): TrustlineState[] {
    return app.read().wallet.trustlines;
  }

  function overrides(): UrlOverrides {
    return app.read().book.overrides;
  }

  function tkt(): TicketDomain {
    return app.read().ticket;
  }

  function market(): MarketInfo | null {
    return snap()?.market ?? null;
  }

  function balances(): TicketBalances {
    const book = snap();
    const acc = account();
    const tls = trustlines();
    const ov = overrides();
    const baseClassic = book?.tokens.base?.name ? safeAsset(book.tokens.base.name) : null;
    const quoteClassic = book?.tokens.quote?.name ? safeAsset(book.tokens.quote.name) : null;
    const quoteTl =
      quoteClassic && quoteClassic.type === "credit"
        ? tls.find((t) => t.asset.code === quoteClassic.code && t.asset.issuer === quoteClassic.issuer)
        : undefined;
    const baseTl =
      baseClassic && baseClassic.type === "credit"
        ? tls.find((t) => t.asset.code === baseClassic.code && t.asset.issuer === baseClassic.issuer)
        : undefined;
    const baseIsNative = !baseClassic || baseClassic.type === "native";
    const quoteIsNative = quoteClassic?.type === "native";
    return {
      funded: !!acc?.exists,
      xlmSpendable: acc?.spendable ?? 0n,
      baseAtoms: baseIsNative ? (acc?.balance ?? 0n) : baseTl?.exists ? baseTl.balance : 0n,
      quoteAtoms: quoteIsNative
        ? (acc?.balance ?? 0n)
        : quoteTl
          ? quoteTl.exists
            ? quoteTl.balance
            : null
          : quoteClassic
            ? null
            : 0n,
      baseIsNative,
      quoteIsNative: !!quoteIsNative,
      quoteSymbol: tokenLabel(book?.tokens.quote, ov.quoteSym, book?.quote ?? null),
      baseSymbol: tokenLabel(book?.tokens.base, ov.baseSym, book?.base ?? null),
      baseDec: tokenDecimals(book?.tokens.base, ov.baseDec),
      quoteDec: tokenDecimals(book?.tokens.quote, ov.quoteDec),
    };
  }

  function quant(): Quant | null {
    const m = market();
    if (!m) return null;
    const b = balances();
    return {
      lotSize: m.lot_size,
      tickSize: m.tick_size,
      baseDec: b.baseDec,
      quoteDec: b.quoteDec,
      tickMin: m.tick_min,
      tickMax: m.tick_max,
      minLots: m.min_order_lots,
    };
  }

  function clearDonePhase(s: { ticket: TicketDomain }): void {
    if (s.ticket.phase === "confirmed" || s.ticket.phase === "failed") {
      s.ticket.phase = "idle";
      s.ticket.phaseDetail = "";
    }
  }

  function applyPrice(raw: string): void {
    const q = quant();
    const d = parseDecimal(raw);
    app.update((s) => {
      s.ticket.priceStr = raw;
      clearDonePhase(s);
      if (!q || !d) {
        s.ticket.tick = 0;
        s.ticket.priceSnapped = false;
        return;
      }
      const out = priceToTick(d, q, s.ticket.isBid);
      s.ticket.tick = out.tick;
      s.ticket.priceSnapped = out.snapped;
    });
  }

  function applyQty(raw: string): void {
    const q = quant();
    const d = parseDecimal(raw);
    app.update((s) => {
      s.ticket.qtyStr = raw;
      s.ticket.lots = q && d ? qtyToLots(d, q) : 0n;
      clearDonePhase(s);
    });
  }

  function snapLine(qn: Quant): string {
    const b = balances();
    const t = tkt();
    const parts = [`tick ${t.tick}`];
    if (t.priceSnapped) parts.push(`${tickToPrice(t.tick, qn)} ${b.quoteSymbol}`);
    parts.push(`${t.lots.toString()} lots (${lotsToQty(t.lots, qn)} ${b.baseSymbol})`);
    return `= ${parts.join(" · ")}`;
  }

  function displayPrice(): string {
    const t = tkt();
    if (t.priceStr) return t.priceStr;
    const q = quant();
    return q ? tickToPrice(t.tick, q) : "";
  }

  function displayQty(): string {
    const t = tkt();
    if (t.qtyStr) return t.qtyStr;
    const q = quant();
    return q ? lotsToQty(t.lots, q) : "";
  }

  function validation() {
    const m = market();
    const t = tkt();
    if (!m) return { ok: false as const, reason: "no Market entry" };
    return validateTicket({ isBid: t.isBid, tick: t.tick, lots: t.lots, flags: t.flags }, m, balances());
  }

  function padTokens(): ClassicToken[] {
    const book = snap();
    const out: ClassicToken[] = [];
    if (book?.base) {
      const a = book.tokens.base?.name ? safeAsset(book.tokens.base.name) : null;
      if (a && a.type === "credit") out.push({ sac: book.base, code: a.code, issuer: a.issuer });
      else out.push({ sac: book.base });
    }
    if (book?.quote) {
      const a = book.tokens.quote?.name ? safeAsset(book.tokens.quote.name) : null;
      if (a && a.type === "credit") out.push({ sac: book.quote, code: a.code, issuer: a.issuer });
      else out.push({ sac: book.quote });
    }
    return out;
  }

  function cancelPreviewTimer(): void {
    if (previewTimer != null) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
  }

  function schedulePreview(): void {
    cancelPreviewTimer();
    previewTimer = setTimeout(() => {
      previewTimer = null;
      void runPreview();
    }, 400);
  }

  function kickPreview(): void {
    cancelPreviewTimer();
    void runPreview();
  }

  function levelsKey(rows: { tick: number; open_lots: bigint }[] | undefined): string {
    return (rows ?? []).map((r) => `${r.tick}:${r.open_lots}`).join(",");
  }

  function quoteKey(): string {
    const book = snap();
    const acc = account();
    const t = tkt();
    const bid = book?.bestBid?.empty ? "-" : String(book?.bestBid?.tick ?? "");
    const ask = book?.bestAsk?.empty ? "-" : String(book?.bestAsk?.tick ?? "");
    const seq = acc?.sequence?.toString() ?? "";
    const spend = acc?.spendable?.toString() ?? "";
    const b = balances();
    return [
      bid,
      ask,
      levelsKey(book?.bids),
      levelsKey(book?.asks),
      seq,
      spend,
      b.baseAtoms.toString(),
      String(b.quoteAtoms),
      t.isBid,
      String(t.tick),
      t.lots.toString(),
      t.flags.post_only,
      t.flags.fill_or_kill,
      t.flags.no_rest,
      scopeOf(app.read()).market,
    ].join("|");
  }

  async function runPreview(): Promise<void> {
    const pub = opts.getPublic();
    const m = market();
    const v = validation();
    const book = snap();
    const acc = account();
    const t = tkt();
    if (!pub || !m || !book?.base || !book.quote || !v.ok || !acc?.exists) {
      previewGate.invalidate();
      app.update((s) => {
        s.ticket.preview = { kind: "idle" };
        s.ticket.previewQuoteKey = quoteKey();
      });
      return;
    }
    const fields: TicketFields = {
      isBid: t.isBid,
      tick: t.tick,
      lots: t.lots,
      flags: { ...t.flags },
    };
    const token = previewGate.begin(scopeOf(app.read()), fields);
    const key = quoteKey();
    const nonce = t.lastNonce ?? 1n;
    const lotSize = m.lot_size;
    const feeBps = m.taker_fee_bps;
    const levelCap = m.level_cap;
    const baseMeta = book.tokens.base;
    const quoteMeta = book.tokens.quote;
    app.update((s) => {
      if (s.ticket.preview.kind === "idle") s.ticket.preview = { kind: "loading" };
      s.ticket.previewQuoteKey = key;
    });
    try {
      const q = await engine.simulatePlace(opts.rpc, {
        contract: opts.contract,
        source: pub,
        sequence: acc.sequence.toString(),
        market: token.market,
        isBid: token.input.isBid,
        limitTick: token.input.tick,
        qty: token.input.lots,
        taker: pub,
        nonce,
        base: book.base,
        quote: book.quote,
      });
      if (!previewGate.accepts(token, scopeOf(app.read()))) return;
      const disp = remainderDisposition(q.filledLots, token.input.lots, token.input.flags);
      if (disp === "crossed") {
        app.update((s) => {
          s.ticket.preview = { kind: "typed", name: "Crossed" };
          s.ticket.previewQuoteKey = key;
        });
        return;
      }
      if (disp === "unfilled") {
        app.update((s) => {
          s.ticket.preview = { kind: "typed", name: "Unfilled" };
          s.ticket.previewQuoteKey = key;
        });
        return;
      }
      const feeIsQuote = !token.input.isBid;
      const output = token.input.isBid ? q.filledLots * lotSize : q.quoteAtoms;
      const feeAtoms = takerFeeAtoms(output, feeBps);
      const padded = pad(q.quoted, token.input.tick);
      let rw = 0;
      let ro = 0;
      for (const k of padded) {
        if (accessOf(k) === "rw") rw += 1;
        else ro += 1;
      }
      const padFee = estimatePaddedFee({ rw, ro }, 0n, levelCap);
      const rem = token.input.lots - q.filledLots;
      const ov = overrides();
      const avg =
        q.filledLots > 0n
          ? formatRatio(q.quoteAtoms * 10n ** BigInt(tokenDecimals(baseMeta, ov.baseDec)), q.filledLots * lotSize * 10n ** BigInt(tokenDecimals(quoteMeta, ov.quoteDec)))
          : "—";
      app.update((s) => {
        s.ticket.preview = {
          kind: "ok",
          filledLots: q.filledLots,
          quoteAtoms: q.quoteAtoms,
          feeAtoms,
          feeIsQuote,
          remainder: rem < 0n ? 0n : rem,
          disposition: disp,
          crossed: q.quoted.crossed.length,
          padFee,
          avg,
        };
        s.ticket.previewQuoteKey = key;
      });
    } catch (e) {
      if (!previewGate.accepts(token, scopeOf(app.read()))) return;
      const msg = e instanceof Error ? e.message : String(e);
      const code = parseContractError(msg);
      app.update((s) => {
        s.ticket.preview = code != null ? { kind: "typed", name: errorName(code) } : { kind: "err", message: msg };
        s.ticket.previewQuoteKey = s.ticket.preview.kind === "err" ? "" : key;
      });
    }
  }

  async function submit(): Promise<void> {
    const secret = opts.getSecret();
    const pub = opts.getPublic();
    const m = market();
    const v = validation();
    const book = snap();
    const acc = account();
    const t = tkt();
    if (!secret || !pub || !m || !book?.base || !book.quote || !v.ok || !acc?.exists) return;
    if (t.preview.kind === "typed" && t.preview.name === "Crossed") return;
    if (t.submitting) return;
    submitVersion += 1;
    const intent = buildTradeIntent({
      contract: opts.contract,
      market: scopeOf(app.read()).market,
      taker: pub,
      sequence: acc.sequence.toString(),
      isBid: t.isBid,
      tick: t.tick,
      lots: t.lots,
      flags: t.flags,
      base: book.base,
      quote: book.quote,
      tokens: padTokens(),
      levelCap: m.level_cap,
      version: submitVersion,
    });
    app.update((s) => {
      s.ticket.submitting = true;
      s.ticket.phase = "simulating";
      s.ticket.phaseDetail = "";
      s.ticket.lastHash = "";
    });
    try {
      const hint = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
      const nonce = await engine.allocNonce(opts.rpc, intent.contract, intent.market, intent.taker, hint);
      app.update((s) => {
        s.ticket.lastNonce = nonce;
      });
      const q = await engine.simulatePlace(opts.rpc, {
        contract: intent.contract,
        source: intent.taker,
        sequence: intent.sequence,
        market: intent.market,
        isBid: intent.isBid,
        limitTick: intent.tick,
        qty: intent.lots,
        taker: intent.taker,
        nonce,
        base: intent.base,
        quote: intent.quote,
      });
      const disp = remainderDisposition(q.filledLots, intent.lots, intent.flags);
      if (disp === "crossed") {
        app.update((s) => {
          s.ticket.phase = "failed";
          s.ticket.phaseDetail = plainError("Crossed");
        });
        return;
      }
      app.update((s) => {
        s.ticket.phase = "signing";
      });
      app.update((s) => {
        s.ticket.phase = "sending";
      });
      const res = await engine.submitPlace(opts.rpc, {
        contract: intent.contract,
        secret,
        taker: intent.taker,
        market: intent.market,
        isBid: intent.isBid,
        limitTick: intent.tick,
        qtyLots: intent.lots,
        startTick: q.quoted.startTick,
        nonce,
        flags: intent.flags,
        quoted: q.quoted,
        tokens: [...intent.tokens],
        padEnd: intent.tick,
        levelCap: intent.levelCap,
      });
      applyResult(res, intent, q.filledLots, q.quoteAtoms, disp === "rests", nonce);
    } catch (e) {
      app.update((s) => {
        s.ticket.phase = "failed";
        s.ticket.phaseDetail = e instanceof Error ? e.message : String(e);
      });
    } finally {
      app.update((s) => {
        s.ticket.submitting = false;
      });
    }
  }

  function applyResult(
    res: EngineResult,
    intent: TradeIntent,
    filledLots: bigint,
    quoteAtoms: bigint,
    rested: boolean,
    nonce: bigint,
  ): void {
    if (res.kind === "ok") {
      const fee = res.fee ? ` · fee ${res.fee} stroops charged` : "";
      app.update((s) => {
        s.ticket.phase = "confirmed";
        s.ticket.lastHash = res.hash;
        s.ticket.phaseDetail = `took ${filledLots.toString()} lots · ${quoteAtoms.toString()} quote atoms${rested ? " · rests" : ""}${fee}`;
        s.ticket.lastNonce = null;
      });
      opts.onLog(`place ${intent.isBid ? "bid" : "ask"} ${intent.tick}`, res.hash, intent.taker);
      if (rested) opts.onRested(nonce, intent);
      opts.onRefresh();
    } else if (res.kind === "typed") {
      app.update((s) => {
        s.ticket.phase = "failed";
        s.ticket.phaseDetail = plainError(res.errorName);
        s.ticket.lastHash = res.hash ?? "";
      });
      opts.onLog(`place ${res.errorName}`, res.hash, intent.taker);
    } else if (res.kind === "footprint") {
      app.update((s) => {
        s.ticket.phase = "failed";
        s.ticket.phaseDetail = "footprint";
        s.ticket.lastHash = res.hash ?? "";
      });
      opts.onLog("place footprint", res.hash, intent.taker);
    } else if (res.kind === "resourceLimit" && res.at === "prepare") {
      app.update((s) => {
        s.ticket.phase = "failed";
        s.ticket.phaseDetail = res.message;
        s.ticket.lastHash = res.hash ?? "";
      });
      opts.onLog("place oversized", res.hash, intent.taker);
    } else {
      app.update((s) => {
        s.ticket.phase = "failed";
        s.ticket.phaseDetail = "message" in res && res.message ? res.message : res.kind;
        s.ticket.lastHash = res.hash ?? "";
      });
      opts.onLog("place failed", res.hash, intent.taker);
    }
  }

  function previewHtml(): string {
    const preview = tkt().preview;
    if (preview.kind === "idle") return "";
    if (preview.kind === "loading") return `<p class="wallet-muted">preview…</p>`;
    if (preview.kind === "err") return `<p class="wallet-status">${esc(preview.message)}</p>`;
    if (preview.kind === "typed") return `<p class="wallet-status">${typedErrorHtml(preview.name)}</p>`;
    const p = preview;
    const rem =
      p.remainder === 0n
        ? "no remainder"
        : p.disposition === "rests"
          ? `remainder ${countLabel(p.remainder, "lot")} rests`
          : `remainder ${countLabel(p.remainder, "lot")} refunds`;
    const feeSide = p.feeIsQuote ? balances().quoteSymbol : balances().baseSymbol;
    return `<ul class="ticket-preview">
      <li>takes ${esc(countLabel(p.filledLots, "lot"))} · ${esc(countLabel(p.crossed, "level"))}</li>
      <li>average ${esc(p.avg)}</li>
      <li>taker fee ${esc(formatInt(p.feeAtoms))} ${esc(feeSide)} atoms</li>
      <li>${esc(rem)}</li>
      <li>padded fee ~ ${esc(formatInt(p.padFee))} stroops (${esc(formatAtoms(p.padFee, 7))} XLM)</li>
    </ul>`;
  }

  function stripInner(): string {
    const t = tkt();
    if (t.phase === "idle") return "";
    const label =
      t.phase === "simulating"
        ? "simulating"
        : t.phase === "signing"
          ? "signing"
          : t.phase === "sending"
            ? "sending"
            : t.phase === "confirmed"
              ? "confirmed"
              : "failed";
    const hash = t.lastHash ? ` ${txLink(t.lastHash)}` : "";
    return `${esc(label)}${t.phaseDetail ? ` · ${esc(t.phaseDetail)}` : ""}${hash}`;
  }

  function fullHtml(): string {
    const v = validation();
    const qn = quant();
    const b = balances();
    const t = tkt();
    const human = qn ? snapLine(qn) : "";
    const sym = b.baseSymbol;
    const qsym = b.quoteSymbol;
    const busy = t.submitting || t.phase === "simulating" || t.phase === "signing" || t.phase === "sending";
    const pStep = qn ? oneTickPriceStep(qn) : "any";
    const qStep = qn ? oneLotQtyStep(qn) : "any";
    const priceStr = displayPrice();
    const qtyStr = displayQty();
    return `<section class="ticket">
      <h3>place order</h3>
      <div class="ticket-side">
        <button type="button" data-act="buy" class="${t.isBid ? "on bid" : ""}">BUY ${esc(sym)}</button>
        <button type="button" data-act="sell" class="${!t.isBid ? "on ask" : ""}">SELL ${esc(sym)}</button>
      </div>
      <div class="ticket-fields">
        <label><span class="ticket-label" title="price · ${esc(qsym)} per ${esc(sym)}">price · ${esc(qsym)}/${esc(sym)}</span>
          <div class="ticket-step">
            <button type="button" data-act="price-dec" aria-label="one tick down">−</button>
            <input class="wallet-input" data-field="price" inputmode="decimal" step="${esc(pStep)}" value="${esc(priceStr)}" />
            <button type="button" data-act="price-inc" aria-label="one tick up">+</button>
          </div>
        </label>
        <label><span class="ticket-label">quantity · ${esc(sym)}</span>
          <div class="ticket-step">
            <button type="button" data-act="qty-dec" aria-label="one lot down">−</button>
            <input class="wallet-input" data-field="qty" inputmode="decimal" step="${esc(qStep)}" value="${esc(qtyStr)}" />
            <button type="button" data-act="qty-inc" aria-label="one lot up">+</button>
          </div>
        </label>
      </div>
      <p class="wallet-muted" data-role="human">${esc(human)}</p>
      <div class="ticket-flags">
        <label class="ticket-flag" title="rest only; reject if the order would take"><input type="checkbox" data-flag="post_only" ${t.flags.post_only ? "checked" : ""} /> post-only</label>
        <label class="ticket-flag" title="fill completely or revert; nothing rests"><input type="checkbox" data-flag="fill_or_kill" ${t.flags.fill_or_kill ? "checked" : ""} /> fill-or-kill</label>
        <label class="ticket-flag" title="take what is there and refund the rest; do not rest"><input type="checkbox" data-flag="no_rest" ${t.flags.no_rest ? "checked" : ""} /> no-rest</label>
      </div>
      <p class="wallet-muted" data-role="why">${v.ok ? "" : esc(v.reason)}</p>
      <div data-role="preview">${previewHtml()}</div>
      ${
        t.phase === "idle"
          ? `<button type="button" data-act="place" class="ticket-cta ${t.isBid ? "bid" : "ask"}" ${!v.ok || busy || (t.preview.kind === "typed" && t.preview.name === "Crossed") ? "disabled" : ""}>${t.isBid ? "BUY" : "SELL"} ${esc(sym)}</button>`
          : `<div class="ticket-cta ticket-status ${t.isBid ? "bid" : "ask"} ${esc(t.phase)}" data-act="status-ack" data-role="strip">${stripInner()}</div>`
      }
    </section>`;
  }

  function bind(root: HTMLElement): void {
    root.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
      if (!el || !root.contains(el)) return;
      const act = el.dataset.act;
      if (act === "buy") {
        app.update((s) => {
          s.ticket.isBid = true;
          s.ticket.sideLocked = true;
          clearDonePhase(s);
        });
        applyPrice(tkt().priceStr);
        kickPreview();
      } else if (act === "sell") {
        app.update((s) => {
          s.ticket.isBid = false;
          s.ticket.sideLocked = true;
          clearDonePhase(s);
        });
        applyPrice(tkt().priceStr);
        kickPreview();
      } else if (act === "price-dec" || act === "price-inc") {
        const q = quant();
        if (!q) return;
        const dir = act === "price-inc" ? 1 : -1;
        app.update((s) => {
          s.ticket.tick = stepTick(s.ticket.tick, dir, q);
          s.ticket.priceStr = tickToPrice(s.ticket.tick, q);
          s.ticket.priceSnapped = false;
          clearDonePhase(s);
        });
        kickPreview();
      } else if (act === "qty-dec" || act === "qty-inc") {
        const q = quant();
        if (!q) return;
        const dir = act === "qty-inc" ? 1 : -1;
        app.update((s) => {
          s.ticket.lots = stepLots(s.ticket.lots, dir, q);
          s.ticket.qtyStr = lotsToQty(s.ticket.lots, q);
          clearDonePhase(s);
        });
        kickPreview();
      } else if (act === "place") {
        void submit();
      } else if (act === "status-ack") {
        app.update((s) => {
          clearDonePhase(s);
        });
      }
    });
    root.addEventListener("input", (e) => {
      const el = e.target as HTMLInputElement;
      const field = el.dataset.field;
      if (field === "price") {
        applyPrice(el.value);
        schedulePreview();
      } else if (field === "qty") {
        applyQty(el.value);
        schedulePreview();
      }
    });
    root.addEventListener("change", (e) => {
      const el = e.target as HTMLInputElement;
      const key = el.dataset.flag as keyof PlaceFlags | undefined;
      if (!key) return;
      app.update((s) => {
        s.ticket.flags = { ...s.ticket.flags, [key]: el.checked };
        clearDonePhase(s);
      });
      kickPreview();
    });
  }

  function maybeDefaultTick(): void {
    const book = snap();
    const t = tkt();
    if (t.tick !== 1 || !book || book.bestAsk.empty || !t.isBid) return;
    const q = quant();
    app.update((s) => {
      if (s.ticket.tick !== 1) return;
      s.ticket.tick = book.bestAsk.tick;
      if (q) s.ticket.priceStr = tickToPrice(s.ticket.tick, q);
    });
  }

  function maybeDefaultSide(): void {
    const t = tkt();
    if (t.sideLocked) return;
    const m = market();
    const book = snap();
    if (!m || !book) return;
    const bidTick = book.bestAsk.empty ? m.tick_min : book.bestAsk.tick;
    if (!preferSellSide(balances(), m, bidTick) || !t.isBid) return;
    const q = quant();
    app.update((s) => {
      if (s.ticket.sideLocked || !s.ticket.isBid) return;
      s.ticket.isBid = false;
      if (!book.bestBid.empty) {
        s.ticket.tick = book.bestBid.tick;
        if (q) s.ticket.priceStr = tickToPrice(s.ticket.tick, q);
      }
    });
  }

  function renderTicket(): void {
    if (!rootEl) return;
    const w = app.read().wallet;
    if (!w.enabled || !w.active) {
      cache.write("ticket", rootEl, "");
      return;
    }
    maybeDefaultTick();
    maybeDefaultSide();
    cache.write("ticket", rootEl, fullHtml());
    if (!bound) {
      bind(rootEl);
      bound = true;
    }
    if (tkt().focusQty) {
      // Focus after the whole render pass: on the tap that OPENS the sheet,
      // this render can run while .wallet-body is still display:none and
      // focus() would no-op (B2 audit MF-R1). Only clear the flag once focus
      // actually lands; a hidden input keeps the flag for the next pass.
      queueMicrotask(() => {
        const inp = rootEl?.querySelector<HTMLInputElement>("[data-field=qty]");
        if (inp && inp.offsetParent !== null) {
          inp.focus();
          if (document.activeElement === inp) {
            app.update((s) => {
              s.ticket.focusQty = false;
            });
          }
        }
      });
    }
    if (quoteKey() !== tkt().previewQuoteKey) schedulePreview();
  }

  app.register(
    "ticket",
    () => renderTicket(),
    () => {
      const v = app.read().versions;
      return `${v.book}|${v.wallet}|${v.ticket}`;
    },
  );

  return {
    attach(root) {
      rootEl = root;
      renderTicket();
    },
    prefill(side, tickN) {
      const q = quant();
      app.update((s) => {
        s.ticket.isBid = side === "ask";
        s.ticket.tick = tickN;
        s.ticket.priceSnapped = false;
        if (q) s.ticket.priceStr = tickToPrice(tickN, q);
        s.ticket.focusQty = true;
        s.ticket.phase = "idle";
        s.ticket.sideLocked = true;
      });
      kickPreview();
    },
    preview: runPreview,
    submit,
  };
}

function safeAsset(name: string) {
  try {
    return parseAssetFromSacName(name);
  } catch {
    return null;
  }
}
