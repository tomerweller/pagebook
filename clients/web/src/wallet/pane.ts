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
import { missingCredits, planProvision, type ProvisionSource } from "./provision";
import { checkTestnet } from "./network";
import { createOrders, loadOpenOrders, ownTicksOf, rememberNonce, sessionRestedNonces, type OpenOrder } from "./orders";
import { createTicket } from "./ticket";
import type { UrlOverrides } from "../view/format";
import type { OwnTicks } from "../view/market";
import { MarkupCache, setText } from "../view/stable";

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

function creditsReady(book: BookSnapshot | null): CreditAsset[] | null {
  if (!book) return null;
  if ((book.base && !book.tokens.base?.name) || (book.quote && !book.tokens.quote?.name)) return null;
  const rows = marketRows(book);
  if (!rows.length) return null;
  return creditAssets(rows);
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
  let keysOpen = false;
  let justCreated = false;
  let autoSource: ProvisionSource | null = null;
  let provisionStatus = "";
  let provisioning = false;
  const provisionedKeys = new Set<string>();
  const narrowMq = window.matchMedia("(max-width: 960px)");
  let collapsed = narrowMq.matches;
  narrowMq.addEventListener("change", (e) => {
    collapsed = e.matches;
    render();
  });
  const log: LogItem[] = [];
  let balGen = 0;
  let sessionEvents: BookEvent[] = [];
  let openOrders: OpenOrder[] = [];
  let lastOrderLedger = -1;
  const cache = new MarkupCache();
  let shellReady = false;
  let bound = false;
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
    paintOrders();
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
    void maybeProvision();
  }

  function ensureShell(): void {
    if (shellReady) return;
    el.innerHTML = `
      <div data-sec="brand"></div>
      <div data-sec="head"></div>
      <div class="wallet-body">
        <div data-sec="identity"></div>
        <div data-sec="balances"></div>
        <div data-sec="ticket" id="ticket-root"></div>
        <div data-sec="orders" id="orders-root"></div>
        <div data-sec="keys"></div>
        <div data-sec="status"></div>
        <div data-sec="log"></div>
      </div>`;
    shellReady = true;
    if (!bound) {
      bind();
      bound = true;
    }
  }

  function sec(name: string): HTMLElement | null {
    return el.querySelector(`[data-sec="${name}"]`);
  }

  function write(name: string, html: string): "skip" | "html" | "patch" {
    return cache.write(name, sec(name), html);
  }

  function paintTicket(): void {
    const id = active();
    const box = el.querySelector<HTMLElement>("#ticket-root");
    if (!box || !id || !enabled) return;
    ticket.setLive(book, account, trustlines, opts.overrides);
    if (!box.querySelector(".ticket")) ticket.draw(box);
  }

  function paintOrders(): void {
    const id = active();
    const box = el.querySelector<HTMLElement>("#orders-root");
    if (!box || !id || !enabled) return;
    ordersPanel.setLive(book, account, openOrders, opts.overrides);
    ordersPanel.draw(box);
  }

  function render(): void {
    ensureShell();
    const cls = `wallet${collapsed ? "" : " open"}`;
    if (el.className !== cls) el.className = cls;
    const id = active();
    const ids = store.list();
    write("brand", `<div class="wallet-brand"><a href="../" class="wallet-brand-name">PAGEBOOK</a> <span class="wallet-brand-sub">· STELLAR TESTNET</span></div>`);
    write(
      "head",
      `<div class="wallet-head"><button type="button" class="wallet-toggle" data-act="toggle" aria-expanded="${collapsed ? "false" : "true"}">wallet</button></div>`,
    );
    if (!booted) {
      write("identity", `<p class="wallet-copy">— checking network</p>`);
      write("balances", "");
      write("keys", "");
      write("status", "");
      write("log", "");
      return;
    }
    if (!enabled) {
      write("identity", `<p class="wallet-copy">${esc(status || "wallet disabled: not testnet")}</p>`);
      write("balances", "");
      write("keys", "");
      write("status", "");
      write("log", "");
      return;
    }
    if (!id) {
      write("identity", emptyHtml());
      write("balances", "");
      write("keys", "");
      write("status", status ? `<p class="wallet-status">${esc(status)}</p>` : "");
      write("log", "");
      return;
    }
    write("identity", identityHtml(id, ids));
    const balAction = write("balances", balancesHtml());
    if (balAction === "patch") patchBalances();
    write("keys", keysHtml(id));
    write("status", status ? `<p class="wallet-status">${esc(status)}</p>` : "");
    write("log", logHtml());
    paintTicket();
    paintOrders();
  }

  function patchBalances(): void {
    const node = sec("balances");
    if (!node || !account?.exists) return;
    setText(node.querySelector("[data-live=xlm]"), `${formatAtoms(account.spendable, 7)} XLM spendable`);
    for (const row of marketRows(book)) {
      if (!row.classic) continue;
      if (row.classic.type === "native") {
        setText(node.querySelector("[data-live=XLM]"), formatAtoms(account.balance, 7));
        continue;
      }
      const credit = row.classic;
      const tl = trustlines.find((t) => t.asset.code === credit.code && t.asset.issuer === credit.issuer);
      if (tl?.exists) setText(node.querySelector(`[data-live="${credit.code}"]`), formatAtoms(tl.balance, row.decimals));
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

  function identityHtml(id: Identity, ids: Identity[]): string {
    const optsHtml = ids
      .map((i) => `<option value="${esc(i.name)}"${i.name === id.name ? " selected" : ""}>${esc(i.name)}</option>`)
      .join("");
    return `
      <div class="wallet-id">
        <select data-act="switch" aria-label="identity">${optsHtml}</select>
      </div>
      <div class="wallet-pub">
        ${accountLink(id.publicKey)}
        <button type="button" data-act="copy-pub">copy</button>
      </div>`;
  }

  function balancesHtml(): string {
    const xlm = account
      ? account.exists
        ? `<span data-live="xlm" title="${esc(formatAtoms(account.balance, 7))} XLM total · ${formatInt(account.balance)} stroops">${esc(formatAtoms(account.spendable, 7))} XLM spendable</span>`
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
          return `<li><span>XLM</span><span data-live="XLM">${esc(bal)}</span></li>`;
        }
        const credit = row.classic;
        const tl = trustlines.find((t) => t.asset.code === credit.code && t.asset.issuer === credit.issuer);
        if (!tl || !tl.exists) {
          return `<li>
            <span>${esc(credit.code)}</span>
            <span>no trustline <button type="button" data-act="trust-ask" data-code="${esc(credit.code)}" data-issuer="${esc(credit.issuer)}">add trustline</button></span>
          </li>`;
        }
        return `<li><span>${esc(credit.code)}</span><span data-live="${esc(credit.code)}">${esc(formatAtoms(tl.balance, row.decimals))}</span></li>`;
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
    const friendbot = provisionStatus
      ? `<p class="wallet-muted" data-role="provision">${esc(provisionStatus)}</p>`
      : account && !account.exists
        ? `<button type="button" data-act="friendbot" ${busy ? "disabled" : ""}>friendbot</button>`
        : "";
    return `<div class="wallet-xlm">${xlm}</div>${friendbot}${rows.length ? `<ul class="wallet-assets">${assetHtml}</ul>` : ""}${trustAsk}`;
  }

  function keysHtml(id: Identity): string {
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
    const saveSeed = store.isEphemeralActive() ? `<button type="button" data-act="save-seed">save</button>` : "";
    const keysShown = keysOpen || reveal || justCreated || confirmDelete || importOpen;
    const importForm = importOpen
      ? `<form class="wallet-import" data-act="import-submit">
          <input name="secret" class="wallet-input" spellcheck="false" autocomplete="off" placeholder="S…" />
          <button type="submit">import</button>
        </form>`
      : "";
    return `<details class="wallet-keys"${keysShown ? " open" : ""}>
        <summary>keys</summary>
        <div class="wallet-actions">
          ${saveSeed}
          <button type="button" data-act="import-open">import</button>
          ${secretBlock}
          ${deleteBlock}
        </div>
        ${importForm}
      </details>`;
  }

  function logHtml(): string {
    if (!log.length) return "";
    return `<ol class="wallet-log">${log
      .map((item) => `<li>${esc(item.text)}${item.hash ? ` ${txLink(item.hash)}` : ""}</li>`)
      .join("")}</ol>`;
  }

  function bind(): void {
    el.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
      if (!t || !el.contains(t)) return;
      const act = t.dataset.act;
      if (act === "toggle") {
        collapsed = !collapsed;
        render();
      } else if (act === "generate") {
        try {
          store.create();
          justCreated = true;
          reveal = true;
          autoSource = "generate";
          setStatus("");
          void refreshBalances();
        } catch (err) {
          setStatus(err instanceof Error ? err.message : String(err));
          render();
        }
      } else if (act === "import-open") {
        importOpen = !importOpen;
        render();
      } else if (act === "use-seed") {
        if (!opts.seed) return;
        store.activateSeed(opts.seed);
        justCreated = false;
        autoSource = "seed";
        setStatus("");
        void refreshBalances();
      } else if (act === "save-seed") {
        try {
          store.saveEphemeral();
          setStatus("");
          render();
        } catch (err) {
          setStatus(err instanceof Error ? err.message : String(err));
          render();
        }
      } else if (act === "copy-pub") {
        const id = active();
        if (id) copyText(id.publicKey);
      } else if (act === "copy-secret") {
        const id = active();
        if (id) copyText(id.secret);
      } else if (act === "reveal") {
        reveal = true;
        render();
      } else if (act === "hide-secret") {
        reveal = false;
        justCreated = false;
        render();
      } else if (act === "delete-ask") {
        confirmDelete = true;
        render();
      } else if (act === "delete-cancel") {
        confirmDelete = false;
        render();
      } else if (act === "delete-go") {
        const id = active();
        if (id) store.remove(id.name);
        confirmDelete = false;
        reveal = false;
        justCreated = false;
        account = null;
        trustlines = [];
        setStatus("");
        void refreshBalances();
      } else if (act === "friendbot") {
        void runFriendbot();
      } else if (act === "trust-ask") {
        const code = t.dataset.code;
        const issuer = t.dataset.issuer;
        if (!code || !issuer) return;
        confirmTrust = { type: "credit", code, issuer };
        render();
      } else if (act === "trust-cancel") {
        confirmTrust = null;
        render();
      } else if (act === "trust-go") {
        void runTrustline();
      }
    });
    el.addEventListener("change", (e) => {
      const t = e.target as HTMLSelectElement;
      if (t.dataset.act !== "switch") return;
      try {
        store.select(t.value);
        reveal = false;
        justCreated = false;
        confirmDelete = false;
        confirmTrust = null;
        autoSource = null;
        setStatus("");
        void refreshBalances();
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
        render();
      }
    });
    el.addEventListener("submit", (e) => {
      const form = (e.target as HTMLElement).closest("form[data-act=import-submit]") as HTMLFormElement | null;
      if (!form) return;
      e.preventDefault();
      const raw = String(new FormData(form).get("secret") ?? "");
      try {
        store.importSecret(raw);
        importOpen = false;
        justCreated = true;
        reveal = true;
        autoSource = "import";
        setStatus("");
        void refreshBalances();
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
        render();
      }
    });
    el.addEventListener("toggle", (e) => {
      const d = e.target as HTMLDetailsElement;
      if (d.classList?.contains("wallet-keys")) keysOpen = d.open;
    }, true);
  }

  async function waitAccountExists(pub: string): Promise<boolean> {
    for (let i = 0; i < 16; i++) {
      const acc = await readAccount(opts.rpc, pub);
      if (acc.exists) {
        account = acc;
        return true;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }

  async function addTrustlineRetry(secret: string, asset: CreditAsset): Promise<SubmitResult> {
    let last: SubmitResult = { status: "FAILED", error: "account not funded" };
    for (let i = 0; i < 8; i++) {
      last = await addTrustline(opts.rpc, secret, asset);
      if (last.status !== "FAILED" || !/not funded/i.test(last.error || "")) return last;
      await new Promise((r) => setTimeout(r, 400));
    }
    return last;
  }

  async function maybeProvision(): Promise<void> {
    const id = active();
    if (!enabled || !id || !autoSource || autoSource === "import" || !account) return;
    if (provisioning || busy || provisionedKeys.has(id.publicKey)) return;
    const credits = creditsReady(book);
    if (credits == null && account.exists) return;
    const missing = missingCredits(credits ?? [], trustlines);
    const plan = planProvision({ source: autoSource, accountExists: account.exists, missing });
    if (!plan.length) {
      if (credits != null) provisionedKeys.add(id.publicKey);
      return;
    }
    provisioning = true;
    busy = true;
    let failed = false;
    for (const step of plan) {
      if (step.op === "fund") {
        provisionStatus = "funding…";
        setStatus("");
        render();
        const res = await fundWithFriendbot(id.publicKey);
        noteResult("funded", res);
        if (res.status === "FAILED") {
          failed = true;
          break;
        }
        if (!(await waitAccountExists(id.publicKey))) {
          failed = true;
          setStatus("account not funded");
          break;
        }
      } else {
        provisionStatus = `adding ${step.asset.code} trustline…`;
        setStatus("");
        render();
        const res = await addTrustlineRetry(id.secret, step.asset);
        noteResult(`trustline ${step.asset.code} · 0.5 XLM reserve (5,000,000 stroops)`, res);
        if (res.status === "FAILED") {
          failed = true;
          break;
        }
      }
    }
    if (failed || credits != null) provisionedKeys.add(id.publicKey);
    provisioning = false;
    busy = false;
    provisionStatus = "";
    await refreshBalances();
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
      pushLog({ text: `${label} failed`, hash: res.hash });
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
    if (opts.seed) {
      store.activateSeed(opts.seed);
      autoSource = "seed";
    }
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
        else paintTicket();
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
