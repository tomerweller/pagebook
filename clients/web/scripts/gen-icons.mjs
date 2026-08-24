import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "public");
const html = join(here, "icon.html");

const jobs = [
  { file: "icon-192.png", size: 192, mask: false },
  { file: "icon-512.png", size: 512, mask: false },
  { file: "icon-192-maskable.png", size: 192, mask: true },
  { file: "icon-512-maskable.png", size: 512, mask: true },
  { file: "apple-touch-icon.png", size: 180, mask: false },
];

await mkdir(pub, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();

for (const job of jobs) {
  await page.setViewportSize({ width: job.size, height: job.size });
  await page.goto(`file://${html}?mask=${job.mask ? "1" : "0"}`);
  await page.locator("#frame").evaluate((el, size) => {
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    const letters = el.querySelector(".letters");
    const bar = el.querySelector(".bar");
    if (letters) letters.style.fontSize = `${Math.round(size * 0.41)}px`;
    if (bar) {
      bar.style.height = `${Math.max(4, Math.round(size * 0.02))}px`;
      bar.style.marginTop = `${Math.round(size * 0.043)}px`;
    }
  }, job.size);
  await page.screenshot({ path: join(pub, job.file), type: "png" });
}

await browser.close();
