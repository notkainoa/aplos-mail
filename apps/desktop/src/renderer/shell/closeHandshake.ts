// Main asks a window to close with a `prepare-close` event and keeps the window disabled until the renderer answers
// `Window/closeReady` (or `Window/closeCancel`). The legacy renderer answered it; this is the new roots' answer on the
// engine path. Typed (`only: ['prepare-close']`), so it never takes the deep-link and command events held for the
// app's own first plain subscribe. No imports, so it loads with the entry and a failed chunk cannot leave the window
// disabled.

/** The part of preload's bridge this needs. */
export interface CloseBridge {
  subscribe(
    listener: (event: { type: string }) => void,
    options?: { only?: readonly string[] },
  ): () => void;
}

/** `unsaved`: some text is still only in this window's memory, which dies with it. */
export type SaveResult = 'saved' | 'unsaved';

/** What the answer does: save what is unsaved, then tell main. */
export interface CloseDeps {
  /** Saves unsaved work; says whether any of it could not be saved (it may give up on a slow engine). */
  readonly save: () => Promise<SaveResult>;
  readonly ready: () => Promise<unknown>;
  readonly cancel: () => Promise<unknown>;
  /** Tells the owner why the window stayed open. */
  readonly notify: (message: string) => void;
  /** The clock, for the repeat-close window (tests). */
  readonly now?: () => number;
}

/** A second close this soon after one that kept the window open leaves without the unsaved text. */
export const FORCE_CLOSE_MS = 10_000;

export const HELD_MESSAGE = 'Couldn’t save your draft. Close again to leave without it.';

/**
 * Answers each `prepare-close`: save, then `closeReady` — unless some text could not be saved, which would be lost
 * with the window. Then it answers `closeCancel` (main re-enables the window and cancels a quit) and says so; a second
 * close within `FORCE_CLOSE_MS` is the owner's choice and closes. A save that throws counts as unsaved. If `closeReady`
 * fails, `closeCancel` re-enables the window so it is never left disabled. One answer at a time. Returns the unsubscribe.
 */
export function answerPrepareClose(bridge: CloseBridge | undefined, deps: CloseDeps): () => void {
  if (!bridge || typeof bridge.subscribe !== 'function') return () => undefined;
  const now = deps.now ?? Date.now;
  let answering = false;
  let heldAt: number | null = null;
  const cancel = () => deps.cancel().catch(() => undefined);
  const answer = async (): Promise<void> => {
    const forced = heldAt !== null && now() - heldAt <= FORCE_CLOSE_MS;
    const result: SaveResult = forced ? 'saved' : await deps.save().catch(() => 'unsaved' as const);
    if (result === 'unsaved') {
      heldAt = now();
      deps.notify(HELD_MESSAGE);
      await cancel();
      return;
    }
    heldAt = null;
    await deps.ready().catch(cancel);
  };
  return bridge.subscribe(
    event => {
      if (event.type !== 'prepare-close' || answering) return;
      answering = true;
      void answer()
        .catch(() => undefined)
        .finally(() => {
          answering = false;
        });
    },
    { only: ['prepare-close'] },
  );
}
