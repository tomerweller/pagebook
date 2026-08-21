import type { BookSnapshot, Rpc, TokenMeta } from "../book";
import { formatAtoms, formatInt } from "../decode";
import { esc, shortAddr } from "../view/format";
import {
  parseAssetFromSacName,
  readAccount,
  readTrustlines,
  type AccountState,
  type ClassicAsset,
  type CreditAsset,
  type TrustlineState,
} from "./account";
import type { BookEvent } from "../book";
import { addTrustline, fundWithFriendbot, type SubmitResult } from "./classic";
import { Keystore, type Identity } from "./keystore";
import { checkTestnet } from "./network";
import { createOrders, loadOpenOrders, ownTicksOf, rememberNonce, sessionRestedNonces, type OpenOrder } from "./orders";
import { createTicket } from "./ticket";
import type { UrlOverrides } from "../view/format";
import type { OwnTicks } from "../view/market";

export type WalletHandle = {
  onBook(book: BookSnapshot): void;
  onEvents(events: BookEvent[]): void;
  prefillFromLadder(side: "bid" | "ask", tick: number): void;
  ownTicks(): OwnTicks;
};

type LogItem = { text: string; hash?: string };

type MarketRow = {
  symbol: string;
  decimals: number;
  classic: ClassicAsset | null;
};

const LOG_CAP = 10;

function classicFromMeta(meta: TokenMeta | null | undefined): ClassicAsset | null {
  if (!meta?.name) return null;
  try {
    return parseAssetFromSacName(meta.name);
  } catch {
    return null;
  }
}

function marketRows(book: BookSnapshot | null): MarketRow[] {
  if (!book) return [];
  const rows: MarketRow[] = [];
  const push = (meta: TokenMeta | null | undefined, fallback: string | null) => {
    const symbol = meta?.symbol || fallback || "?";
    if (rows.some((r) => r.symbol === symbol)) return;
    rows.push({
      symbol,
      decimals: meta?.decimals ?? 7,
      classic: classicFromMeta(meta),
    });
  };
  push(book.tokens.base, book.base);
  push(book.tokens.quote, book.quote);
  return rows;
}

function creditAssets(rows: MarketRow[]): CreditAsset[] {
  return rows.map((r) => r.classic).filter((a): a is CreditAsset => a != null && a.type === "credit");
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* ignore */
    }
    ta.remove();
  });
}

function txLink(hash: string): string {
  const short = `${hash.slice(0, 6)}…`;
  return `<a href="https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(hash)}">${esc(short)}</a>`;
}

function accountLink(pubkey: string): string {
  const short = esc(shortAddr(pubkey));
  return `<a href="https://stellar.expert/explorer/testnet/account/${encodeURIComponent(pubkey)}" title="${esc(pubkey)}">${short}</a>`;
}

