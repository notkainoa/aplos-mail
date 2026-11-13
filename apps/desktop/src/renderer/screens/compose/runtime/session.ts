/**
 * One composer at run time, without React: it holds the reducer's state, runs its effects against the engine one at a
 * time (a save always lands before the send that names it), keeps the autosave timer, and feeds every answer back as an
 * event. React reads it with `useSyncExternalStore`; the tests drive it against the stand-in engine directly.
 */
import type { Draft, DraftFields, Submission } from '../../../data';
import type { Timers } from '../../../data/scheduler';
import { saveDueAt } from '../model/autosave';
import { composeReducer } from '../model/composeReducer';
import type {
  ComposeEffect,
  ComposeEvent,
  ComposeNotice,
  ComposeState,
  SaveFailure,
} from '../model/composeState';
import { contextFromDraft, draftFieldsOf } from '../model/fields';
import { SEND_CONFIRM_MS } from '../model/sendState';
import { undoRefusalOutcome } from '../model/undoRefusal';
import { refusalOf, type ComposeApi } from './composeApi';

/** The answer to a `Submission/set send`, as the event the reducer takes. */
export type SendAnswer = Extract<ComposeEvent, { type: 'sendAccepted' | 'sendRefused' }>;

export interface ComposeSessionDeps {
  readonly api: ComposeApi;
  /** The clock and timer source (the data layer's, or a test's fake). */
  readonly timers: Pick<Timers, 'now' | 'setTimeout'>;
  /** "Draft discarded" / "Couldn't discard the draft. It is still saved." / "Already sent." / the engine's sentence. */
  readonly notify?: (notice: ComposeNotice, message?: string) => void;
  /** "Check Sent" after an unconfirmed send. */
  readonly checkSent?: () => void;
  /** A send's answer that came after the session was disposed (it had timed out): the toast stack follows it. */
  readonly onLateAnswer?: (answer: SendAnswer) => void;
  /** A fresh idempotency key for one draft create (its retries reuse it). */
  readonly mintOpId?: () => string;
}

