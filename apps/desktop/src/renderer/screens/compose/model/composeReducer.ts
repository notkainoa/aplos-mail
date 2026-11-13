/**
 * The composer reducer (DESIGN 7.6): edits, autosave, Esc, discard, the dim suggestion and dictation here; the send
 * half in `sendReducer.ts`. Pure: `(state, event) → {state, effects}`. Three promises it keeps, which the fuzz checks:
 * a draft is never discarded without the confirmation, the text the engine confirmed is never thrown away, and one
 * press makes at most one `Submission/set send`.
 */
import {
  FRESH_SAVE,
  failSave,
  finishSave,
  isDirty,
  noteEdit,
  retryNow,
  saveIsDue,
} from './autosave';
import type { ComposeEffect, ComposeEvent, ComposeState, Step } from './composeState';
import { fieldsFromDraft, isBlank, type ComposeFields } from './fields';
import {
  onAccepted,
  onAction,
  onRefused,
  onSend,
  onSubmission,
  onUnconfirmed,
  saveStep,
  submitStep,
} from './sendReducer';
import { onPreserved, onRefusedSave, onRemoteRow } from './saveConflict';
import { NO_SEND } from './sendState';

type Event<T extends ComposeEvent['type']> = Extract<ComposeEvent, { type: T }>;

const still = (state: ComposeState): Step => ({ state, effects: [] });

function saveIfDue(state: ComposeState, now: number): Step {
  if (state.discarding || !saveIsDue(state.save, now)) return still(state);
  return saveStep(state);
}

function touches(patch: Partial<ComposeFields>, keys: readonly (keyof ComposeFields)[]): boolean {
  return keys.some(key => patch[key] !== undefined);
}

function onEdit(state: ComposeState, event: Event<'edit'>): Step {
  if (!state.open || state.discarding) return still(state);
  const { patch } = event;
  const next: ComposeState = {
    ...state,
    fields: { ...state.fields, ...patch },
    save: noteEdit(state.save, event.now),
    suggestion: patch.body !== undefined ? null : state.suggestion,
    blocked: touches(patch, ['to', 'cc', 'bcc', 'body', 'subject']) ? null : state.blocked,
  };
  return saveIfDue(next, event.now);
}

/** The draft From left behind in the old account goes once its replacement is saved (or the composer is discarded). */
function leavingEffects(state: ComposeState, keep: string | undefined): ComposeEffect[] {
  const old = state.leaving;
  return old !== undefined && old !== keep ? [{ type: 'destroy', draftId: old, quiet: true }] : [];
}

function onSaved(state: ComposeState, event: Event<'saved'>): Step {
  const next: ComposeState = {
    ...state,
    save: finishSave(state.save, event.seq, event.draft),
    leaving: undefined,
  };
  const old = leavingEffects(state, event.draft.id);
  if (state.discarding)
    return {
      state: next,
      effects: [...old, { type: 'destroy', draftId: event.draft.id }],
    };
  if (state.send.kind !== 'pending') return { state: next, effects: old };
  const step = isDirty(next.save) ? saveStep(next) : submitStep(next);
  return { state: step.state, effects: [...old, ...step.effects] };
}

function onSaveFailed(state: ComposeState, event: Event<'saveFailed'>): Step {
  const next: ComposeState = { ...state, save: failSave(state.save, event.now) };
  if (state.discarding) {
    const id = next.save.draftId;
    return id ? { state: next, effects: [{ type: 'destroy', draftId: id }] } : discardedStep(next);
  }
  // Gone, stale or locked: a retry on the same base would fail for ever, so the text moves on (saveConflict.ts).
  if (event.cause && state.save.draftId !== null)
    return onRefusedSave(
      { ...state, save: { ...state.save, flightSeq: null } },
      event.cause,
      event.now,
    );
  // The edits never reached the engine: the send cannot name them, so the composer comes back with "Couldn't save".
  if (state.send.kind === 'pending')
    return still({ ...next, send: NO_SEND, open: true, ended: null });
  return still(next);
}

function adoptDraft(
  state: ComposeState,
  draft: NonNullable<Event<'observeDraft'>['draft']>,
): ComposeState {
  const save = state.save;
  if (draft.revision === save.revision)
    return { ...state, save: { ...save, rowRev: Math.max(save.rowRev ?? 0, draft.rev) } };
  const quiet = !isDirty(save) && save.flightSeq === null && draft.revision > (save.revision ?? 0);
  if (!quiet) return state;
  // Another window saved a newer revision while this one had nothing unsaved: show it.
  return {
    ...state,
    fields: fieldsFromDraft(draft),
    save: { ...save, revision: draft.revision, rowRev: draft.rev },
  };
}

