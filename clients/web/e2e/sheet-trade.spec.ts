import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 375, height: 812 } });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
});

function seed(): string {
  return `e2e-375-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function m1Price(tick: number): string {
  const frac = (tick % 100_000).toString().padStart(5, "0").replace(/0+$/, "");
  const whole = Math.floor(tick / 100_000).toString();
  return frac ? `${whole}.${frac}` : whole;
}

function inViewport(box: { y: number; height: number } | null, vh = 812): boolean {
  if (!box) return false;
  return box.y >= 0 && box.y + box.height <= vh;
}

test("place → replace → settle confirmations stay in the sheet at 375", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errs.push(msg.text());
  });
  page.on("pageerror", (err) => errs.push(err.message));

  await page.goto(`/pagebook/client/?seed=${seed()}&market=1`);
  await expect(page.getByRole("heading", { name: "XLM / USDC" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("add trustline")).toHaveCount(0, { timeout: 90_000 });

  const row = page.locator(".row[data-tick][data-side=bid]").filter({ visible: true }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.evaluate((el) => (el as HTMLElement).click());
  await expect(page.locator("#wallet")).toHaveClass(/open/);
  const ticket = page.locator(".ticket");
  await expect(ticket.getByRole("heading", { name: "place order" })).toBeVisible();
  await expect(ticket.locator("button[data-act=sell]")).toHaveClass(/on/);

  await ticket.locator("[data-field=qty]").fill("20");
  await ticket.locator("[data-flag=no_rest]").check();
  await expect(ticket.locator("[data-role=preview]")).toContainText(/takes [1-9]/, { timeout: 60_000 });
  await ticket.locator("button[data-act=place]").click();
  const placeStrip = ticket.locator("[data-role=strip]");
  await expect(placeStrip).toContainText("confirmed", { timeout: 90_000 });
  expect(inViewport(await placeStrip.boundingBox()), "place confirm below fold").toBe(true);

  await ticket.locator("[data-act=status-ack]").click();
  const bidTick = await row.getAttribute("data-tick");
  const restTick = String(Number(bidTick) - 20);
  await ticket.locator("button[data-act=buy]").click();
  await ticket.locator("[data-field=price]").fill(m1Price(Number(restTick)));
  await ticket.locator("[data-field=qty]").fill("10");
  await ticket.locator("[data-flag=no_rest]").uncheck();
  await ticket.locator("[data-flag=post_only]").check();
  await expect(ticket.locator("[data-role=preview]")).toContainText(/remainder 1 lot rests/, { timeout: 60_000 });
  await ticket.locator("button[data-act=place]").click();
  await expect(ticket.locator("[data-role=strip]")).toContainText(/· rests/, { timeout: 90_000 });
  await expect(page.locator(".orders")).toContainText(`bid ${restTick}`);
  await page.locator("[data-act=toggle]").click();
  await expect(page.locator("#wallet")).not.toHaveClass(/open/);
  await expect(page.locator(".wallet-instrument")).toContainText(/1 order/);
  await page.screenshot({ path: "test-results/b3-strip-one-order.png" });
  await page.locator("[data-act=toggle]").click();
  await expect(page.locator("#wallet")).toHaveClass(/open/);

  await page.locator("button[data-act=replace-ask]").first().click();
  await expect(page.locator("[data-act=replace-go]")).toBeVisible();
  await page.locator("[data-act=rprice-inc]").click();
  await page.locator("[data-act=replace-go]").click();
  const replaceStrip = page.locator("[data-role=ostrip]");
  await expect(replaceStrip).toContainText("confirmed", { timeout: 90_000 });
  expect(inViewport(await replaceStrip.boundingBox()), "replace confirm below fold").toBe(true);

  await page.locator("button[data-act=settle-ask]").first().click();
  await expect(page.locator("[data-act=settle-go]")).toBeVisible();
  await page.locator("[data-act=settle-go]").click();
  const settleStrip = page.locator("[data-role=ostrip]");
  await expect(settleStrip).toContainText("confirmed", { timeout: 90_000 });
  await expect(page.locator(".orders")).toContainText("no open orders");
  expect(inViewport(await settleStrip.boundingBox()), "settle confirm below fold").toBe(true);
  expect(errs, errs.join("\n")).toEqual([]);
});
