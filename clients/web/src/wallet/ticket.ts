import type { BookSnapshot, MarketInfo, Rpc } from "../book";
import { formatAtoms, formatInt, formatRatio } from "../decode";
import { pad } from "../engine/pad";
import { simulatePlace } from "../engine/quote";
import { submitPlace, type ClassicToken, type EngineResult, type PlaceFlags } from "../engine/submit";
import { estimatePaddedFee } from "../engine/txdata";
import { errorMessageByName, errorName, errorTitleByName, parseContractError } from "../engine/errors";
import { allocNonce } from "../engine/pad";
import { countLabel, esc, txLink } from "../view/format";
import { priceOf, tokenDecimals, tokenLabel, type UrlOverrides } from "../view/format";
import { parseAssetFromSacName, type AccountState, type TrustlineState } from "./account";

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
};

export function validateTicket(fields: TicketFields, market: MarketInfo, bal: TicketBalances): { ok: true } | { ok: false; reason: string } {
  if (!bal.funded) return { ok: false, reason: "account not funded" };
  if (!tickInBand(fields.tick, market.tick_min, market.tick_max)) {
    return { ok: false, reason: `tick outside the band [${market.tick_min}, ${market.tick_max})` };
  }
  if (fields.lots <= 0n) return { ok: false, reason: "lots must be positive" };
  if (!lotsInBounds(fields.lots, market.min_order_lots, market.max_order_lots)) {
    return { ok: false, reason: `lots outside ${market.min_order_lots} / ${market.max_order_lots}` };
  }
  if (bal.xlmSpendable < XLM_FEE_HEADROOM) return { ok: false, reason: "need at least 0.2 XLM for the padded fee" };
  if (fields.isBid) {
    if (bal.quoteAtoms == null) return { ok: false, reason: `no ${bal.quoteSymbol} trustline` };
    const need = escrowQuoteAtoms(fields.lots, fields.tick, market.tick_size);
    if (bal.quoteAtoms < need) {
      return { ok: false, reason: `need ${need.toString()} ${bal.quoteSymbol} atoms for this bid` };
    }
  } else {
    const need = escrowBaseAtoms(fields.lots, market.lot_size);
    const avail = bal.baseIsNative ? bal.xlmSpendable - XLM_FEE_HEADROOM : bal.baseAtoms;
    if (avail < need) {
      return { ok: false, reason: `need ${need.toString()} ${bal.baseSymbol} atoms for this ask` };
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
  draw(root: HTMLElement): void;
  prefill(side: "bid" | "ask", tick: number): void;
  setLive(book: BookSnapshot | null, account: AccountState | null, trustlines: TrustlineState[], overrides: UrlOverrides): void;
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

type PreviewState = PreviewOk | { kind: "typed"; name: string } | { kind: "err"; message: string } | { kind: "idle" } | { kind: "loading" };

type SubmitPhase = "idle" | "simulating" | "signing" | "sending" | "confirmed" | "failed";

export function createTicket(opts: {
  rpc: Rpc;
  contract: string;
  getSecret: () => string | null;
  getPublic: () => string | null;
  getMarket: () => number;
  onRefresh: () => void;
  onRested: (nonce: bigint) => void;
  onLog: (text: string, hash?: string) => void;
}): TicketHandle {
  let book: BookSnapshot | null = null;
  let account: AccountState | null = null;
  let trustlines: TrustlineState[] = [];
  let overrides: UrlOverrides = { baseSym: null, quoteSym: null, baseDec: null, quoteDec: null };
  let isBid = true;
  let tick = 1;
  let lots = 1n;
  let flags: PlaceFlags = { post_only: false, fill_or_kill: false, no_rest: false };
  let preview: PreviewState = { kind: "idle" };
  let phase: SubmitPhase = "idle";
  let phaseDetail = "";
  let lastHash = "";
  let lastNonce: bigint | null = null;
  let retryable = false;
  let focusQty = false;
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let previewGen = 0;
  let rootEl: HTMLElement | null = null;
  let submitting = false;

  function market(): MarketInfo | null {
    return book?.market ?? null;
  }

  function balances(): TicketBalances {
    const baseClassic = book?.tokens.base?.name ? safeAsset(book.tokens.base.name) : null;
    const quoteClassic = book?.tokens.quote?.name ? safeAsset(book.tokens.quote.name) : null;
    const quoteTl =
      quoteClassic && quoteClassic.type === "credit"
        ? trustlines.find((t) => t.asset.code === quoteClassic.code && t.asset.issuer === quoteClassic.issuer)
        : undefined;
    const baseTl =
      baseClassic && baseClassic.type === "credit"
        ? trustlines.find((t) => t.asset.code === baseClassic.code && t.asset.issuer === baseClassic.issuer)
        : undefined;
    const baseIsNative = !baseClassic || baseClassic.type === "native";
    const quoteIsNative = quoteClassic?.type === "native";
    return {
      funded: !!account?.exists,
      xlmSpendable: account?.spendable ?? 0n,
      baseAtoms: baseIsNative ? (account?.balance ?? 0n) : baseTl?.exists ? baseTl.balance : 0n,
      quoteAtoms: quoteIsNative
        ? (account?.balance ?? 0n)
        : quoteTl
          ? quoteTl.exists
            ? quoteTl.balance
            : null
          : quoteClassic
            ? null
            : 0n,
      baseIsNative,
      quoteIsNative: !!quoteIsNative,
      quoteSymbol: tokenLabel(book?.tokens.quote, overrides.quoteSym, book?.quote ?? null),
      baseSymbol: tokenLabel(book?.tokens.base, overrides.baseSym, book?.base ?? null),
    };
  }

  function validation() {
    const m = market();
    if (!m) return { ok: false as const, reason: "no Market entry" };
    return validateTicket({ isBid, tick, lots, flags }, m, balances());
  }

  function padTokens(): ClassicToken[] {
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

  function schedulePreview(): void {
    if (previewTimer != null) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewTimer = null;
      void runPreview();
    }, 400);
  }

  async function runPreview(): Promise<void> {
    const pub = opts.getPublic();
    const m = market();
    const v = validation();
    if (!pub || !m || !book?.base || !book.quote || !v.ok || !account?.exists) {
      preview = { kind: "idle" };
      paintChrome();
      return;
    }
    const gen = ++previewGen;
    preview = { kind: "loading" };
    paintChrome();
    try {
      const q = await simulatePlace(opts.rpc, {
        contract: opts.contract,
        source: pub,
        sequence: account.sequence.toString(),
        market: opts.getMarket(),
        isBid,
        limitTick: tick,
        qty: lots,
        taker: pub,
        nonce: lastNonce ?? 1n,
        base: book.base,
        quote: book.quote,
      });
      if (gen !== previewGen) return;
      const disp = remainderDisposition(q.filledLots, lots, flags);
      if (disp === "crossed") {
        preview = { kind: "typed", name: "Crossed" };
        paintChrome();
        return;
      }
      if (disp === "unfilled") {
        preview = { kind: "typed", name: "Unfilled" };
        paintChrome();
        return;
      }
      const feeIsQuote = !isBid;
      const output = isBid ? q.filledLots * m.lot_size : q.quoteAtoms;
      const feeAtoms = takerFeeAtoms(output, m.taker_fee_bps);
      const padded = pad(q.quoted, tick);
      const padFee = estimatePaddedFee(padded.keys.length);
      const rem = lots - q.filledLots;
      const avg =
        q.filledLots > 0n
          ? formatRatio(q.quoteAtoms * 10n ** BigInt(tokenDecimals(book.tokens.base, overrides.baseDec)), q.filledLots * m.lot_size * 10n ** BigInt(tokenDecimals(book.tokens.quote, overrides.quoteDec)))
          : "—";
      preview = {
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
    } catch (e) {
      if (gen !== previewGen) return;
      const msg = e instanceof Error ? e.message : String(e);
      const code = parseContractError(msg);
      preview = code != null ? { kind: "typed", name: errorName(code) } : { kind: "err", message: msg };
    }
    paintChrome();
  }

  async function submit(reuseNonce: boolean): Promise<void> {
    const secret = opts.getSecret();
    const pub = opts.getPublic();
    const m = market();
    const v = validation();
    if (!secret || !pub || !m || !book?.base || !book.quote || !v.ok || !account?.exists) return;
    if (preview.kind === "typed" && preview.name === "Crossed") return;
    if (submitting) return;
    submitting = true;
    retryable = false;
    phase = "simulating";
    phaseDetail = "";
    lastHash = "";
    paintChrome();
    try {
      const hint = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
      const nonce = reuseNonce && lastNonce != null ? lastNonce : await allocNonce(opts.rpc, opts.contract, opts.getMarket(), pub, hint);
      lastNonce = nonce;
      const q = await simulatePlace(opts.rpc, {
        contract: opts.contract,
        source: pub,
        sequence: account.sequence.toString(),
        market: opts.getMarket(),
        isBid,
        limitTick: tick,
        qty: lots,
        taker: pub,
        nonce,
        base: book.base,
        quote: book.quote,
      });
      const disp = remainderDisposition(q.filledLots, lots, flags);
      if (disp === "crossed") {
        phase = "failed";
        phaseDetail = plainError("Crossed");
        paintChrome();
        return;
      }
      phase = "signing";
      paintChrome();
      phase = "sending";
      paintChrome();
      const out = pad(q.quoted, tick);
      const res = await submitPlace(opts.rpc, {
        contract: opts.contract,
        secret,
        taker: pub,
        market: opts.getMarket(),
        isBid,
        limitTick: tick,
        qtyLots: lots,
        startTick: q.quoted.startTick,
        nonce,
        window: out.window,
        flags,
        quoted: q.quoted,
        tokens: padTokens(),
        padEnd: tick,
      });
      applyResult(res, q.filledLots, q.quoteAtoms, disp === "rests", nonce);
    } catch (e) {
      phase = "failed";
      phaseDetail = e instanceof Error ? e.message : String(e);
      paintChrome();
    } finally {
      submitting = false;
    }
  }

  function applyResult(res: EngineResult, filledLots: bigint, quoteAtoms: bigint, rested: boolean, nonce: bigint): void {
    if (res.kind === "ok") {
      phase = "confirmed";
      lastHash = res.hash;
      const fee = res.fee ? ` · fee ${res.fee} stroops charged` : "";
      phaseDetail = `took ${filledLots.toString()} lots · ${quoteAtoms.toString()} quote atoms${rested ? " · rests" : ""}${fee}`;
      opts.onLog(`place ${isBid ? "bid" : "ask"} ${tick}`, res.hash);
      if (rested) opts.onRested(nonce);
      lastNonce = null;
      opts.onRefresh();
    } else if (res.kind === "typed") {
      phase = "failed";
      phaseDetail = plainError(res.errorName);
      lastHash = res.hash ?? "";
      retryable = res.errorName === "RetryRest";
      opts.onLog(`place ${res.errorName}`, res.hash);
    } else if (res.kind === "footprint") {
      phase = "failed";
      phaseDetail = "footprint";
      lastHash = res.hash ?? "";
      opts.onLog("place footprint", res.hash);
    } else {
      phase = "failed";
      phaseDetail = res.message;
      lastHash = res.hash ?? "";
      opts.onLog("place failed", res.hash);
    }
    paintChrome();
  }

  function paintChrome(): void {
    if (!rootEl) return;
    const v = validation();
    const human = rootEl.querySelector("[data-role=human]");
    const m = market();
    if (human && m && book) {
      human.textContent = `${priceOf(tick, book, overrides)} · ${formatAtoms(lots * m.lot_size, tokenDecimals(book.tokens.base, overrides.baseDec))} ${balances().baseSymbol}`;
    }
    const why = rootEl.querySelector("[data-role=why]");
    if (why) why.textContent = v.ok ? "" : v.reason;
    const btn = rootEl.querySelector<HTMLButtonElement>("[data-act=place]");
    if (btn) {
      btn.disabled = !v.ok || phase === "simulating" || phase === "signing" || phase === "sending" || (preview.kind === "typed" && preview.name === "Crossed");
      btn.textContent = `${isBid ? "BUY" : "SELL"} ${balances().baseSymbol}`;
      btn.className = `ticket-cta ${isBid ? "bid" : "ask"}`;
    }
    const prev = rootEl.querySelector("[data-role=preview]");
    if (prev) prev.innerHTML = previewHtml();
    const strip = rootEl.querySelector("[data-role=strip]");
    if (strip) strip.innerHTML = stripHtml();
  }

  function previewHtml(): string {
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
    if (phase === "idle") return "";
    const label =
      phase === "simulating"
        ? "simulating"
        : phase === "signing"
          ? "signing"
          : phase === "sending"
            ? "sending"
            : phase === "confirmed"
              ? "confirmed"
              : "failed";
    const hash = lastHash ? ` ${txLink(lastHash)}` : "";
    const retry = retryable ? ` <button type="button" data-act="retry">retry</button>` : "";
    return `<p class="ticket-strip">${esc(label)}${phaseDetail ? ` · ${esc(phaseDetail)}` : ""}${hash}${retry}</p>`;
  }

  function fullHtml(): string {
    const v = validation();
    const m = market();
    const human =
      m && book
        ? `${priceOf(tick, book, overrides)} · ${formatAtoms(lots * m.lot_size, tokenDecimals(book.tokens.base, overrides.baseDec))} ${balances().baseSymbol}`
        : "";
    const sym = balances().baseSymbol;
    const busy = submitting || phase === "simulating" || phase === "signing" || phase === "sending";
    return `<section class="ticket">
      <h3>place order</h3>
      <div class="ticket-side">
        <button type="button" data-act="buy" class="${isBid ? "on bid" : ""}">BUY ${esc(sym)}</button>
        <button type="button" data-act="sell" class="${!isBid ? "on ask" : ""}">SELL ${esc(sym)}</button>
      </div>
      <div class="ticket-fields">
        <label>tick <input class="wallet-input" data-field="tick" inputmode="numeric" value="${esc(tick)}" /></label>
        <label>lots <input class="wallet-input" data-field="lots" inputmode="numeric" value="${esc(lots.toString())}" /></label>
      </div>
      <p class="wallet-muted" data-role="human">${esc(human)}</p>
      <div class="ticket-flags">
        <label class="ticket-flag" title="rest only; reject if the order would take"><input type="checkbox" data-flag="post_only" ${flags.post_only ? "checked" : ""} /> post-only</label>
        <label class="ticket-flag" title="fill completely or revert; nothing rests"><input type="checkbox" data-flag="fill_or_kill" ${flags.fill_or_kill ? "checked" : ""} /> fill-or-kill</label>
        <label class="ticket-flag" title="take what is there and refund the rest; do not rest"><input type="checkbox" data-flag="no_rest" ${flags.no_rest ? "checked" : ""} /> no-rest</label>
      </div>
      <p class="wallet-muted" data-role="why">${v.ok ? "" : esc(v.reason)}</p>
      <div data-role="preview">${previewHtml()}</div>
      <button type="button" data-act="place" class="ticket-cta ${isBid ? "bid" : "ask"}" ${!v.ok || busy ? "disabled" : ""}>${isBid ? "BUY" : "SELL"} ${esc(sym)}</button>
      <div data-role="strip">${stripHtml()}</div>
    </section>`;
  }

  function bind(root: HTMLElement): void {
    root.querySelector("[data-act=buy]")?.addEventListener("click", () => {
      isBid = true;
      schedulePreview();
      draw(root);
    });
    root.querySelector("[data-act=sell]")?.addEventListener("click", () => {
      isBid = false;
      schedulePreview();
      draw(root);
    });
    root.querySelector("[data-field=tick]")?.addEventListener("input", (e) => {
      tick = Number((e.target as HTMLInputElement).value) || 0;
      schedulePreview();
      paintChrome();
    });
    root.querySelector("[data-field=lots]")?.addEventListener("input", (e) => {
      try {
        lots = BigInt((e.target as HTMLInputElement).value || "0");
      } catch {
        lots = 0n;
      }
      schedulePreview();
      paintChrome();
    });
    root.querySelectorAll("[data-flag]").forEach((el) => {
      el.addEventListener("change", () => {
        const box = el as HTMLInputElement;
        const key = box.dataset.flag as keyof PlaceFlags;
        flags = { ...flags, [key]: box.checked };
        schedulePreview();
        paintChrome();
      });
    });
    root.querySelector("[data-act=place]")?.addEventListener("click", () => {
      void submit(false);
    });
    root.querySelector("[data-act=retry]")?.addEventListener("click", () => {
      void submit(true);
    });
  }

  function draw(root: HTMLElement): void {
    rootEl = root;
    const active = document.activeElement;
    const keep = active instanceof HTMLElement && root.contains(active) && !!root.querySelector("[data-field=tick]");
    if (keep) {
      paintChrome();
      return;
    }
    root.innerHTML = fullHtml();
    bind(root);
    if (focusQty) {
      focusQty = false;
      root.querySelector<HTMLInputElement>("[data-field=lots]")?.focus();
    }
  }

  return {
    draw,
    prefill(side, t) {
      isBid = side === "ask";
      tick = t;
      focusQty = true;
      phase = "idle";
      schedulePreview();
      if (rootEl) draw(rootEl);
    },
    setLive(nextBook, nextAccount, nextTrust, nextOverrides) {
      book = nextBook;
      account = nextAccount;
      trustlines = nextTrust;
      overrides = nextOverrides;
      if (rootEl) {
        if (tick === 1 && nextBook && !nextBook.bestAsk.empty && isBid) tick = nextBook.bestAsk.tick;
        paintChrome();
        schedulePreview();
      }
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