/** Undo pressed before the engine answered: it follows the submission as soon as its id is known. */
function trackFoundSend(state: ComposeState, submissionId: string): Step {
  const undo = state.send.kind === 'pending' && state.send.undoAsked;
  const next: ComposeState = {
    ...state,
    open: false,
    send: { kind: 'tracking', submissionId, row: null },
  };
  if (!undo) return still(next);
  return { state: next, effects: [{ type: 'submission', action: { type: 'undo', submissionId } }] };
}

function onDraft(state: ComposeState, event: Event<'observeDraft'>): Step {
  const draft = event.draft;
  if (!draft || draft.id !== state.save.draftId) return still(state);
  const next: ComposeState = { ...adoptDraft(state, draft), remote: draft };
  if (next.discarding) return still(next);
  const resolved = onRemoteRow(next, draft, event.now ?? 0);
  if (resolved) return resolved;
  const untracked =
    next.send.kind === 'none' || next.send.kind === 'pending' || next.send.kind === 'refused';
  // Unsaved text is never closed away under another window's send (this composer's own send names saved text only):
  // its save fails and moves it to a new draft.
  const unsaved = isDirty(next.save);
  // A send of this draft exists (this composer's answer is late, another composer sent it, or the app reloaded).
  if (draft.submissionId && untracked && !unsaved) return trackFoundSend(next, draft.submissionId);
  return still(next);
}

/**
 * From (the account a new message is written in). A draft belongs to one account for good, so one the engine already
 * holds is saved again in the account chosen and only then destroyed (quietly), so the text is never in memory alone. Only a new message can change
 * account (a reply belongs to the thread's), and only while nothing is in flight: a save that is mid-air, a send, a
 * discard or a conflict wait would race the move.
 */
export function canChangeAccount(state: ComposeState): boolean {
  return (
    state.open &&
    !state.discarding &&
    state.context.mode === 'new' &&
    state.send.kind === 'none' &&
    state.save.flightSeq === null &&
    !state.save.waitingForRemote
  );
}

function onSetAccount(state: ComposeState, event: Event<'setAccount'>): Step {
  if (!canChangeAccount(state) || state.context.accountId === event.accountId) return still(state);
  const context = { ...state.context, accountId: event.accountId };
  const old = state.save.draftId;
  // Nothing saved yet, or the first save is still being retried: only the account changes (the session mints a new create key).
  if (old === null) return still({ ...state, context });
  const moved: ComposeState = {
    ...state,
    context,
    save: noteEdit(FRESH_SAVE, event.now),
    leaving: old,
    remote: undefined,
    attempt: 0,
  };
  return saveIfDue(moved, event.now);
}

function onEscape(state: ComposeState): Step {
  if (state.suggestion) return still({ ...state, suggestion: null });
  if (state.confirm) return still({ ...state, confirm: null });
  if (!state.open) return still(state);
  // Closing now would drop text the engine never took: ask, the same as Discard (no prompt once saved).
  if (state.save.failures > 0 && isDirty(state.save))
    return still({ ...state, confirm: 'discard' });
  const closed: ComposeState = { ...state, open: false, ended: 'closed' };
  return isDirty(closed.save) && closed.save.flightSeq === null ? saveStep(closed) : still(closed);
}

function onAskDiscard(state: ComposeState): Step {
  if (!state.open) return still(state);
  const nothing =
    state.save.draftId === null && state.save.flightSeq === null && isBlank(state.fields);
  if (nothing) return still({ ...state, open: false, ended: 'closed' });
  return still({ ...state, confirm: 'discard' });
}

function discardedStep(state: ComposeState): Step {
  return { state, effects: [{ type: 'notify', notice: 'discarded' }] };
}

function onConfirmDiscard(state: ComposeState): Step {
  if (state.confirm !== 'discard') return still(state);
  const next: ComposeState = {
    ...state,
    confirm: null,
    open: false,
    ended: 'discarded',
    discarding: true,
    suggestion: null,
  };
  // A save in flight may be creating the draft: the destroy follows its answer (`onSaved`).
  if (state.save.flightSeq !== null) return still(next);
  const id = state.save.draftId;
  const old = leavingEffects(state, id ?? undefined);
  if (id) return { state: next, effects: [...old, { type: 'destroy', draftId: id }] };
  return old.length > 0
    ? { state: next, effects: [...old, ...discardedStep(next).effects] }
    : discardedStep(next);
}

