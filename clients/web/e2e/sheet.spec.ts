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
  await expect(page.locator(".wallet-instrument")).toContainText("99");
  await expect(page.locator(".wallet-instrument")).toContainText("101");
  await expect(page.locator("header.top .brand")).toBeVisible();
  await page.screenshot({ path: "test-results/b3-strip-cold.png" });

  const short = await page.locator(".wallet-toggle").boundingBox();
  await page.evaluate(() => {
    const inst = document.querySelector(".wallet-instrument");
    if (!inst) return;
    const bid = inst.querySelector(".bid");
    const ask = inst.querySelector(".ask");
    if (bid) bid.textContent = "0.19858";
    if (ask) ask.textContent = "0.19871";
    let rest = inst.querySelector(".inst-rest");
    if (!rest) {
      rest = document.createElement("span");
      rest.className = "inst-rest";
      inst.append(rest);
    }
    rest.innerHTML = " · 12 orders · 3 fills <i class=\"fill-dot\" aria-hidden=\"true\">●</i>";
  });
  const long = await page.locator(".wallet-toggle").boundingBox();
  const instBox = await page.locator(".wallet-instrument").boundingBox();
  expect(long, "toggle missing after long content").toBeTruthy();
  expect(short, "toggle missing before long content").toBeTruthy();
  expect(Math.abs(long!.x - short!.x)).toBeLessThan(2);
  expect(long!.x + long!.width).toBeLessThanOrEqual(375);
  expect(instBox!.x + instBox!.width).toBeLessThanOrEqual(long!.x + 1);
  await page.screenshot({ path: "test-results/b3-strip-long.png" });
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
