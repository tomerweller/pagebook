import type { AppState } from "./view/market";

export type RequestScope = {
  contract: string;
  market: number;
  account: string | null;
};

export type RequestToken<I> = Readonly<RequestScope & { version: number; input: I }>;

export type RequestGate<I> = {
  begin(scope: RequestScope, input: I): RequestToken<I>;
  invalidate(): void;
  accepts(token: RequestToken<I>, live: RequestScope): boolean;
};

export function scopeOf(app: AppState): RequestScope {
  return {
    contract: app.book.contract,
    market: app.book.market ?? 0,
    account: app.wallet.active?.publicKey ?? null,
  };
}

export function createRequestGate<I>(): RequestGate<I> {
  let version = 0;
  return {
    begin(scope, input) {
      version += 1;
      return Object.freeze({
        contract: scope.contract,
        market: scope.market,
        account: scope.account,
        version,
        input,
      });
    },
    invalidate() {
      version += 1;
    },
    accepts(token, live) {
      return (
        token.version === version &&
        token.contract === live.contract &&
        token.market === live.market &&
        token.account === live.account
      );
    },
  };
}