function onDiscardFailed(state: ComposeState): Step {
  const back: ComposeState = { ...state, discarding: false, ended: null, open: true };
  return { state: back, effects: [{ type: 'notify', notice: 'discardFailed' }] };
}

function onSuggest(state: ComposeState, event: Event<'suggest'>): Step {
  if (!state.open || state.fields.body.trim() !== '' || event.suggestion.text.trim() === '')
    return still(state);
  return still({ ...state, suggestion: event.suggestion });
}

function appendText(body: string, text: string): string {
  if (body === '') return text;
  return /\s$/.test(body) ? `${body}${text}` : `${body} ${text}`;
}

function onKeepSuggestion(state: ComposeState, event: Event<'keepSuggestion'>): Step {
  if (!state.suggestion) return still(state);
  const body = appendText(state.fields.body, state.suggestion.text);
  return onEdit({ ...state, suggestion: null }, { type: 'edit', patch: { body }, now: event.now });
}

function onDictated(state: ComposeState, event: Event<'dictated'>): Step {
  if (event.text.trim() === '') return still(state);
  const body = appendText(state.fields.body, event.text.trim());
  return onEdit(state, { type: 'edit', patch: { body }, now: event.now });
}

function onReopen(state: ComposeState): Step {
  if (state.ended === 'discarded' || state.ended === 'sent') return still(state);
  if (state.send.kind === 'pending' || state.send.kind === 'tracking') return still(state);
  return still({ ...state, open: true, ended: null, send: NO_SEND });
}

type SaveEvent = Extract<
  ComposeEvent,
  {
    type:
      | 'edit'
      | 'tick'
      | 'flush'
      | 'saved'
      | 'saveFailed'
      | 'preserved'
      | 'retrySave'
      | 'observeDraft';
  }
>;

const SAVE_EVENTS: ReadonlySet<ComposeEvent['type']> = new Set([
  'edit',
  'tick',
  'flush',
  'saved',
  'saveFailed',
  'preserved',
  'retrySave',
  'observeDraft',
]);

function isSaveEvent(event: ComposeEvent): event is SaveEvent {
  return SAVE_EVENTS.has(event.type);
}

/** The text and its autosave: edits, the timer, the engine's answers and rows. */
function saveReducer(state: ComposeState, event: SaveEvent): Step {
  switch (event.type) {
    case 'edit':
      return onEdit(state, event);
    case 'tick':
      return saveIfDue(state, event.now);
    case 'flush':
      return saveIfDue(state, Number.POSITIVE_INFINITY);
    case 'saved':
      return onSaved(state, event);
    case 'saveFailed':
      return onSaveFailed(state, event);
    case 'preserved':
      return state.discarding ? still(state) : onPreserved(state, event.ok, event.now);
    case 'retrySave':
      return saveIfDue({ ...state, save: retryNow(state.save, event.now) }, event.now);
    case 'observeDraft':
      return onDraft(state, event);
  }
}

/** One step of the composer. */
export function composeReducer(state: ComposeState, event: ComposeEvent): Step {
  if (isSaveEvent(event)) return saveReducer(state, event);
  switch (event.type) {
    case 'setAccount':
      return onSetAccount(state, event);
    case 'undoLost':
      return { state, effects: [{ type: 'notify', notice: 'alreadySent' }] };
    case 'undoRefused':
      return {
        state,
        effects: [{ type: 'notify', notice: 'undoRefused', message: event.message }],
      };
    case 'sendUnconfirmed':
      return onUnconfirmed(state);
    case 'observeSubmission':
      return onSubmission(state, event);
    case 'send':
      return onSend(state, event);
    case 'sendAccepted':
      return onAccepted(state, event);
    case 'sendRefused':
      return onRefused(state, event);
    case 'action':
      return onAction(state, event);
    case 'escape':
      return onEscape(state);
    case 'askDiscard':
      return onAskDiscard(state);
    case 'confirmDiscard':
      return onConfirmDiscard(state);
    case 'cancelDiscard':
      return still({ ...state, confirm: null });
    case 'discarded':
      return discardedStep(state);
    case 'discardFailed':
      return onDiscardFailed(state);
    case 'suggest':
      return onSuggest(state, event);
    case 'keepSuggestion':
      return onKeepSuggestion(state, event);
    case 'dismissSuggestion':
      return still({ ...state, suggestion: null });
    case 'dictated':
      return onDictated(state, event);
    case 'reopen':
      return onReopen(state);
  }
}
