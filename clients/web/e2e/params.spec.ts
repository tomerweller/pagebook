import { expect, test } from "@playwright/test";

// A hand-typed parameter must not be able to empty the page: `?market=abc`
// used to reach the key builder as NaN and `?depth=abc` rendered a book in the
// KPIs with both ladder sides empty (docs/client/UI-SCENARIOS.md A14).
test.use({ viewport: { width: 1440, height: 900 } });

test("garbage numeric parameters fall back to the defaults", async ({ page }) => {
  const errs: string[] = [];
  page.on("pageerror", (err) => errs.push(err.message));
  await page.goto("/pagebook/?mock=1&market=abc&depth=abc&base_dec=-3");
  await expect(page.locator("#kpis")).toContainText("99", { timeout: 30_000 });
  await expect(page.locator(".side.bids .row[data-tick]").first()).toBeVisible();
  await expect(page.locator(".side.asks .row[data-tick]").first()).toBeVisible();
  await expect(page.locator("#fresh-text")).not.toContainText("NaN");
  // base_dec=-3 is out of range, so amounts keep the token's own 7 decimals.
  await expect(page.locator(".side.bids .row[data-tick]").first()).toContainText("0.000004");
  expect(errs, errs.join("\n")).toEqual([]);
});

test("the market view survives a market id the contract does not have", async ({ page }) => {
  await page.goto("/pagebook/?market=99999");
  await expect(page.locator("#facts")).toContainText("no Market entry", { timeout: 60_000 });
  await expect(page.locator("#pair")).toHaveText("? / ?");
  await expect(page.locator("#ladder")).toContainText("no bids in window");
});

test("a non-testnet RPC keeps the book and disables the wallet", async ({ page }) => {
  await page.goto("/pagebook/?rpc=https://mainnet.sorobanrpc.com");
  await expect(page.locator("#wallet")).toContainText("not testnet", { timeout: 60_000 });
  await expect(page.locator("[data-act=generate]")).toHaveCount(0);
});
