import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  retries: 1,
  timeout: 180_000,
  expect: { timeout: 60_000 },
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
  },
  webServer: {
    command:
      "rm -rf /tmp/pbe2e/pagebook/client && mkdir -p /tmp/pbe2e/pagebook && cp -r dist /tmp/pbe2e/pagebook/client && python3 -m http.server 4173 --bind 127.0.0.1 --directory /tmp/pbe2e",
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
