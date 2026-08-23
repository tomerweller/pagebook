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
import { addTrustline, fundWithFriendbot, type SubmitResult } from "./classic";
import { Keystore, type Identity } from "./keystore";
import { missingCredits, planProvision, type ProvisionSource } from "./provision";
import { checkTestnet } from "./network";
import { createOrders, loadOpenOrders, ownTicksOf, rememberNonce, sessionRestedNonces, type OpenOrder } from "./orders";
import { createTicket } from "./ticket";
import type { AppState } from "../view/market";
import type { Store } from "../store";
import { MarkupCache, setAttr } from "../view/stable";

export type WalletHandle = {
  prefillFromLadder(side: "bid" | "ask", tick: number): void;
};

export type LogItem = { text: string; hash?: string };

export type WalletDomain = {
  booted: boolean;
  enabled: boolean;
  status: string;
  busy: boolean;
  reveal: boolean;
  confirmDelete: boolean;
  confirmTrust: CreditAsset | null;
  importOpen: boolean;
  keysOpen: boolean;
  justCreated: boolean;
  autoSource: ProvisionSource | null;
  provisionStatus: string;
  provisioning: boolean;
  provisionedKeys: Set<string>;
  collapsed: boolean;
  log: LogItem[];
  account: AccountState | null;
  trustlines: TrustlineState[];
  openOrders: OpenOrder[];
  identities: Identity[];
  active: Identity | null;
  ephemeral: boolean;
  seed: string | null;
};

type MarketRow = {
  symbol: string;
  decimals: number;
  classic: ClassicAsset | null;
};

const LOG_CAP = 10;

export function emptyWalletDomain(seed: string | null, collapsed = false): WalletDomain {
  return {
    booted: false,
    enabled: false,
    status: "",
    busy: false,
    reveal: false,
    confirmDelete: false,
    confirmTrust: null,
    importOpen: false,
    keysOpen: false,
    justCreated: false,
    autoSource: null,
    provisionStatus: "",
    provisioning: false,
    provisionedKeys: new Set(),
    collapsed,
    log: [],
    account: null,
    trustlines: [],
    openOrders: [],
    identities: [],
    active: null,
    ephemeral: false,
    seed,
  };
}

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

function pushLogInto(s: AppState, item: LogItem): void {
  s.wallet.log.unshift(item);
  if (s.wallet.log.length > LOG_CAP) s.wallet.log.length = LOG_CAP;
}

function syncIdentity(s: AppState, ks: Keystore): void {
  s.wallet.identities = ks.list();
  s.wallet.active = ks.active();
  s.wallet.ephemeral = ks.isEphemeralActive();
}

function walletKey(s: AppState): string {
  const w = s.wallet;
  const b = s.book;
  const snap = b.snapshot;
  return [
    w.booted,
    w.enabled,
    w.status,
    w.busy,
    w.reveal,
    w.confirmDelete,
    w.confirmTrust?.code,
    w.confirmTrust?.issuer,
    w.importOpen,
    w.keysOpen,
    w.justCreated,
    w.autoSource,
    w.provisionStatus,
    w.provisioning,
    w.collapsed,
    w.log.length,
    w.log[0]?.text,
    w.log[0]?.hash,
    w.account?.exists,
    w.account?.balance,
    w.account?.spendable,
    w.account?.sequence,
    w.trustlines.map((t) => `${t.asset.code}:${t.exists}:${t.balance}`).join(","),
    w.openOrders.map((o) => `${o.nonce}:${o.tick}:${o.qtyLots}:${o.filledLots}:${o.archived}`).join(","),
    w.active?.name,
    w.active?.publicKey,
    w.identities.length,
    w.ephemeral,
    snap?.latestLedger,
    snap?.bestBid.tick,
    snap?.bestBid.empty,
    snap?.bestAsk.tick,
    snap?.bestAsk.empty,
    snap?.bids[0]?.open_lots,
    snap?.asks[0]?.open_lots,
    snap?.tokens.base?.symbol,
    snap?.tokens.quote?.symbol,
    b.overrides.baseSym,
    b.overrides.quoteSym,
    b.eventState.events.length,
    b.eventState.events[0]?.id,
  ].join("|");
}

