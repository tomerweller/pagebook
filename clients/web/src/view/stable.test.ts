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
  const node = { innerHTML: "", querySelector: () => null, contains: () => false, querySelectorAll: () => [] } as unknown as Element;
  const c = new MarkupCache();
  expect(c.write("kpis", node, "<b>1</b>")).toBe("html");
  expect(c.write("kpis", node, "<b>1</b>")).toBe("skip");
  expect(c.write("kpis", node, "<b>2</b>")).toBe("html");
});

test("MarkupCache patch does not poison the cache", () => {
  const node = {
    innerHTML: "",
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: () => [{ scrollTop: 4, scrollLeft: 0 }],
  } as unknown as Element;
  const c = new MarkupCache();
  node.querySelectorAll = () => [] as unknown as NodeListOf<HTMLElement>;
  expect(c.write("trades", node, "<p>a</p>")).toBe("html");
  node.querySelectorAll = () => [{ scrollTop: 4, scrollLeft: 0 }] as unknown as NodeListOf<HTMLElement>;
  expect(c.write("trades", node, "<p>b</p>")).toBe("patch");
  expect(c.get("trades")).toBe("<p>a</p>");
  expect(node.innerHTML).toBe("<p>a</p>");
  node.querySelectorAll = () => [] as unknown as NodeListOf<HTMLElement>;
  expect(c.write("trades", node, "<p>b</p>")).toBe("html");
  expect(c.get("trades")).toBe("<p>b</p>");
  expect(node.innerHTML).toBe("<p>b</p>");
});
