// Animate a ghost, never the model (DESIGN 5 rule 3). The leaving element is
// cloned with fixed geometry, the real one goes at once, and only the clone
// moves, with WAAPI. At most three ghosts fly; a fourth finishes the oldest.
// A hidden window finishes every ghost, so none is left mid-air on return.
import { play, type MotionPlan, type Playing } from './animate';
import type { Scheduler } from './scheduler';

export const MAX_GHOSTS = 3;

/** A child the clone carries with its own motion, such as the commit chip and edge. */
export interface GhostExtra {
  readonly element: HTMLElement;
  readonly plan: MotionPlan | null;
}

export interface LaunchOptions {
  /**
   * 'remove' detaches the real element now. 'hide' only hides it, for nodes React owns and is
   * about to remove itself; if it is still connected when the ghost ends it is shown again.
   */
  readonly release?: 'remove' | 'hide';
  /** Adds children to the clone and returns the motions they play. */
  readonly decorate?: (clone: HTMLElement) => readonly GhostExtra[];
}

export interface Ghost {
  readonly clone: HTMLElement;
  /** Ends the ghost now: its animations stop and the clone is removed. Idempotent. */
  finish(): void;
  readonly done: boolean;
}

export interface GhostLayer {
  /** Clones `element`, releases it and flies the clone. Null when the plan is instant (the element is still released). */
  launch(element: HTMLElement, plan: MotionPlan | null, options?: LaunchOptions): Ghost | null;
  /** Ghosts in flight, oldest first. */
  readonly active: readonly Ghost[];
  finishAll(): void;
  dispose(): void;
}

export interface GhostLayerOptions {
  readonly scheduler: Scheduler;
  /** Where clones are appended; defaults to the element's document body. */
  readonly host?: HTMLElement;
  readonly max?: number;
}

function cloneFixed(element: HTMLElement): HTMLElement {
  const rect = element.getBoundingClientRect();
  const clone = element.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  for (const child of clone.querySelectorAll('[id]')) child.removeAttribute('id');
  clone.setAttribute('aria-hidden', 'true');
  clone.setAttribute('inert', '');
  clone.setAttribute('data-ghost', '');
  const style = clone.style;
  style.position = 'fixed';
  style.left = `${rect.left}px`;
  style.top = `${rect.top}px`;
  style.width = `${rect.width}px`;
  style.height = `${rect.height}px`;
  style.margin = '0';
  style.boxSizing = 'border-box';
  style.pointerEvents = 'none';
  style.transform = 'none';
  // The element may already be hidden by an earlier ghost of the same node.
  style.visibility = 'visible';
  return clone;
}

// Ghosts hiding each element, and the visibility it had before the first one, so
// a node ghosted again before the first ghost ends is restored only once, by the
// last ghost, to what it was before either.
const hides = new WeakMap<HTMLElement, { count: number; before: string }>();

function releaseElement(element: HTMLElement, mode: 'remove' | 'hide'): () => void {
  if (mode === 'remove') {
    element.remove();
    return () => {};
  }
  const entry = hides.get(element) ?? { count: 0, before: element.style.visibility };
  entry.count += 1;
  hides.set(element, entry);
  element.style.visibility = 'hidden';
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    entry.count -= 1;
    if (entry.count > 0) return;
    hides.delete(element);
    if (element.isConnected) element.style.visibility = entry.before;
  };
}

export function createGhostLayer(options: GhostLayerOptions): GhostLayer {
  const max = Math.max(1, options.max ?? MAX_GHOSTS);
  const active: Ghost[] = [];

  function launch(
    element: HTMLElement,
    plan: MotionPlan | null,
    launchOptions: LaunchOptions = {},
  ) {
    const mode = launchOptions.release ?? 'remove';
    if (!plan) {
      const restore = releaseElement(element, mode);
      if (mode === 'hide') options.scheduler.frame(restore);
      return null;
    }
    while (active.length >= max) active[0]?.finish();

    const clone = cloneFixed(element);
    const host = options.host ?? element.ownerDocument.body;
    host.appendChild(clone);
    const restore = releaseElement(element, mode);

    const playing: Playing[] = [];
    let done = false;
    const ghost: Ghost = {
      clone,
      finish() {
        if (done) return;
        done = true;
        for (const item of playing) item.stop();
        clone.remove();
        restore();
        const index = active.indexOf(ghost);
        if (index >= 0) active.splice(index, 1);
      },
      get done() {
        return done;
      },
    };
    active.push(ghost);

    for (const extra of launchOptions.decorate?.(clone) ?? []) {
      if (extra.plan) playing.push(play(extra.element, extra.plan));
    }
    playing.push(play(clone, plan, () => ghost.finish()));
    return ghost;
  }

  function finishAll() {
    for (const ghost of [...active]) ghost.finish();
  }

  const unsubscribe = options.scheduler.onHide(finishAll);

  return {
    launch,
    get active() {
      return active;
    },
    finishAll,
    dispose() {
      unsubscribe();
      finishAll();
    },
  };
}
