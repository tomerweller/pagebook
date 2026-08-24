export type Box = { top: number; left: number; width: number; height: number };

export function stubRect(el: Element, box: Box): void {
  const rect = {
    top: box.top,
    left: box.left,
    width: box.width,
    height: box.height,
    bottom: box.top + box.height,
    right: box.left + box.width,
    x: box.left,
    y: box.top,
    toJSON() {
      return this;
    },
  };
  Object.defineProperty(el, "getBoundingClientRect", { value: () => rect, configurable: true });
}

export function inSheetViewport(el: Element, sheet: Element): boolean {
  const er = el.getBoundingClientRect();
  const sr = sheet.getBoundingClientRect();
  if (er.bottom <= er.top || sr.bottom <= sr.top) return false;
  return er.top >= sr.top && er.bottom <= sr.bottom && er.left >= sr.left && er.right <= sr.right;
}

export function assertInSheetViewport(el: Element, sheet: Element): void {
  if (!inSheetViewport(el, sheet)) {
    const er = el.getBoundingClientRect();
    const sr = sheet.getBoundingClientRect();
    throw new Error(
      `below the fold: el ${er.top}-${er.bottom} vs sheet ${sr.top}-${sr.bottom}`,
    );
  }
}
