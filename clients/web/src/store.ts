import { debugRender, logRender } from "./view/stable";

export type RenderFn = () => void;
export type KeyFn = () => unknown;

const MAX_PASSES = 10;

export type Store<S> = {
  read(): S;
  update(fn: (s: S) => void): void;
  register(name: string, fn: RenderFn, keyFn?: KeyFn): void;
  renderAll(): void;
};

export function createStore<S>(initial: S): Store<S> {
  const state = initial;
  const views: { name: string; fn: RenderFn; keyFn?: KeyFn; lastKey?: unknown; keyed: boolean }[] = [];
  let scheduled = false;
  let pass = 0;
  let drain = 0;

  function runView(v: (typeof views)[number]): void {
    if (v.keyFn) {
      const key = v.keyFn();
      if (v.keyed && Object.is(key, v.lastKey)) {
        logRender(v.name, "skip");
        return;
      }
      v.keyed = true;
      v.lastKey = key;
    }
    v.fn();
  }

  function renderAll(): void {
    pass += 1;
    if (debugRender()) console.info(`[render] pass ${pass}`);
    for (const v of views) {
      try {
        runView(v);
      } catch (e) {
        if (debugRender()) throw e;
        console.error(`[render] ${v.name}`, e);
      }
    }
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      drain += 1;
      if (drain > MAX_PASSES) {
        const msg = `[render] loop guard: ${MAX_PASSES} consecutive passes`;
        drain = 0;
        if (debugRender()) throw new Error(msg);
        console.error(msg);
        return;
      }
      renderAll();
      if (!scheduled) drain = 0;
    });
  }

  return {
    read: () => state,
    update(fn) {
      fn(state);
      schedule();
    },
    register(name, fn, keyFn) {
      views.push({ name, fn, keyFn, keyed: false });
    },
    renderAll,
  };
}
