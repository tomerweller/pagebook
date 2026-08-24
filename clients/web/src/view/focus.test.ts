/**
 * @vitest-environment jsdom
 */
import { expect, test } from "vitest";
import { swapPreservingFocus } from "./focus";

test("swap applies state value when the user was not mid-edit", () => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  root.innerHTML = `<input data-field="rprice" value="12.50" />`;
  const input = root.querySelector("input")!;
  input.focus();
  input.setSelectionRange(1, 3);
  swapPreservingFocus(root, `<input data-field="rprice" value="99.00" />`);
  const again = root.querySelector("input")!;
  expect(document.activeElement).toBe(again);
  expect(again.value).toBe("99.00");
  root.remove();
});

test("swap preserves focused input value over generated html", () => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  root.innerHTML = `<input data-field="rqty" value="1" />`;
  const input = root.querySelector("input")!;
  input.focus();
  input.value = "typed";
  swapPreservingFocus(root, `<input data-field="rqty" value="from-state" />`);
  expect((root.querySelector("input") as HTMLInputElement).value).toBe("typed");
  root.remove();
});

test("swap restores backward selection direction", () => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  root.innerHTML = `<input data-field="rprice" value="12.50" />`;
  const input = root.querySelector("input")!;
  input.focus();
  input.setSelectionRange(1, 3, "backward");
  swapPreservingFocus(root, `<input data-field="rprice" value="12.50" />`);
  const again = root.querySelector("input")!;
  expect(again.selectionStart).toBe(1);
  expect(again.selectionEnd).toBe(3);
  expect(again.selectionDirection).toBe("backward");
  root.remove();
});

test("swap restores descendant scroll", () => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  root.innerHTML = `<div class="pane"><p>a</p></div>`;
  const pane = root.querySelector(".pane") as HTMLElement;
  Object.defineProperty(pane, "scrollTop", { value: 30, writable: true, configurable: true });
  Object.defineProperty(pane, "scrollLeft", { value: 4, writable: true, configurable: true });
  swapPreservingFocus(root, `<div class="pane"><p>b</p></div>`);
  const next = root.querySelector(".pane") as HTMLElement;
  expect(next.scrollTop).toBe(30);
  expect(next.scrollLeft).toBe(4);
  expect(root.innerHTML).toMatch(/>b</);
  root.remove();
});
