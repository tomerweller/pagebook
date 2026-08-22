import { expect, test } from "vitest";
import { MarkupCache, setHtml, setText } from "./stable";

test("setText skips identical content", () => {
  const el = { textContent: "a" };
  expect(setText(el as unknown as Element, "a")).toBe(false);
  expect(setText(el as unknown as Element, "b")).toBe(true);
  expect(el.textContent).toBe("b");
});

test("setHtml skips identical markup", () => {
  const el = { innerHTML: "<i>x</i>" };
  expect(setHtml(el as unknown as Element, "<i>x</i>")).toBe(false);
  expect(setHtml(el as unknown as Element, "<i>y</i>")).toBe(true);
});

test("MarkupCache skips second identical write", () => {
  const node = { innerHTML: "", querySelector: () => null, contains: () => false } as unknown as Element;
  const c = new MarkupCache();
  expect(c.write("kpis", node, "<b>1</b>")).toBe("html");
  expect(c.write("kpis", node, "<b>1</b>")).toBe("skip");
  expect(c.write("kpis", node, "<b>2</b>")).toBe("html");
});
