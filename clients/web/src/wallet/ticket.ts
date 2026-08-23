import type { BookSnapshot, MarketInfo, Rpc } from "../book";
import { formatAtoms, formatInt, formatRatio } from "../decode";
import { pad } from "../engine/pad";
import { simulatePlace } from "../engine/quote";
import { submitPlace, type ClassicToken, type EngineResult, type PlaceFlags } from "../engine/submit";
import { estimatePaddedFee } from "../engine/txdata";
import { errorMessageByName, errorName, errorTitleByName, parseContractError } from "../engine/errors";
import { allocNonce } from "../engine/pad";
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
      return {
        ok: false,
        reason: `need ${formatAtoms(need, bal.quoteDec)} ${bal.quoteSymbol} for this bid`,
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
  retryable: boolean;
  focusQty: boolean;
  previewGen: number;
  previewQuoteKey: string;
  submitting: boolean;
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
    retryable: false,
    focusQty: false,
    previewGen: 0,
    previewQuoteKey: "",
    submitting: false,
  };
}

export function createTicket(opts: {
  store: Store<AppState>;
  rpc: Rpc;
  contract: string;
  getSecret: () => string | null;
  getPublic: () => string | null;
  getMarket: () => number;
  onRefresh: () => void;
  onRested: (nonce: bigint) => void;
  onLog: (text: string, hash?: string) => void;
}): TicketHandle {
  const app = opts.store;
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

  function applyPrice(raw: string): void {
    const q = quant();
    const d = parseDecimal(raw);
    app.update((s) => {
      s.ticket.priceStr = raw;
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
      opts.getMarket(),
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
      app.update((s) => {
        s.ticket.preview = { kind: "idle" };
        s.ticket.previewQuoteKey = quoteKey();
      });
      return;
    }
    let gen = 0;
    app.update((s) => {
      s.ticket.previewGen += 1;
      gen = s.ticket.previewGen;
      if (s.ticket.preview.kind === "idle") s.ticket.preview = { kind: "loading" };
      s.ticket.previewQuoteKey = quoteKey();
    });
    try {
      const q = await simulatePlace(opts.rpc, {
        contract: opts.contract,
        source: pub,
        sequence: acc.sequence.toString(),
        market: opts.getMarket(),
        isBid: t.isBid,
        limitTick: t.tick,
        qty: t.lots,
        taker: pub,
        nonce: t.lastNonce ?? 1n,
        base: book.base,
        quote: book.quote,
      });
      if (gen !== app.read().ticket.previewGen) return;
      const cur = tkt();
      const disp = remainderDisposition(q.filledLots, cur.lots, cur.flags);
      if (disp === "crossed") {
        app.update((s) => {
          s.ticket.preview = { kind: "typed", name: "Crossed" };
          s.ticket.previewQuoteKey = quoteKey();
        });
        return;
      }
      if (disp === "unfilled") {
        app.update((s) => {
          s.ticket.preview = { kind: "typed", name: "Unfilled" };
          s.ticket.previewQuoteKey = quoteKey();
        });
        return;
      }
      const feeIsQuote = !cur.isBid;
      const output = cur.isBid ? q.filledLots * m.lot_size : q.quoteAtoms;
      const feeAtoms = takerFeeAtoms(output, m.taker_fee_bps);
      const padded = pad(q.quoted, cur.tick);
      const padFee = estimatePaddedFee(padded.keys.length);
      const rem = cur.lots - q.filledLots;
      const ov = overrides();
      const avg =
        q.filledLots > 0n
          ? formatRatio(q.quoteAtoms * 10n ** BigInt(tokenDecimals(book.tokens.base, ov.baseDec)), q.filledLots * m.lot_size * 10n ** BigInt(tokenDecimals(book.tokens.quote, ov.quoteDec)))
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
        s.ticket.previewQuoteKey = quoteKey();
      });
    } catch (e) {
      if (gen !== app.read().ticket.previewGen) return;
      const msg = e instanceof Error ? e.message : String(e);
      const code = parseContractError(msg);
      app.update((s) => {
        s.ticket.preview = code != null ? { kind: "typed", name: errorName(code) } : { kind: "err", message: msg };
        s.ticket.previewQuoteKey = s.ticket.preview.kind === "err" ? "" : quoteKey();
      });
    }
  }

  async function submit(reuseNonce: boolean): Promise<void> {
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
    app.update((s) => {
      s.ticket.submitting = true;
      s.ticket.retryable = false;
      s.ticket.phase = "simulating";
      s.ticket.phaseDetail = "";
      s.ticket.lastHash = "";
    });
    try {
      const hint = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
      const cur = tkt();
      const nonce = reuseNonce && cur.lastNonce != null ? cur.lastNonce : await allocNonce(opts.rpc, opts.contract, opts.getMarket(), pub, hint);
      app.update((s) => {
        s.ticket.lastNonce = nonce;
      });
      const q = await simulatePlace(opts.rpc, {
        contract: opts.contract,
        source: pub,
        sequence: acc.sequence.toString(),
        market: opts.getMarket(),
        isBid: cur.isBid,
        limitTick: cur.tick,
        qty: cur.lots,
        taker: pub,
        nonce,
        base: book.base,
        quote: book.quote,
      });
      const now = tkt();
      const disp = remainderDisposition(q.filledLots, now.lots, now.flags);
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
      const out = pad(q.quoted, now.tick);
      const res = await submitPlace(opts.rpc, {
        contract: opts.contract,
        secret,
        taker: pub,
        market: opts.getMarket(),
        isBid: now.isBid,
        limitTick: now.tick,
        qtyLots: now.lots,
        startTick: q.quoted.startTick,
        nonce,
        window: out.window,
        flags: now.flags,
        quoted: q.quoted,
        tokens: padTokens(),
        padEnd: now.tick,
      });
      applyResult(res, q.filledLots, q.quoteAtoms, disp === "rests", nonce);
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

  function applyResult(res: EngineResult, filledLots: bigint, quoteAtoms: bigint, rested: boolean, nonce: bigint): void {
    const t = tkt();
    if (res.kind === "ok") {
      const fee = res.fee ? ` · fee ${res.fee} stroops charged` : "";
      app.update((s) => {
        s.ticket.phase = "confirmed";
        s.ticket.lastHash = res.hash;
        s.ticket.phaseDetail = `took ${filledLots.toString()} lots · ${quoteAtoms.toString()} quote atoms${rested ? " · rests" : ""}${fee}`;
        s.ticket.lastNonce = null;
      });
      opts.onLog(`place ${t.isBid ? "bid" : "ask"} ${t.tick}`, res.hash);
      if (rested) opts.onRested(nonce);
      opts.onRefresh();
    } else if (res.kind === "typed") {
      app.update((s) => {
        s.ticket.phase = "failed";
        s.ticket.phaseDetail = plainError(res.errorName);
        s.ticket.lastHash = res.hash ?? "";
        s.ticket.retryable = res.errorName === "RetryRest";
      });
      opts.onLog(`place ${res.errorName}`, res.hash);
    } else if (res.kind === "footprint") {
      app.update((s) => {
        s.ticket.phase = "failed";
        s.ticket.phaseDetail = "footprint";
        s.ticket.lastHash = res.hash ?? "";
      });
      opts.onLog("place footprint", res.hash);
    } else {
      app.update((s) => {
        s.ticket.phase = "failed";
        s.ticket.phaseDetail = res.message;
        s.ticket.lastHash = res.hash ?? "";
      });
      opts.onLog("place failed", res.hash);
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

  function stripHtml(): string {
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
    const retry = t.retryable ? ` <button type="button" data-act="retry">retry</button>` : "";
    return `<p class="ticket-strip">${esc(label)}${t.phaseDetail ? ` · ${esc(t.phaseDetail)}` : ""}${hash}${retry}</p>`;
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
        <label><span class="ticket-label" title="price · ${esc(qsym)} per ${esc(sym)}">price · ${esc(qsym)}/${esc(sym)}</span> <input class="wallet-input" data-field="price" inputmode="decimal" step="${esc(pStep)}" value="${esc(priceStr)}" /></label>
        <label><span class="ticket-label">quantity · ${esc(sym)}</span> <input class="wallet-input" data-field="qty" inputmode="decimal" step="${esc(qStep)}" value="${esc(qtyStr)}" /></label>
      </div>
      <p class="wallet-muted" data-role="human">${esc(human)}</p>
      <div class="ticket-flags">
        <label class="ticket-flag" title="rest only; reject if the order would take"><input type="checkbox" data-flag="post_only" ${t.flags.post_only ? "checked" : ""} /> post-only</label>
        <label class="ticket-flag" title="fill completely or revert; nothing rests"><input type="checkbox" data-flag="fill_or_kill" ${t.flags.fill_or_kill ? "checked" : ""} /> fill-or-kill</label>
        <label class="ticket-flag" title="take what is there and refund the rest; do not rest"><input type="checkbox" data-flag="no_rest" ${t.flags.no_rest ? "checked" : ""} /> no-rest</label>
      </div>
      <p class="wallet-muted" data-role="why">${v.ok ? "" : esc(v.reason)}</p>
      <div data-role="preview">${previewHtml()}</div>
      <button type="button" data-act="place" class="ticket-cta ${t.isBid ? "bid" : "ask"}" ${!v.ok || busy || (t.preview.kind === "typed" && t.preview.name === "Crossed") ? "disabled" : ""}>${t.isBid ? "BUY" : "SELL"} ${esc(sym)}</button>
      <div data-role="strip">${stripHtml()}</div>
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
        });
        applyPrice(tkt().priceStr);
        kickPreview();
      } else if (act === "sell") {
        app.update((s) => {
          s.ticket.isBid = false;
        });
        applyPrice(tkt().priceStr);
        kickPreview();
      } else if (act === "place") {
        void submit(false);
      } else if (act === "retry") {
        void submit(true);
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

  function renderTicket(): void {
    if (!rootEl) return;
    const w = app.read().wallet;
    if (!w.enabled || !w.active) {
      cache.write("ticket", rootEl, "");
      return;
    }
    maybeDefaultTick();
    cache.write("ticket", rootEl, fullHtml());
    if (!bound) {
      bind(rootEl);
      bound = true;
    }
    if (tkt().focusQty) {
      app.update((s) => {
        s.ticket.focusQty = false;
      });
      rootEl.querySelector<HTMLInputElement>("[data-field=qty]")?.focus();
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
      });
      kickPreview();
    },
  };
}

function safeAsset(name: string) {
  try {
    return parseAssetFromSacName(name);
  } catch {
    return null;
  }
}
