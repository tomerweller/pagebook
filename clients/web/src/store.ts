import { debugRender } from "./view/stable";

export type RenderFn = () => void;

export type Store<S> = {
  read(): S;
  update(fn: (s: S) => void): void;
  register(name: string, fn: RenderFn): void;
  renderAll(): void;
};

export function createStore<S>(initial: S): Store<S> {
  const state = initial;
  const views: { name: string; fn: RenderFn }[] = [];
  let scheduled = false;
  let pass = 0;

  function renderAll(): void {
    pass += 1;
    if (debugRender()) console.info(`[render] pass ${pass}`);
    for (const v of views) v.fn();
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      renderAll();
    });
  }

  return {
    read: () => state,
    update(fn) {
      fn(state);
      schedule();
    },
    register(name, fn) {
      views.push({ name, fn });
    },
    renderAll,
  };
}
