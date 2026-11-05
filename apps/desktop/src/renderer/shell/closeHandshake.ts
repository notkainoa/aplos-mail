// Main asks a window to close with a `prepare-close` event and keeps the window disabled until the renderer answers
// `Window/closeReady` (or `Window/closeCancel`). The legacy renderer answered it; this is the new roots' answer on the
// engine path. Typed (`only: ['prepare-close']`), so it never takes the deep-link and command events held for the
// app's own first plain subscribe.

/** The part of preload's bridge this needs. */
export interface CloseBridge {
  subscribe(
    listener: (event: { type: string }) => void,
    options?: { only?: readonly string[] },
  ): () => void;
}

/** What the answer does: save what is unsaved, then tell main. */
export interface CloseDeps {
  /** Saves unsaved work; resolves when it is safe to check (it may give up on a slow engine). */
  readonly save: () => Promise<void>;
  /** True while anything still holds unsaved text after `save` — the window must NOT close (kept entries live only in this window's memory). */
  readonly stillUnsaved: () => boolean;
  /** Fires the "kept open" toast when `stillUnsaved` cancels the close. */
  readonly onUnsaved: () => void;
  readonly ready: () => Promise<unknown>;
  readonly cancel: () => Promise<unknown>;
}

/**
 * Answers each `prepare-close`: save, then decide. Unsaved text that survives `save` (a failed or slow write stays
 * only in this window's memory — `recovery.ts`) cancels the close with a toast instead of being lost; otherwise
 * `ready`. If `ready` fails, `cancel` re-enables the window so it is never left disabled. One answer at a time: a
 * second event while one is running is the same close. Returns the unsubscribe.
 */
export function answerPrepareClose(bridge: CloseBridge | undefined, deps: CloseDeps): () => void {
  if (!bridge || typeof bridge.subscribe !== 'function') return () => undefined;
  let answering = false;
  return bridge.subscribe(
    event => {
      if (event.type !== 'prepare-close' || answering) return;
      answering = true;
      void deps
        .save()
        .catch(() => undefined)
        .then(() => {
          if (!deps.stillUnsaved()) return deps.ready();
          deps.onUnsaved();
          return deps.cancel().catch(() => undefined);
        })
        .catch(() => deps.cancel().catch(() => undefined))
        .finally(() => {
          answering = false;
        });
    },
    { only: ['prepare-close'] },
  );
}
