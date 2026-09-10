import type { BookEvent } from "../book";
import { scopeOf, type RequestGate } from "../request";
import type { Store } from "../store";
import type { AppState } from "../view/market";
import { noteFills } from "./awareness";
import type { AccountState, CreditAsset, TrustlineState } from "../client/account";
import { ownTicksOf, sessionRestedNonces, type OpenOrder } from "./orders";

export type OrderInput = { sequence: string };

export type OrderRefreshDeps = {
  loadOpenOrders: (
    contract: string,
    source: string,
    sequence: string,
    market: number,
    owner: string,
    extraNonces: bigint[],
    events: BookEvent[],
    previous: OpenOrder[],
  ) => Promise<OpenOrder[]>;
};

export type BalanceRefreshDeps = {
  readAccount: (pubkey: string) => Promise<AccountState>;
  readTrustlines: (pubkey: string, assets: CreditAsset[]) => Promise<TrustlineState[]>;
  credits: () => CreditAsset[];
};

export async function refreshOrders(
  store: Store<AppState>,
  gate: RequestGate<OrderInput>,
  deps: OrderRefreshDeps,
): Promise<void> {
  const state = store.read();
  const w = state.wallet;
  const id = w.active;
  if (!w.enabled || !id || !w.account?.exists) {
    gate.invalidate();
    store.update((s) => {
      s.wallet.openOrders = [];
      s.book.ownTicks = { bid: new Set(), ask: new Set() };
    });
    return;
  }
  const events = state.book.eventState.events;
  const extra = sessionRestedNonces(events, id.publicKey);
  const previous = state.wallet.openOrders;
  const token = gate.begin(scopeOf(state), { sequence: w.account.sequence.toString() });
  const openOrders = await deps.loadOpenOrders(
    token.contract,
    id.publicKey,
    token.input.sequence,
    token.market,
    id.publicKey,
    extra,
    events,
    previous,
  );
  if (!gate.accepts(token, scopeOf(store.read()))) return;
  store.update((s) => {
    const noted = noteFills(s.wallet.lastFilled, openOrders);
    s.wallet.lastFilled = noted.next;
    s.wallet.unseenFills += noted.added;
    s.wallet.openOrders = openOrders;
    s.book.ownTicks = ownTicksOf(openOrders);
  });
}

export async function refreshBalances(
  store: Store<AppState>,
  gate: RequestGate<string>,
  deps: BalanceRefreshDeps,
): Promise<boolean> {
  const state = store.read();
  const w = state.wallet;
  const id = w.active;
  if (!w.enabled || !id) {
    gate.invalidate();
    store.update((s) => {
      s.wallet.account = null;
      s.wallet.trustlines = [];
      s.wallet.openOrders = [];
    });
    return false;
  }
  const credits = deps.credits();
  const token = gate.begin(scopeOf(state), id.publicKey);
  try {
    const acc = await deps.readAccount(id.publicKey);
    if (!gate.accepts(token, scopeOf(store.read()))) return false;
    const trustlines = credits.length ? await deps.readTrustlines(id.publicKey, credits) : [];
    if (!gate.accepts(token, scopeOf(store.read()))) return false;
    store.update((s) => {
      s.wallet.account = acc;
      s.wallet.trustlines = trustlines;
    });
    return true;
  } catch (e) {
    if (!gate.accepts(token, scopeOf(store.read()))) return false;
    const msg = e instanceof Error ? e.message : String(e);
    store.update((s) => {
      s.wallet.status = `RPC: ${msg}`;
    });
    return false;
  }
}
