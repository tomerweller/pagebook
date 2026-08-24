import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 900 } });

test("desktop rail keeps the brand and has no instrument strip", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/pagebook/client/?mock=1");
  await expect(page.locator("#wallet")).toBeVisible();
  await expect(page.locator("header.top .brand")).toBeVisible();
  await expect(page.locator(".wallet-instrument")).toBeHidden();
  await expect(page.locator("[data-sec=sheet-brand]")).toHaveCount(0);
  const overflow = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
    brand: document.querySelector("header.top .brand")?.textContent,
    instDisplay: getComputedStyle(document.querySelector(".wallet-instrument")!).display,
  }));
  expect(overflow.sw).toBe(overflow.iw);
  expect(overflow.brand).toMatch(/PAGEBOOK/);
  expect(overflow.instDisplay).toBe("none");
  await page.screenshot({ path: "test-results/b3-desktop-rail.png" });
});