function randomOpId(): string {
  return `draft-create:${globalThis.crypto.randomUUID()}`;
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

/** Refusals a retry on the same base cannot fix; anything else (offline, a timeout) retries on the backoff. */
export function saveFailureOf(error: unknown): SaveFailure | undefined {
  const type = refusalOf(error).type;
  if (type === 'notFound') return 'gone';
  if (type === 'stateMismatch' || type === 'conflict') return 'mismatch';
  return undefined;
}

/** A draft row's own fields, to keep it as a new draft (the engine assigns the id). */
export function copyOf(draft: Draft): DraftFields {
  return {
    ...contextFieldsOf(contextFromDraft(draft)),
    ...(draft.from ? { from: draft.from } : {}),
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    html: draft.html,
    attachments: draft.attachments,
    signature: draft.signature,
  };
}

function contextFieldsOf(context: ReturnType<typeof contextFromDraft>) {
  return {
    accountId: context.accountId,
    mode: context.mode,
    ...(context.threadId ? { threadId: context.threadId } : {}),
    ...(context.replyToMessageId ? { replyToMessageId: context.replyToMessageId } : {}),
  };
}

function answerOf(call: Promise<{ readonly submission: Submission }>): Promise<SendAnswer> {
  return call.then(
    ({ submission }): SendAnswer => ({ type: 'sendAccepted', submission }),
    (error: unknown): SendAnswer => ({ type: 'sendRefused', refusal: refusalOf(error) }),
  );
}

/** The newest row this composer has for the submission an action names. */
function rowFor(state: ComposeState, submissionId: string): Submission | undefined {
  const send = state.send;
  return send.kind === 'tracking' && send.submissionId === submissionId
    ? (send.row ?? undefined)
    : undefined;
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
  // A create that has not been confirmed: its retries reuse the key, so a lost reply never makes a second draft.
  let pendingCreate: { readonly opId: string; readonly seq: number } | null = null;
  const mintOpId = deps.mintOpId ?? randomOpId;

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
        return runDestroy(effect.draftId, effect.quiet === true);
      case 'preserve':
        return runPreserve(effect.draft);
      case 'checkSent':
        return deps.checkSent?.();
      case 'notify':
        return deps.notify?.(effect.notice, effect.message);
    }
  }

  /** The key of this create: the first attempt's, while it is unconfirmed. */
  function createFor(seq: number): { readonly opId: string; readonly seq: number } {
    pendingCreate ??= { opId: mintOpId(), seq };
    return pendingCreate;
  }

  function saveTarget(effect: Extract<ComposeEffect, { type: 'save' }>) {
    if (effect.draftId !== null)
      return { id: effect.draftId, baseRevision: effect.baseRevision ?? undefined };
    return { opId: createFor(effect.seq).opId };
  }

  async function runSave(effect: Extract<ComposeEffect, { type: 'save' }>): Promise<void> {
    const fields = draftFieldsOf(effect.fields, effect.context);
    try {
      const { draft } = await deps.api.saveDraft({ ...saveTarget(effect), fields });
      // A replayed create answers with what the first attempt wrote: only that attempt's edits count as saved.
      const seq = effect.draftId === null ? (pendingCreate?.seq ?? effect.seq) : effect.seq;
      if (effect.draftId === null) pendingCreate = null;
      dispatch({ type: 'saved', seq, draft });
    } catch (error) {
      const cause = effect.draftId === null ? undefined : saveFailureOf(error);
      const now = deps.timers.now();
      dispatch({ type: 'saveFailed', seq: effect.seq, now, ...(cause ? { cause } : {}) });
    }
  }

  async function runPreserve(draft: Draft): Promise<void> {
    try {
      await deps.api.saveDraft({ fields: copyOf(draft) });
      dispatch({ type: 'preserved', ok: true, now: deps.timers.now() });
    } catch {
      dispatch({ type: 'preserved', ok: false, now: deps.timers.now() });
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
    const answer = answerOf(deps.api.setSubmission({ opId: effect.opId, action }));
    let stopWaiting: () => void = () => undefined;
    const timedOut = new Promise<null>(resolve => {
      stopWaiting = deps.timers.setTimeout(() => resolve(null), SEND_CONFIRM_MS);
    });
    const first = await Promise.race([answer, timedOut]);
    stopWaiting();
    if (first) return dispatch(first);
    // No answer yet: the queue moves on (saves, the hand-off) and the answer is still followed when it comes.
    dispatch({ type: 'sendUnconfirmed' });
    void answer.then(late => (disposed ? deps.onLateAnswer?.(late) : dispatch(late)));
  }

  async function runFollowUp(
    effect: Extract<ComposeEffect, { type: 'submission' }>,
  ): Promise<void> {
    try {
      const { submission } = await deps.api.setSubmission({ action: effect.action });
      dispatch({ type: 'observeSubmission', submission });
    } catch (error) {
      // Refused: the row's next frame says what happened, and the tray follows it. A refused Undo always says why.
      if (effect.action.type === 'undo') undoRefused(effect.action.submissionId, error);
    }
  }

  function undoRefused(submissionId: string, error: unknown): void {
    const row = rowFor(state, submissionId);
    const outcome = undoRefusalOutcome(refusalOf(error), row, deps.timers.now());
    if (outcome.kind === 'alreadySent') dispatch({ type: 'undoLost' });
    if (outcome.kind === 'refused') dispatch({ type: 'undoRefused', message: outcome.message });
  }

  async function runDestroy(draftId: string, quiet: boolean): Promise<void> {
    try {
      await deps.api.destroyDraft({ id: draftId });
      if (!quiet) dispatch({ type: 'discarded' });
    } catch {
      // A draft that only moved account and could not be removed stays in the old account's Drafts: nothing is lost.
      if (!quiet) dispatch({ type: 'discardFailed' });
    }
  }

  // A composer that starts with unsaved text (taken over from a closed one) saves it without waiting for a key.
  armTimer();

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