export function mountWallet(opts: {
  el: HTMLElement;
  rpc: Rpc;
  seed: string | null;
  contract: string;
  getMarket: () => number;
  overrides: UrlOverrides;
  onRefresh: () => void;
  onOwnTicks: (ticks: OwnTicks) => void;
}): WalletHandle {
  const store = new Keystore(window.localStorage);
  const el = opts.el;
  let enabled = false;
  let booted = false;
  let book: BookSnapshot | null = null;
  let account: AccountState | null = null;
  let trustlines: TrustlineState[] = [];
  let status = "";
  let busy = false;
  let reveal = false;
  let confirmDelete = false;
  let confirmTrust: CreditAsset | null = null;
  let importOpen = false;
  let justCreated = false;
  let collapsed = window.matchMedia("(max-width: 800px)").matches;
  const log: LogItem[] = [];
  let balGen = 0;
  let sessionEvents: BookEvent[] = [];
  let openOrders: OpenOrder[] = [];
  let lastOrderLedger = -1;
  const ordersPanel = createOrders({
    rpc: opts.rpc,
    contract: opts.contract,
    getSecret: () => active()?.secret ?? null,
    getPublic: () => active()?.publicKey ?? null,
    getMarket: opts.getMarket,
    onRefresh: opts.onRefresh,
    onLog: (text, hash) => {
      pushLog({ text, hash });
      render();
    },
  });
  const ticket = createTicket({
    rpc: opts.rpc,
    contract: opts.contract,
    getSecret: () => active()?.secret ?? null,
    getPublic: () => active()?.publicKey ?? null,
    getMarket: opts.getMarket,
    onRefresh: opts.onRefresh,
    onRested: (nonce) => {
      const id = active();
      if (id) rememberNonce(id.publicKey, opts.contract, opts.getMarket(), nonce);
      void refreshOrders();
    },
    onLog: (text, hash) => {
      pushLog({ text, hash });
      render();
    },
  });

  function pushLog(item: LogItem): void {
    log.unshift(item);
    if (log.length > LOG_CAP) log.length = LOG_CAP;
  }

  function setStatus(msg: string): void {
    status = msg;
  }

  function active(): Identity | null {
    return store.active();
  }

  async function refreshOrders(): Promise<void> {
    const id = active();
    if (!enabled || !id || !account?.exists) {
      openOrders = [];
      opts.onOwnTicks({ bid: new Set(), ask: new Set() });
      return;
    }
    const extra = sessionRestedNonces(sessionEvents, id.publicKey);
    openOrders = await loadOpenOrders(
      opts.rpc,
      opts.contract,
      id.publicKey,
      account.sequence.toString(),
      opts.getMarket(),
      id.publicKey,
      extra,
      sessionEvents,
    );
    opts.onOwnTicks(ownTicksOf(openOrders));
    const box = el.querySelector<HTMLElement>("#orders-root");
    if (box) {
      ordersPanel.setLive(book, account, openOrders, opts.overrides);
      ordersPanel.draw(box);
    }
  }

  async function refreshBalances(): Promise<void> {
    const id = active();
    if (!enabled || !id) {
      account = null;
      trustlines = [];
      openOrders = [];
      render();
      return;
    }
    const gen = ++balGen;
    try {
      const acc = await readAccount(opts.rpc, id.publicKey);
      if (gen !== balGen) return;
      account = acc;
      const credits = creditAssets(marketRows(book));
      trustlines = credits.length ? await readTrustlines(opts.rpc, id.publicKey, credits) : [];
      if (gen !== balGen) return;
    } catch (e) {
      if (gen !== balGen) return;
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`RPC: ${msg}`);
    }
    render();
    void refreshOrders();
  }

  function render(): void {
    const id = active();
    const ids = store.list();
    const body = !booted
      ? `<p class="wallet-copy">checking network…</p>`
      : !enabled
        ? `<p class="wallet-copy">${esc(status || "wallet disabled: not testnet")}</p>`
        : !id
          ? emptyHtml()
          : activeHtml(id, ids);

    el.className = `wallet${collapsed ? "" : " open"}`;
      el.innerHTML = `
      <div class="wallet-head">
        <button type="button" class="wallet-toggle" data-act="toggle" aria-expanded="${collapsed ? "false" : "true"}">wallet</button>
      </div>
      <div class="wallet-body">${body}</div>`;
    bind();
    const ticketRoot = el.querySelector<HTMLElement>("#ticket-root");
    if (ticketRoot && id && enabled) {
      ticket.setLive(book, account, trustlines, opts.overrides);
      ticket.draw(ticketRoot);
    }
    const ordersRoot = el.querySelector<HTMLElement>("#orders-root");
    if (ordersRoot && id && enabled) {
      ordersPanel.setLive(book, account, openOrders, opts.overrides);
      ordersPanel.draw(ordersRoot);
    }
  }

  function emptyHtml(): string {
    return `
      <p class="wallet-copy">Keys stay in this browser and are for testnet only. Treat them as disposable.</p>
      <div class="wallet-actions">
        <button type="button" data-act="generate">generate</button>
        <button type="button" data-act="import-open">import</button>
        ${opts.seed ? `<button type="button" data-act="use-seed">use seed</button>` : ""}
      </div>
      ${
        importOpen
          ? `<form class="wallet-import" data-act="import-submit">
              <input name="secret" class="wallet-input" spellcheck="false" autocomplete="off" placeholder="S…" />
              <button type="submit">import</button>
            </form>`
          : ""
      }
      ${status ? `<p class="wallet-status">${esc(status)}</p>` : ""}`;
  }

  function activeHtml(id: Identity, ids: Identity[]): string {
    const optsHtml = ids
      .map((i) => `<option value="${esc(i.name)}"${i.name === id.name ? " selected" : ""}>${esc(i.name)}</option>`)
      .join("");
    const xlm = account
      ? account.exists
        ? `<span title="${esc(formatAtoms(account.balance, 7))} XLM total · ${formatInt(account.balance)} stroops">${esc(formatAtoms(account.spendable, 7))} XLM spendable</span>`
        : `<span>unfunded</span>`
      : `<span>…</span>`;
    const rows = marketRows(book);
    const assetHtml = rows
      .map((row) => {
        if (!row.classic) {
          return `<li><span>${esc(row.symbol)}</span><span class="wallet-muted">not a classic asset</span></li>`;
        }
        if (row.classic.type === "native") {
          const bal = account?.exists ? formatAtoms(account.balance, 7) : "—";
          return `<li><span>XLM</span><span>${esc(bal)}</span></li>`;
        }
        const credit = row.classic;
        const tl = trustlines.find((t) => t.asset.code === credit.code && t.asset.issuer === credit.issuer);
        if (!tl || !tl.exists) {
          return `<li>
            <span>${esc(credit.code)}</span>
            <span>no trustline <button type="button" data-act="trust-ask" data-code="${esc(credit.code)}" data-issuer="${esc(credit.issuer)}">add trustline</button></span>
          </li>`;
        }
        return `<li><span>${esc(credit.code)}</span><span>${esc(formatAtoms(tl.balance, row.decimals))}</span></li>`;
      })
      .join("");

    const trustAsk = confirmTrust
      ? `<div class="wallet-confirm">
          <p>${esc(confirmTrust.code)} issued by ${esc(shortAddr(confirmTrust.issuer))}. Adding a trustline locks 0.5 XLM (5,000,000 stroops) as reserve.</p>
          <div class="wallet-actions">
            <button type="button" data-act="trust-go" ${busy ? "disabled" : ""}>add trustline</button>
            <button type="button" data-act="trust-cancel">cancel</button>
          </div>
        </div>`
      : "";

    const friendbot =
      account && !account.exists
        ? `<button type="button" data-act="friendbot" ${busy ? "disabled" : ""}>friendbot</button>`
        : "";

    const secretBlock = reveal || justCreated
      ? `<div class="wallet-secret">
          <code class="wallet-input">${esc(id.secret)}</code>
          <button type="button" data-act="copy-secret">copy</button>
          <button type="button" data-act="hide-secret">hide</button>
        </div>`
      : `<button type="button" data-act="reveal">reveal secret</button>`;

    const deleteBlock = confirmDelete
      ? `<div class="wallet-confirm">
          <p>Delete this key from the browser?</p>
          <div class="wallet-actions">
            <button type="button" data-act="delete-go">delete</button>
            <button type="button" data-act="delete-cancel">cancel</button>
          </div>
        </div>`
      : `<button type="button" data-act="delete-ask">delete</button>`;

    const saveSeed = store.isEphemeralActive()
      ? `<button type="button" data-act="save-seed">save</button>`
      : "";

    const logHtml = log.length
      ? `<ol class="wallet-log">${log
          .map((item) => `<li>${esc(item.text)}${item.hash ? ` ${txLink(item.hash)}` : ""}</li>`)
          .join("")}</ol>`
      : "";

    return `
      <div class="wallet-id">
        <select data-act="switch" aria-label="identity">${optsHtml}</select>
        ${saveSeed}
      </div>
      <div class="wallet-pub">
        ${accountLink(id.publicKey)}
        <button type="button" data-act="copy-pub">copy</button>
      </div>
      <div class="wallet-xlm">${xlm}</div>
      ${friendbot}
      ${rows.length ? `<ul class="wallet-assets">${assetHtml}</ul>` : ""}
      ${trustAsk}
      <div class="wallet-actions">
        ${secretBlock}
        ${deleteBlock}
      </div>
      <div id="ticket-root"></div>
      <div id="orders-root"></div>
      ${status ? `<p class="wallet-status">${esc(status)}</p>` : ""}
      ${logHtml}`;
  }

  function bind(): void {
    el.querySelector("[data-act=toggle]")?.addEventListener("click", () => {
      collapsed = !collapsed;
      render();
    });
    el.querySelector("[data-act=generate]")?.addEventListener("click", () => {
      try {
        store.create();
        justCreated = true;
        reveal = true;
        setStatus("");
        void refreshBalances();
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
        render();
      }
    });
    el.querySelector("[data-act=import-open]")?.addEventListener("click", () => {
      importOpen = !importOpen;
      render();
    });
    el.querySelector("[data-act=use-seed]")?.addEventListener("click", () => {
      if (!opts.seed) return;
      store.activateSeed(opts.seed);
      justCreated = false;
      setStatus("");
      void refreshBalances();
    });
    const form = el.querySelector<HTMLFormElement>("[data-act=import-submit]");
    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      const raw = String(new FormData(form).get("secret") ?? "");
      try {
        store.importSecret(raw);
        importOpen = false;
        justCreated = true;
        reveal = true;
        setStatus("");
        void refreshBalances();
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
        render();
      }
    });
    el.querySelector("[data-act=switch]")?.addEventListener("change", (e) => {
      const name = (e.target as HTMLSelectElement).value;
      try {
        store.select(name);
        reveal = false;
        justCreated = false;
        confirmDelete = false;
        confirmTrust = null;
        setStatus("");
        void refreshBalances();
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
        render();
      }
    });
    el.querySelector("[data-act=save-seed]")?.addEventListener("click", () => {
      try {
        store.saveEphemeral();
        setStatus("");
        render();
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
        render();
      }
    });
    el.querySelector("[data-act=copy-pub]")?.addEventListener("click", () => {
      const id = active();
      if (id) copyText(id.publicKey);
    });
    el.querySelector("[data-act=copy-secret]")?.addEventListener("click", () => {
      const id = active();
      if (id) copyText(id.secret);
    });
    el.querySelector("[data-act=reveal]")?.addEventListener("click", () => {
      reveal = true;
      render();
    });
    el.querySelector("[data-act=hide-secret]")?.addEventListener("click", () => {
      reveal = false;
      justCreated = false;
      render();
    });
    el.querySelector("[data-act=delete-ask]")?.addEventListener("click", () => {
      confirmDelete = true;
      render();
    });
    el.querySelector("[data-act=delete-cancel]")?.addEventListener("click", () => {
      confirmDelete = false;
      render();
    });
    el.querySelector("[data-act=delete-go]")?.addEventListener("click", () => {
      const id = active();
      if (id) store.remove(id.name);
      confirmDelete = false;
      reveal = false;
      justCreated = false;
      account = null;
      trustlines = [];
      setStatus("");
      void refreshBalances();
    });
    el.querySelector("[data-act=friendbot]")?.addEventListener("click", () => {
      void runFriendbot();
    });
    el.querySelectorAll("[data-act=trust-ask]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const code = (btn as HTMLElement).dataset.code;
        const issuer = (btn as HTMLElement).dataset.issuer;
        if (!code || !issuer) return;
        confirmTrust = { type: "credit", code, issuer };
        render();
      });
    });
    el.querySelector("[data-act=trust-cancel]")?.addEventListener("click", () => {
      confirmTrust = null;
      render();
    });
    el.querySelector("[data-act=trust-go]")?.addEventListener("click", () => {
      void runTrustline();
    });
  }

  async function runFriendbot(): Promise<void> {
    const id = active();
    if (!enabled || !id || busy) return;
    busy = true;
    setStatus("funding…");
    render();
    const res = await fundWithFriendbot(id.publicKey);
    busy = false;
    noteResult("funded", res);
    await refreshBalances();
  }

  async function runTrustline(): Promise<void> {
    const id = active();
    const asset = confirmTrust;
    if (!enabled || !id || !asset || busy) return;
    busy = true;
    setStatus("submitting trustline…");
    render();
    const res = await addTrustline(opts.rpc, id.secret, asset);
    busy = false;
    confirmTrust = null;
    noteResult(`trustline ${asset.code}`, res);
    await refreshBalances();
  }

  function noteResult(label: string, res: SubmitResult): void {
    if (res.status === "SUCCESS") {
      setStatus("");
      pushLog({ text: label, hash: res.hash });
    } else if (res.status === "ALREADY_FUNDED") {
      setStatus("");
      pushLog({ text: "already funded", hash: res.hash });
    } else {
      setStatus(res.error || "failed");
      if (res.hash) pushLog({ text: `${label} failed`, hash: res.hash });
    }
  }

  async function boot(): Promise<void> {
    render();
    const net = await checkTestnet(opts.rpc);
    booted = true;
    if (!net.ok) {
      enabled = false;
      setStatus(net.reason);
      render();
      return;
    }
    enabled = true;
    if (opts.seed) store.activateSeed(opts.seed);
    setStatus("");
    await refreshBalances();
  }

  void boot();

  return {
    onBook(next) {
      const ledgerChanged = next.latestLedger !== lastOrderLedger;
      book = next;
      if (ledgerChanged) lastOrderLedger = next.latestLedger;
      if (enabled && active()) {
        if (ledgerChanged) void refreshBalances();
        else {
          ticket.setLive(book, account, trustlines, opts.overrides);
          const ticketRoot = el.querySelector<HTMLElement>("#ticket-root");
          if (ticketRoot) ticket.draw(ticketRoot);
        }
      } else render();
    },
    onEvents(events) {
      sessionEvents = events;
    },
    prefillFromLadder(side, tick) {
      if (!enabled || !active()) return;
      ticket.prefill(side, tick);
    },
    ownTicks() {
      return ownTicksOf(openOrders);
    },
  };
}
