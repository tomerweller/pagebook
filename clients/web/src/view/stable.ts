export function debugRender(): boolean {
  if (typeof location === "undefined") return false;
  return new URLSearchParams(location.search).get("debug") === "render";
}

export function logRender(section: string, action: "skip" | "html" | "patch"): void {
  if (debugRender()) console.info(`[render] ${section} ${action}`);
}

export function setText(el: Element | null, text: string): boolean {
  if (!el) return false;
  if (el.textContent === text) return false;
  el.textContent = text;
  return true;
}

export function setHtml(el: Element | null, html: string): boolean {
  if (!el) return false;
  if (el.innerHTML === html) return false;
  el.innerHTML = html;
  return true;
}

export function setAttr(el: Element | null, name: string, value: string): boolean {
  if (!el) return false;
  if (el.getAttribute(name) === value) return false;
  el.setAttribute(name, value);
  return true;
}

export function shouldPatch(root: Element): boolean {
  if (typeof document !== "undefined") {
    const active = document.activeElement;
    if (active instanceof HTMLElement && root.contains(active)) return true;
  }
  if (typeof root.querySelectorAll !== "function") return false;
  const nodes = root.querySelectorAll<HTMLElement>("*");
  for (const n of nodes) {
    if (n.scrollTop > 0 || n.scrollLeft > 0) return true;
  }
  return false;
}

export class MarkupCache {
  private last = new Map<string, string>();

  forget(name?: string): void {
    if (name) this.last.delete(name);
    else this.last.clear();
  }

  write(name: string, node: Element | null, html: string): "skip" | "html" | "patch" {
    if (!node) return "skip";
    if (this.last.get(name) === html) {
      logRender(name, "skip");
      return "skip";
    }
    if (shouldPatch(node) && this.last.has(name)) {
      this.last.set(name, html);
      logRender(name, "patch");
      return "patch";
    }
    this.last.set(name, html);
    node.innerHTML = html;
    logRender(name, "html");
    return "html";
  }
}
