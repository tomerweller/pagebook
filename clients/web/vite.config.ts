import { defineConfig } from "vitest/config";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/pagebook/client/" : "/",
  test: {
    include: ["src/**/*.test.ts", "ops/**/*.test.ts"],
  },
}));
