import { expect, test } from "vitest";
import bookSrc from "../book.ts?raw";
import submitSrc from "../engine/submit.ts?raw";

const scanned = {
  ...(import.meta.glob("./**/*.ts", { query: "?raw", eager: true, import: "default" }) as Record<string, string>),
  ...(import.meta.glob("../engine/**/*.ts", { query: "?raw", eager: true, import: "default" }) as Record<string, string>),
  ...(import.meta.glob("../keys.ts", { query: "?raw", eager: true, import: "default" }) as Record<string, string>),
  ...(import.meta.glob("../decode.ts", { query: "?raw", eager: true, import: "default" }) as Record<string, string>),
};

function srcPath(globKey: string): string {
  if (globKey.startsWith("./")) return `src/client/${globKey.slice(2)}`;
  if (globKey.startsWith("../")) return `src/${globKey.slice(3)}`;
  return globKey;
}

function resolveRel(fromFile: string, spec: string): string {
  const slash = fromFile.lastIndexOf("/");
  const dir = slash === -1 ? "" : fromFile.slice(0, slash);
  const parts = [...dir.split("/"), ...spec.split("/")];
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

export function importSpecs(src: string): string[] {
  const specs: string[] = [];
  for (const m of src.matchAll(/\bfrom\s+["']([^"']+)["']/g)) specs.push(m[1]);
  for (const m of src.matchAll(/^import\s+["']([^"']+)["']/gm)) specs.push(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
  return specs;
}

function forbiddenHit(resolved: string): string | null {
  const n = resolved.replace(/\\/g, "/");
  if (n === "src/wallet" || n.startsWith("src/wallet/")) return "src/wallet/";
  if (n === "src/view" || n.startsWith("src/view/")) return "src/view/";
  if (n === "src/demo" || n.startsWith("src/demo/")) return "src/demo/";
  if (n === "src/book" || n.startsWith("src/book.")) return "src/book.ts";
  if (n === "src/main" || n.startsWith("src/main.")) return "src/main.ts";
  if (n === "src/store" || n.startsWith("src/store.")) return "src/store.ts";
  if (n === "src/sync" || n.startsWith("src/sync.")) return "src/sync.ts";
  if (n === "src/request" || n.startsWith("src/request.")) return "src/request.ts";
  if (n === "ops" || n.startsWith("ops/")) return "ops/";
  return null;
}

test("importSpecs extracts dynamic import specifiers", () => {
  expect(importSpecs(`const m = import("../wallet/pane");`)).toContain("../wallet/pane");
});

test("client and engine do not import browser, demo, book, or ops", () => {
  expect(Object.keys(scanned).length).toBeGreaterThanOrEqual(10);
  const violations: string[] = [];
  for (const [key, src] of Object.entries(scanned)) {
    if (key.endsWith(".test.ts")) continue;
    const file = srcPath(key);
    for (const spec of importSpecs(src)) {
      if (!spec.startsWith(".")) continue;
      const hit = forbiddenHit(resolveRel(file, spec));
      if (hit) violations.push(`${file} -> ${spec} (${hit})`);
    }
  }
  expect(violations).toEqual([]);
});

test("book.ts does not export mockSnapshot", () => {
  expect(bookSrc).not.toMatch(/\bexport\s+(?:async\s+)?function\s+mockSnapshot\b/);
  expect(bookSrc).not.toMatch(/\bexport\s+\{[^}]*\bmockSnapshot\b/);
  expect(bookSrc).not.toMatch(/\bexport\s+type\s+MockSnapshot\b/);
});

test("submit.ts has no re-export lines", () => {
  expect(submitSrc).not.toMatch(/export\s+(?:type\s+)?\{[^}]*\}\s+from\s+/);
});
