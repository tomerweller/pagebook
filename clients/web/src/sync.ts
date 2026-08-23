import type { BookEvent, BookSnapshot } from "./book";
import type { Store } from "./store";
import type { AppState } from "./view/market";

const MAX_EVENTS = 500;

export type EventBatch = {
  cursor: string | null;
  events: BookEvent[];
  historyFrom?: number | null;
};

export function mergeEvents(into: AppState["book"]["eventState"], incoming: BookEvent[]): void {
  const byId = new Map(into.events.map((e) => [e.id, e]));
  for (const e of incoming) byId.set(e.id, e);
  into.events = [...byId.values()]
    .sort((a, b) => {
      const ld = (b.ledger || 0) - (a.ledger || 0);
      if (ld) return ld;
      return String(b.id).localeCompare(String(a.id));
    })
    .slice(0, MAX_EVENTS);
  into.seen = new Set(into.events.map((e) => e.id).filter((id): id is string => Boolean(id)));
}

export async function refreshBookAndEvents(
  store: Store<AppState>,
  forMarket: number | null,
  deps: {
    walk: () => Promise<BookSnapshot>;
    poll: (book: BookSnapshot) => Promise<EventBatch>;
    formatError: (e: unknown) => string;
  },
): Promise<void> {
  const book = await deps.walk();
  if (store.read().book.market !== forMarket) return;
  store.update((s) => {
    s.book.knownBase = book.base || s.book.knownBase;
    s.book.knownQuote = book.quote || s.book.knownQuote;
    s.book.snapshot = book;
    s.book.lastOkAt = Date.now();
    s.book.lastError = "";
  });
  try {
    const ev = await deps.poll(book);
    if (store.read().book.market !== forMarket) return;
    store.update((s) => {
      s.book.eventState.cursor = ev.cursor;
      if (ev.historyFrom != null) s.book.eventState.historyFrom = ev.historyFrom;
      mergeEvents(s.book.eventState, ev.events);
    });
  } catch (e) {
    if (store.read().book.market !== forMarket) return;
    store.update((s) => {
      s.book.lastError = deps.formatError(e);
    });
  }
}
