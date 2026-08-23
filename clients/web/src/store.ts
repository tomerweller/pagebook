import { debugRender, logRender } from "./view/stable";

export type RenderFn = () => void;
export type KeyFn = () => unknown;

const MAX_PASSES = 10;
const MUT = new Set(["add", "delete", "clear", "unshift", "push", "pop", "shift", "splice", "sort", "reverse"]);

export type Store<S> = {
  read(): S;
  update(fn: (s: S) => void): void;
  register(name: string, fn: RenderFn, keyFn?: KeyFn): void;
  renderAll(): void;
};

function wrap(value: unknown, touch: () => void): unknown {
  if (value === null || typeof value !== "object") return value;
  return new Proxy(value, {
    get(target, prop, recv) {
      const val = Reflect.get(target, prop, recv);
      if (typeof val === "function") {
        if (MUT.has(String(prop))) {
          return (...args: unknown[]) => {
            touch();
            return (val as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return (val as (...a: unknown[]) => unknown).bind(target);
      }
      return wrap(val, touch);
    },
    set(target, prop, next) {
      touch();
      return Reflect.set(target, prop, next);
    },
    deleteProperty(target, prop) {
      touch();
      return Reflect.deleteProperty(target, prop);
    },
  });
}

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
      v.fn();
      v.keyed = true;
      v.lastKey = key;
      return;
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
      const versions = (state as { versions?: Record<string, number> }).versions;
      const touched = new Set<string>();
      if (!versions) {
        fn(state);
        schedule();
        return;
      }
      const proxy = new Proxy(state as object, {
        get(target, prop, recv) {
          if (prop === "versions") return versions;
          const val = Reflect.get(target, prop, recv);
          if (val && typeof val === "object" && prop in versions) {
            return wrap(val, () => touched.add(String(prop)));
          }
          return val;
        },
        set(target, prop, next) {
          if (prop !== "versions" && prop in versions) touched.add(String(prop));
          return Reflect.set(target, prop, next);
        },
      }) as S;
      fn(proxy);
      for (const k of touched) versions[k] = (versions[k] ?? 0) + 1;
      schedule();
    },
    register(name, fn, keyFn) {
      views.push({ name, fn, keyFn, keyed: false });
    },
    renderAll,
  };
}
