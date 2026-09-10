const g = globalThis as typeof globalThis & { Buffer?: { alloc(n: number): object; prototype: object } };
if (typeof window !== "undefined" && g.Buffer && !(g.Buffer.alloc(1) instanceof Uint8Array)) {
  Object.setPrototypeOf(g.Buffer.prototype, Uint8Array.prototype);
}
