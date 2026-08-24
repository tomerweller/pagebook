import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 375, height: 812 } });

function inViewport(box: { x: number; y: number; width: number; height: number } | null, vh = 812, vw = 375): boolean {
  if (!box) return false;
  return box.y >= 0 && box.y + box.height <= vh && box.x >= 0 && box.x + box.width <= vw;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
});

test("wallet strip is sticky at cold load and through scroll", async ({ page }) => {
  await page.goto("/pagebook/client/?mock=1");
  await expect(page.locator("#wallet")).toBeVisible();
  const iw = await page.evaluate(() => window.innerWidth);
  expect(iw).toBe(375);
  const cold = await page.locator("#wallet").boundingBox();
  expect(cold, "strip missing at cold load").toBeTruthy();
  expect(inViewport(cold), `strip off-screen at cold load y=${cold?.y}`).toBe(true);
  expect(cold!.y).toBeGreaterThan(400);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(100);
  const scrolled = await page.locator("#wallet").boundingBox();
  expect(inViewport(scrolled), `strip unstuck after scroll y=${scrolled?.y}`).toBe(true);

  const overflow = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
  }));
  expect(overflow.sw).toBe(overflow.iw);
});

test("no-identity ladder tap brings generate into view", async ({ page }) => {
  await page.goto("/pagebook/client/?mock=1");
  const row = page.locator(".row[data-tick]").filter({ visible: true }).first();
  await expect(row).toBeVisible();
  await row.evaluate((el) => (el as HTMLElement).click());
  await expect(page.locator("#wallet")).toHaveClass(/open/);
  const gen = page.locator("[data-act=generate]");
  await expect(gen).toBeVisible();
  const box = await gen.boundingBox();
  expect(inViewport(box), `generate off-screen y=${box?.y}`).toBe(true);
});
