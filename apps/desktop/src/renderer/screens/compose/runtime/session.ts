/**
 * One composer at run time, without React: it holds the reducer's state, runs its effects against the engine one at a
 * time (a save always lands before the send that names it), keeps the autosave timer, and feeds every answer back as an
 * event. React reads it with `useSyncExternalStore`; the tests drive it against the stand-in engine directly.
 */
import type { Timers } from '../../../data/scheduler';
import { saveDueAt } from '../model/autosave';
import { composeReducer } from '../model/composeReducer';
import type { ComposeEffect, ComposeEvent, ComposeState } from '../model/composeState';
import { draftFieldsOf } from '../model/fields';
import { refusalOf, type ComposeApi } from './composeApi';

export interface ComposeSessionDeps {
  readonly api: ComposeApi;
  /** The clock and timer source (the data layer's, or a test's fake). */
  readonly timers: Pick<Timers, 'now' | 'setTimeout'>;
  /** "Draft discarded" / "Couldn't discard the draft. It is still saved." */
  readonly notify?: (notice: 'discarded' | 'discardFailed') => void;
  /** "Check Sent" after an unconfirmed send. */
  readonly checkSent?: () => void;
}

export interface ComposeSession {
  getState(): ComposeState;
  subscribe(listener: () => void): () => void;
  dispatch(event: ComposeEvent): void;
  /** Resolves once every effect asked for so far has been answered (tests, and the flush on close). */
  settled(): Promise<void>;
  /** Stops the timer and ignores late answers. Unsaved edits are not flushed: call `dispatch({type: 'flush'})` first. */
  dispose(): void;
}

export function createComposeSession(
  deps: ComposeSessionDeps,
  initial: ComposeState,
): ComposeSession {
  let state = initial;
  let disposed = false;
  let queue: Promise<void> = Promise.resolve();
  let cancelTimer: (() => void) | null = null;
  const listeners = new Set<() => void>();

  function dispatch(event: ComposeEvent): void {
    if (disposed) return;
    const step = composeReducer(state, event);
    const changed = step.state !== state;
    state = step.state;
    for (const effect of step.effects) enqueue(effect);
    armTimer();
    if (changed) listeners.forEach(listener => listener());
  }

  function enqueue(effect: ComposeEffect): void {
    queue = queue.then(() => run(effect)).catch(() => undefined);
  }

  function armTimer(): void {
    cancelTimer?.();
    cancelTimer = null;
    const due = state.discarding ? null : saveDueAt(state.save);
    if (due === null) return;
    const wait = Math.max(0, due - deps.timers.now());
    cancelTimer = deps.timers.setTimeout(
      () => dispatch({ type: 'tick', now: deps.timers.now() }),
      wait,
    );
  }

  async function run(effect: ComposeEffect): Promise<void> {
    // A disposed composer (closed window, reload, crash) starts no new call; one already sent still lands on the engine.
    if (disposed) return;
    switch (effect.type) {
      case 'save':
        return runSave(effect);
      case 'submit':
        return runSubmit(effect);
      case 'submission':
        return runFollowUp(effect);
      case 'destroy':
        return runDestroy(effect.draftId);
      case 'checkSent':
        return deps.checkSent?.();
      case 'notify':
        return deps.notify?.(effect.notice);
    }
  }

  async function runSave(effect: Extract<ComposeEffect, { type: 'save' }>): Promise<void> {
    const fields = draftFieldsOf(effect.fields, effect.context);
    const target =
      effect.draftId === null
        ? {}
        : { id: effect.draftId, baseRevision: effect.baseRevision ?? undefined };
    try {
      const { draft } = await deps.api.saveDraft({ ...target, fields });
      dispatch({ type: 'saved', seq: effect.seq, draft });
    } catch {
      dispatch({ type: 'saveFailed', seq: effect.seq, now: deps.timers.now() });
    }
  }

  async function runSubmit(effect: Extract<ComposeEffect, { type: 'submit' }>): Promise<void> {
    const action = {
      type: 'send',
      draftId: effect.draftId,
      revision: effect.revision,
      ...(effect.alsoDone ? { alsoDone: true } : {}),
      ...(effect.notBefore !== undefined ? { notBefore: effect.notBefore } : {}),
    } as const;
    try {
      const { submission } = await deps.api.setSubmission({ opId: effect.opId, action });
      dispatch({ type: 'sendAccepted', submission });
    } catch (error) {
      dispatch({ type: 'sendRefused', refusal: refusalOf(error) });
    }
  }

  async function runFollowUp(
    effect: Extract<ComposeEffect, { type: 'submission' }>,
  ): Promise<void> {
    try {
      const { submission } = await deps.api.setSubmission({ action: effect.action });
      dispatch({ type: 'observeSubmission', submission });
    } catch {
      // Too late (it already left) or refused: the row's next frame says what happened, and the tray follows it.
    }
  }

  async function runDestroy(draftId: string): Promise<void> {
    try {
      await deps.api.destroyDraft({ id: draftId });
      dispatch({ type: 'discarded' });
    } catch {
      dispatch({ type: 'discardFailed' });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    async settled() {
      let seen: Promise<void> | null = null;
      while (seen !== queue) {
        seen = queue;
        await queue;
      }
    },
    dispose() {
      disposed = true;
      cancelTimer?.();
      cancelTimer = null;
      listeners.clear();
    },
  };
}