export function mountWallet(opts: {
  store: Store<AppState>;
  el: HTMLElement;
  rpc: Rpc;
  getMarket: () => number;
  onRefresh: () => void;
}): WalletHandle {
  const app = opts.store;
  const ks = new Keystore(window.localStorage);
  const el = opts.el;
  let balGen = 0;
  let lastSeenLedger = -1;
  let shellReady = false;
  let bound = false;
  const cache = new MarkupCache();
  const ordersPanel = createOrders({
    rpc: opts.rpc,
    contract: app.read().book.contract,
    getSecret: () => app.read().wallet.active?.secret ?? null,
    getPublic: () => app.read().wallet.active?.publicKey ?? null,
    getMarket: opts.getMarket,
    onRefresh: opts.onRefresh,
    onLog: (text, hash) => {
      app.update((s) => {
        pushLogInto(s, { text, hash });
      });
    },
  });
  const ticket = createTicket({
    rpc: opts.rpc,
    contract: app.read().book.contract,
    getSecret: () => app.read().wallet.active?.secret ?? null,
    getPublic: () => app.read().wallet.active?.publicKey ?? null,
    getMarket: opts.getMarket,
    onRefresh: opts.onRefresh,
    onRested: (nonce) => {
      const id = app.read().wallet.active;
      if (id) rememberNonce(id.publicKey, app.read().book.contract, opts.getMarket(), nonce);
      void refreshOrders();
    },
    onLog: (text, hash) => {
      app.update((s) => {
        pushLogInto(s, { text, hash });
      });
    },
  });

  if (typeof window.matchMedia === "function") {
    const narrowMq = window.matchMedia("(max-width: 960px)");
    const onNarrow = (matches: boolean) => {
      app.update((s) => {
        s.wallet.collapsed = matches;
      });
    };
    if (typeof narrowMq.addEventListener === "function") {
      narrowMq.addEventListener("change", (e) => onNarrow(e.matches));
    }
  }

  async function refreshOrders(): Promise<void> {
    const w = app.read().wallet;
    const id = w.active;
    if (!w.enabled || !id || !w.account?.exists) {
      app.update((s) => {
        s.wallet.openOrders = [];
        s.book.ownTicks = { bid: new Set(), ask: new Set() };
      });
      return;
    }
    const events = app.read().book.eventState.events;
    const extra = sessionRestedNonces(events, id.publicKey);
    const openOrders = await loadOpenOrders(
      opts.rpc,
      app.read().book.contract,
      id.publicKey,
      w.account.sequence.toString(),
      opts.getMarket(),
      id.publicKey,
      extra,
      events,
    );
    app.update((s) => {
      s.wallet.openOrders = openOrders;
      s.book.ownTicks = ownTicksOf(openOrders);
    });
  }

  async function refreshBalances(): Promise<void> {
    const w = app.read().wallet;
    const id = w.active;
    if (!w.enabled || !id) {
      app.update((s) => {
        s.wallet.account = null;
        s.wallet.trustlines = [];
        s.wallet.openOrders = [];
      });
      return;
    }
    const gen = ++balGen;
    try {
      const acc = await readAccount(opts.rpc, id.publicKey);
      if (gen !== balGen) return;
      const credits = creditAssets(marketRows(app.read().book.snapshot));
      const trustlines = credits.length ? await readTrustlines(opts.rpc, id.publicKey, credits) : [];
      if (gen !== balGen) return;
      app.update((s) => {
        s.wallet.account = acc;
        s.wallet.trustlines = trustlines;
      });
    } catch (e) {
      if (gen !== balGen) return;
      const msg = e instanceof Error ? e.message : String(e);
      app.update((s) => {
        s.wallet.status = `RPC: ${msg}`;
      });
    }
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
    const { wallet, book } = app.read();
    const box = el.querySelector<HTMLElement>("#ticket-root");
    if (!box || !wallet.active || !wallet.enabled) return;
    ticket.setLive(book.snapshot, wallet.account, wallet.trustlines, book.overrides);
    if (!box.querySelector(".ticket")) ticket.draw(box);
  }

  function paintOrders(): void {
    const { wallet, book } = app.read();
    const box = el.querySelector<HTMLElement>("#orders-root");
    if (!box || !wallet.active || !wallet.enabled) return;
    ordersPanel.setLive(book.snapshot, wallet.account, wallet.openOrders, book.overrides);
    ordersPanel.draw(box);
  }

  function renderWallet(): void {
    ensureShell();
    const w = app.read().wallet;
    const cls = `wallet${w.collapsed ? "" : " open"}`;
    if (el.className !== cls) el.className = cls;
    write(
      "brand",
      `<div class="wallet-brand"><a href="../" class="wallet-brand-name">PAGEBOOK</a> <span class="wallet-brand-sub">· STELLAR TESTNET</span></div>`,
    );
    const headHtml = `<div class="wallet-head"><button type="button" class="wallet-toggle" data-act="toggle" aria-expanded="${w.collapsed ? "false" : "true"}">wallet</button></div>`;
    const headAction = write("head", headHtml);
    if (headAction === "patch") {
      const head = sec("head");
      setAttr(head ? head.querySelector("[data-act=toggle]") : null, "aria-expanded", w.collapsed ? "false" : "true");
      cache.patched("head", head);
    }
    const id = w.active;
    if (!w.booted) {
      write("identity", `<p class="wallet-copy">— checking network</p>`);
      write("balances", "");
      write("keys", "");
      write("status", "");
      write("log", "");
      return;
    }
    if (!w.enabled) {
      write("identity", `<p class="wallet-copy">${esc(w.status || "wallet disabled: not testnet")}</p>`);
      write("balances", "");
      write("keys", "");
      write("status", "");
      write("log", "");
      return;
    }
    if (!id) {
      write("identity", emptyHtml(w));
      write("balances", "");
      write("keys", "");
      write("status", w.status ? `<p class="wallet-status">${esc(w.status)}</p>` : "");
      write("log", "");
      return;
    }
    write("identity", identityHtml(id, w.identities));
    write("balances", balancesHtml(w, app.read().book.snapshot));
    write("keys", keysHtml(id, w));
    write("status", w.status ? `<p class="wallet-status">${esc(w.status)}</p>` : "");
    write("log", logHtml(w.log));
    paintTicket();
    paintOrders();
  }

  function emptyHtml(w: WalletDomain): string {
    return `
      <p class="wallet-copy">Keys stay in this browser and are for testnet only. Treat them as disposable.</p>
      <div class="wallet-actions">
        <button type="button" data-act="generate">generate</button>
        <button type="button" data-act="import-open">import</button>
        ${w.seed ? `<button type="button" data-act="use-seed">use seed</button>` : ""}
      </div>
      ${
        w.importOpen
          ? `<form class="wallet-import" data-act="import-submit">
              <input name="secret" class="wallet-input" spellcheck="false" autocomplete="off" placeholder="S…" />
              <button type="submit">import</button>
            </form>`
          : ""
      }
      ${w.status ? `<p class="wallet-status">${esc(w.status)}</p>` : ""}`;
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

  function balancesHtml(w: WalletDomain, book: BookSnapshot | null): string {
    const account = w.account;
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
        const tl = w.trustlines.find((t) => t.asset.code === credit.code && t.asset.issuer === credit.issuer);
        if (!tl || !tl.exists) {
          return `<li>
            <span>${esc(credit.code)}</span>
            <span>no trustline <button type="button" data-act="trust-ask" data-code="${esc(credit.code)}" data-issuer="${esc(credit.issuer)}">add trustline</button></span>
          </li>`;
        }
        return `<li><span>${esc(credit.code)}</span><span data-live="${esc(credit.code)}">${esc(formatAtoms(tl.balance, row.decimals))}</span></li>`;
      })
      .join("");
    const trustAsk = w.confirmTrust
      ? `<div class="wallet-confirm">
          <p>${esc(w.confirmTrust.code)} issued by ${esc(shortAddr(w.confirmTrust.issuer))}. Adding a trustline locks 0.5 XLM (5,000,000 stroops) as reserve.</p>
          <div class="wallet-actions">
            <button type="button" data-act="trust-go" ${w.busy ? "disabled" : ""}>add trustline</button>
            <button type="button" data-act="trust-cancel">cancel</button>
          </div>
        </div>`
      : "";
    const friendbot = w.provisionStatus
      ? `<p class="wallet-muted" data-role="provision">${esc(w.provisionStatus)}</p>`
      : account && !account.exists
        ? `<button type="button" data-act="friendbot" ${w.busy ? "disabled" : ""}>friendbot</button>`
        : "";
    return `<div class="wallet-xlm">${xlm}</div>${friendbot}${rows.length ? `<ul class="wallet-assets">${assetHtml}</ul>` : ""}${trustAsk}`;
  }

  function keysHtml(id: Identity, w: WalletDomain): string {
    const secretBlock =
      w.reveal || w.justCreated
        ? `<div class="wallet-secret">
          <code class="wallet-input">${esc(id.secret)}</code>
          <button type="button" data-act="copy-secret">copy</button>
          <button type="button" data-act="hide-secret">hide</button>
        </div>`
        : `<button type="button" data-act="reveal">reveal secret</button>`;
    const deleteBlock = w.confirmDelete
      ? `<div class="wallet-confirm">
          <p>Delete this key from the browser?</p>
          <div class="wallet-actions">
            <button type="button" data-act="delete-go">delete</button>
            <button type="button" data-act="delete-cancel">cancel</button>
          </div>
        </div>`
      : `<button type="button" data-act="delete-ask">delete</button>`;
    const saveSeed = w.ephemeral ? `<button type="button" data-act="save-seed">save</button>` : "";
    const keysShown = w.keysOpen || w.reveal || w.justCreated || w.confirmDelete || w.importOpen;
    const importForm = w.importOpen
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

  function logHtml(log: LogItem[]): string {
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
        app.update((s) => {
          s.wallet.collapsed = !s.wallet.collapsed;
        });
      } else if (act === "generate") {
        try {
          ks.create();
          app.update((s) => {
            syncIdentity(s, ks);
            s.wallet.justCreated = true;
            s.wallet.reveal = true;
            s.wallet.autoSource = "generate";
            s.wallet.status = "";
          });
          void refreshBalances();
        } catch (err) {
          app.update((s) => {
            s.wallet.status = err instanceof Error ? err.message : String(err);
          });
        }
      } else if (act === "import-open") {
        app.update((s) => {
          s.wallet.importOpen = !s.wallet.importOpen;
        });
      } else if (act === "use-seed") {
        const seed = app.read().wallet.seed;
        if (!seed) return;
        ks.activateSeed(seed);
        app.update((s) => {
          syncIdentity(s, ks);
          s.wallet.justCreated = false;
          s.wallet.autoSource = "seed";
          s.wallet.status = "";
        });
        void refreshBalances();
      } else if (act === "save-seed") {
        try {
          ks.saveEphemeral();
          app.update((s) => {
            syncIdentity(s, ks);
            s.wallet.status = "";
          });
        } catch (err) {
          app.update((s) => {
            s.wallet.status = err instanceof Error ? err.message : String(err);
          });
        }
      } else if (act === "copy-pub") {
        const id = app.read().wallet.active;
        if (id) copyText(id.publicKey);
      } else if (act === "copy-secret") {
        const id = app.read().wallet.active;
        if (id) copyText(id.secret);
      } else if (act === "reveal") {
        app.update((s) => {
          s.wallet.reveal = true;
        });
      } else if (act === "hide-secret") {
        app.update((s) => {
          s.wallet.reveal = false;
          s.wallet.justCreated = false;
        });
      } else if (act === "delete-ask") {
        app.update((s) => {
          s.wallet.confirmDelete = true;
        });
      } else if (act === "delete-cancel") {
        app.update((s) => {
          s.wallet.confirmDelete = false;
        });
      } else if (act === "delete-go") {
        const id = app.read().wallet.active;
        if (id) ks.remove(id.name);
        app.update((s) => {
          syncIdentity(s, ks);
          s.wallet.confirmDelete = false;
          s.wallet.reveal = false;
          s.wallet.justCreated = false;
          s.wallet.account = null;
          s.wallet.trustlines = [];
          s.wallet.status = "";
        });
        void refreshBalances();
      } else if (act === "friendbot") {
        void runFriendbot();
      } else if (act === "trust-ask") {
        const code = t.dataset.code;
        const issuer = t.dataset.issuer;
        if (!code || !issuer) return;
        app.update((s) => {
          s.wallet.confirmTrust = { type: "credit", code, issuer };
        });
      } else if (act === "trust-cancel") {
        app.update((s) => {
          s.wallet.confirmTrust = null;
        });
      } else if (act === "trust-go") {
        void runTrustline();
      }
    });
    el.addEventListener("change", (e) => {
      const t = e.target as HTMLSelectElement;
      if (t.dataset.act !== "switch") return;
      try {
        ks.select(t.value);
        app.update((s) => {
          syncIdentity(s, ks);
          s.wallet.reveal = false;
          s.wallet.justCreated = false;
          s.wallet.confirmDelete = false;
          s.wallet.confirmTrust = null;
          s.wallet.autoSource = null;
          s.wallet.status = "";
        });
        void refreshBalances();
      } catch (err) {
        app.update((s) => {
          s.wallet.status = err instanceof Error ? err.message : String(err);
        });
      }
    });
    el.addEventListener("submit", (e) => {
      const form = (e.target as HTMLElement).closest("form[data-act=import-submit]") as HTMLFormElement | null;
      if (!form) return;
      e.preventDefault();
      const raw = String(new FormData(form).get("secret") ?? "");
      try {
        ks.importSecret(raw);
        app.update((s) => {
          syncIdentity(s, ks);
          s.wallet.importOpen = false;
          s.wallet.justCreated = true;
          s.wallet.reveal = true;
          s.wallet.autoSource = "import";
          s.wallet.status = "";
        });
        void refreshBalances();
      } catch (err) {
        app.update((s) => {
          s.wallet.status = err instanceof Error ? err.message : String(err);
        });
      }
    });
    el.addEventListener(
      "toggle",
      (e) => {
        const d = e.target as HTMLDetailsElement;
        if (!d.classList?.contains("wallet-keys")) return;
        app.update((s) => {
          s.wallet.keysOpen = d.open;
        });
      },
      true,
    );
  }

  async function waitAccountExists(pub: string): Promise<boolean> {
    for (let i = 0; i < 16; i++) {
      const acc = await readAccount(opts.rpc, pub);
      if (acc.exists) {
        app.update((s) => {
          s.wallet.account = acc;
        });
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
    const { wallet: w, book } = app.read();
    const id = w.active;
    if (!w.enabled || !id || !w.autoSource || w.autoSource === "import" || !w.account) return;
    if (w.provisioning || w.busy || w.provisionedKeys.has(id.publicKey)) return;
    const credits = creditsReady(book.snapshot);
    if (credits == null && w.account.exists) return;
    const missing = missingCredits(credits ?? [], w.trustlines);
    const plan = planProvision({ source: w.autoSource, accountExists: w.account.exists, missing });
    if (!plan.length) {
      if (credits != null) {
        app.update((s) => {
          s.wallet.provisionedKeys.add(id.publicKey);
        });
      }
      return;
    }
    app.update((s) => {
      s.wallet.provisioning = true;
      s.wallet.busy = true;
    });
    let failed = false;
    for (const step of plan) {
      if (step.op === "fund") {
        app.update((s) => {
          s.wallet.provisionStatus = "funding…";
          s.wallet.status = "";
        });
        const res = await fundWithFriendbot(id.publicKey);
        noteResult("funded", res);
        if (res.status === "FAILED") {
          failed = true;
          break;
        }
        if (!(await waitAccountExists(id.publicKey))) {
          failed = true;
          app.update((s) => {
            s.wallet.status = "account not funded";
          });
          break;
        }
      } else {
        app.update((s) => {
          s.wallet.provisionStatus = `adding ${step.asset.code} trustline…`;
          s.wallet.status = "";
        });
        const res = await addTrustlineRetry(id.secret, step.asset);
        noteResult(`trustline ${step.asset.code} · 0.5 XLM reserve (5,000,000 stroops)`, res);
        if (res.status === "FAILED") {
          failed = true;
          break;
        }
      }
    }
    app.update((s) => {
      if (failed || credits != null) s.wallet.provisionedKeys.add(id.publicKey);
      s.wallet.provisioning = false;
      s.wallet.busy = false;
      s.wallet.provisionStatus = "";
    });
    await refreshBalances();
  }

  async function runFriendbot(): Promise<void> {
    const w = app.read().wallet;
    const id = w.active;
    if (!w.enabled || !id || w.busy) return;
    app.update((s) => {
      s.wallet.busy = true;
      s.wallet.status = "funding…";
    });
    const res = await fundWithFriendbot(id.publicKey);
    app.update((s) => {
      s.wallet.busy = false;
    });
    noteResult("funded", res);
    await refreshBalances();
  }

  async function runTrustline(): Promise<void> {
    const w = app.read().wallet;
    const id = w.active;
    const asset = w.confirmTrust;
    if (!w.enabled || !id || !asset || w.busy) return;
    app.update((s) => {
      s.wallet.busy = true;
      s.wallet.status = "submitting trustline…";
    });
    const res = await addTrustline(opts.rpc, id.secret, asset);
    app.update((s) => {
      s.wallet.busy = false;
      s.wallet.confirmTrust = null;
    });
    noteResult(`trustline ${asset.code}`, res);
    await refreshBalances();
  }

  function noteResult(label: string, res: SubmitResult): void {
    app.update((s) => {
      if (res.status === "SUCCESS") {
        s.wallet.status = "";
        pushLogInto(s, { text: label, hash: res.hash });
      } else if (res.status === "ALREADY_FUNDED") {
        s.wallet.status = "";
        pushLogInto(s, { text: "already funded", hash: res.hash });
      } else {
        s.wallet.status = res.error || "failed";
        pushLogInto(s, { text: `${label} failed`, hash: res.hash });
      }
    });
  }

  function maybeRefreshOnLedger(): void {
    const snap = app.read().book.snapshot;
    const w = app.read().wallet;
    if (!snap || snap.latestLedger === lastSeenLedger) return;
    lastSeenLedger = snap.latestLedger;
    if (w.enabled && w.active) void refreshBalances();
  }

  async function boot(): Promise<void> {
    const net = await checkTestnet(opts.rpc);
    app.update((s) => {
      s.wallet.booted = true;
      if (!net.ok) {
        s.wallet.enabled = false;
        s.wallet.status = net.reason;
        return;
      }
      s.wallet.enabled = true;
      if (s.wallet.seed) {
        ks.activateSeed(s.wallet.seed);
        syncIdentity(s, ks);
        s.wallet.autoSource = "seed";
      }
      s.wallet.status = "";
    });
    if (app.read().wallet.enabled) await refreshBalances();
  }

  app.register("wallet", renderWallet, () => walletKey(app.read()));
  app.register("wallet-ledger", maybeRefreshOnLedger, () => String(app.read().book.snapshot?.latestLedger ?? ""));
  app.update(() => {});
  void boot();

  return {
    prefillFromLadder(side, tick) {
      if (!app.read().wallet.enabled || !app.read().wallet.active) return;
      ticket.prefill(side, tick);
    },
  };
}
