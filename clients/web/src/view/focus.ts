export function swapPreservingFocus(node: Element, html: string): void {
  if (typeof document === "undefined") {
    node.innerHTML = html;
    return;
  }
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && node.contains(active) ? active : null;
  const key = focused ? identityOf(focused) : null;
  const input = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : null;
  const value = input && input.type !== "checkbox" && input.type !== "radio" ? input.value : null;
  const start = input?.selectionStart ?? null;
  const end = input?.selectionEnd ?? null;
  const scrolls = captureScrolls(node);
  node.innerHTML = html;
  restoreScrolls(node, scrolls);
  if (!key) return;
  const next = findByIdentity(node, key);
  if (!next) return;
  if (value != null && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)) next.value = value;
  next.focus();
  if (start != null && end != null && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)) {
    try {
      next.setSelectionRange(start, end);
    } catch {
      /* not a text field */
    }
  }
}

function identityOf(el: HTMLElement): string | null {
  const field = el.getAttribute("data-field");
  if (field) return `f:${field}`;
  const act = el.getAttribute("data-act");
  if (!act) return null;
  const nonce = el.getAttribute("data-nonce");
  return nonce ? `a:${act}:${nonce}` : `a:${act}`;
}

function findByIdentity(root: Element, key: string): HTMLElement | null {
  const i = key.indexOf(":");
  const kind = key.slice(0, i);
  const rest = key.slice(i + 1);
  if (kind === "f") return root.querySelector(`[data-field="${rest}"]`);
  if (kind === "a") {
    const j = rest.indexOf(":");
    if (j < 0) return root.querySelector(`[data-act="${rest}"]`);
    return root.querySelector(`[data-act="${rest.slice(0, j)}"][data-nonce="${rest.slice(j + 1)}"]`);
  }
  return null;
}

function pathOf(root: Element, el: Element): number[] {
  const path: number[] = [];
  let cur: Element | null = el;
  while (cur && cur !== root) {
    const parent: Element | null = cur.parentElement;
    if (!parent) break;
    path.push(Array.prototype.indexOf.call(parent.children, cur));
    cur = parent;
  }
  return path.reverse();
}

function atPath(root: Element, path: number[]): HTMLElement | null {
  let cur: Element = root;
  for (const i of path) {
    const next = cur.children[i];
    if (!next) return null;
    cur = next;
  }
  return cur instanceof HTMLElement ? cur : null;
}

function captureScrolls(root: Element): { path: number[]; top: number; left: number }[] {
  const out: { path: number[]; top: number; left: number }[] = [];
  if (typeof root.querySelectorAll !== "function") return out;
  for (const n of root.querySelectorAll<HTMLElement>("*")) {
    if (n.scrollTop || n.scrollLeft) out.push({ path: pathOf(root, n), top: n.scrollTop, left: n.scrollLeft });
  }
  return out;
}

function restoreScrolls(root: Element, scrolls: { path: number[]; top: number; left: number }[]): void {
  for (const s of scrolls) {
    const el = atPath(root, s.path);
    if (!el) continue;
    el.scrollTop = s.top;
    el.scrollLeft = s.left;
  }
}
