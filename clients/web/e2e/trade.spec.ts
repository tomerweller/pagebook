import { expect, test, type Page } from "@playwright/test";

function seed(): string {
  return `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function clickIf(page: Page, sel: string): Promise<void> {
  const loc = page.locator(sel).first();
  await loc.waitFor({ state: "visible", timeout: 60_000 });
  await loc.click();
}

test("fund, trustline, take, rest, settle on XLM/USDC", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errs.push(msg.text());
  });
  page.on("pageerror", (err) => errs.push(err.message));

  await page.goto(`/pagebook/client/?seed=${seed()}&market=1`);
  await expect(page.getByRole("heading", { name: "XLM / USDC" })).toBeVisible({ timeout: 60_000 });

  await clickIf(page, 'button[data-act="friendbot"]');
  await expect(page.getByText("add trustline")).toBeVisible({ timeout: 90_000 });

  await clickIf(page, 'button[data-act="trust-ask"]');
  await clickIf(page, 'button[data-act="trust-go"]');
  await expect(page.getByText("add trustline")).toHaveCount(0, { timeout: 90_000 });
  await expect(page.locator(".wallet-assets")).toContainText("USDC");

  const ticket = page.locator(".ticket");
  await expect(ticket.getByRole("heading", { name: "place order" })).toBeVisible();

  const bid = page.locator(".side.bids .row[data-tick]").first();
  await expect(bid).toBeVisible({ timeout: 60_000 });
  const bidTick = await bid.getAttribute("data-tick");
  expect(bidTick).toBeTruthy();
  await bid.click();
  await expect(ticket.locator("button[data-act=sell]")).toHaveClass(/on/);
  await ticket.locator("[data-field=lots]").fill("2");
  await ticket.locator("[data-flag=no_rest]").check();
  await expect(ticket.locator("[data-role=preview]")).toContainText(/takes [1-9]/, { timeout: 60_000 });
  await ticket.locator("button[data-act=place]").click();
  await expect(ticket.locator("[data-role=strip]")).toContainText("confirmed", { timeout: 90_000 });
  await expect(page.locator(".wallet-assets")).toContainText(/USDC\s*[1-9]/);

  const restTick = String(Number(bidTick) - 20);
  await ticket.locator("button[data-act=buy]").click();
  await ticket.locator("[data-field=tick]").fill(restTick);
  await ticket.locator("[data-field=lots]").fill("1");
  await ticket.locator("[data-flag=no_rest]").uncheck();
  await ticket.locator("[data-flag=post_only]").check();
  await expect(ticket.locator("[data-role=preview]")).toContainText(/remainder 1 lot rests/, { timeout: 60_000 });
  await ticket.locator("button[data-act=place]").click();
  await expect(ticket.locator("[data-role=strip]")).toContainText(/· rests/, { timeout: 90_000 });
  await expect(page.locator(".orders")).toContainText(`bid ${restTick}`);
  await expect(page.locator(`.row.own[data-tick="${restTick}"]`)).toBeVisible({ timeout: 60_000 });

  await page.locator("button[data-act=settle-ask]").first().click();
  await page.locator("button[data-act=settle-go]").click();
  await expect(page.locator(".orders")).toContainText("no open orders", { timeout: 90_000 });
  expect(errs, errs.join("\n")).toEqual([]);
});
