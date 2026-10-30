/**
 * The send half of the composer reducer (DESIGN 7.6 Send; ARCH 7.1-7.3). Sending is one `Submission/set send` per
 * press, after the edits are saved; a second press while a send is pending or tracked does nothing; the engine row is
 * the truth once it exists, and every later verb names that row.
 */
import type { Submission } from '../../../data';
import { isDirty, noteEdit, startSave } from './autosave';
import type { ComposeEffect, ComposeEvent, ComposeState, Refusal, Step } from './composeState';
import { sendOpId } from './composeState';
import { blockedSend, namesOf } from './recipients';
import { NO_SEND, type SendAction } from './sendState';

type Event<T extends ComposeEvent['type']> = Extract<ComposeEvent, { type: T }>;

const still = (state: ComposeState): Step => ({ state, effects: [] });

/** The save effect for the current edits, and the state that marks it in flight. */
export function saveStep(state: ComposeState): Step {
  const save = startSave(state.save);
  const effect: ComposeEffect = {
    type: 'save',
    seq: save.editSeq,
    fields: state.fields,
    context: state.context,
    draftId: state.save.draftId,
    baseRevision: state.save.revision,
  };
  return { state: { ...state, save }, effects: [effect] };
}

/** The submit effect, once the draft on the engine holds every edit. */
export function submitStep(state: ComposeState): Step {
  const { send, save } = state;
  if (send.kind !== 'pending' || save.draftId === null || save.revision === null)
    return still(state);
  const effect: ComposeEffect = {
    type: 'submit',
    opId: sendOpId(save.draftId, save.revision, save.rowRev, state.attempt),
    draftId: save.draftId,
    revision: save.revision,
    alsoDone: send.alsoDone,
    ...(send.notBefore !== undefined ? { notBefore: send.notBefore } : {}),
  };
  return { state, effects: [effect] };
}

/** Return or ⌘↩: validate, close the composer at once, then save what is unsaved and send. */
export function onSend(state: ComposeState, event: Event<'send'>): Step {
  if (state.send.kind === 'pending' || state.send.kind === 'tracking' || state.discarding)
    return still(state);
  const blocked = blockedSend(state.fields);
  if (blocked) return still({ ...state, blocked, open: true });
  const pending: ComposeState = {
    ...state,
    blocked: null,
    open: false,
    confirm: null,
    suggestion: null,
    send: {
      kind: 'pending',
      pressedAt: event.now,
      undoSeconds: event.undoSeconds,
      names: namesOf(state.fields),
      alsoDone: event.alsoDone ?? false,
      undoAsked: false,
      sendNowAsked: false,
      ...(event.notBefore !== undefined ? { notBefore: event.notBefore } : {}),
    },
  };
  if (pending.save.flightSeq !== null) return still(pending);
  const needsSave = pending.save.draftId === null || isDirty(pending.save);
  if (!needsSave) return submitStep(pending);
  const edited =
    pending.save.draftId === null
      ? { ...pending, save: noteEdit(pending.save, event.now) }
      : pending;
  return saveStep(edited);
}

function followUpsAfterAccept(
  state: ComposeState,
  row: Submission,
  asked: { undo: boolean; now: boolean },
): Step {
  if (asked.undo)
    return {
      state,
      effects: [{ type: 'submission', action: { type: 'undo', submissionId: row.id } }],
    };
  if (asked.now) {
    const action = { type: 'sendNow', submissionId: row.id, revision: row.revision } as const;
    return { state, effects: [{ type: 'submission', action }] };
  }
  return still(state);
}

/** The engine took the send: follow its row, and send an Undo or Send now pressed before the answer. */
export function onAccepted(state: ComposeState, event: Event<'sendAccepted'>): Step {
  const row = event.submission;
  if (row.state === 'cancelled')
    return still({ ...state, send: NO_SEND, open: true, attempt: state.attempt + 1 });
  const asked =
    state.send.kind === 'pending'
      ? { undo: state.send.undoAsked, now: state.send.sendNowAsked }
      : { undo: false, now: false };
  const tracking: ComposeState = {
    ...state,
    send: { kind: 'tracking', submissionId: row.id, row },
  };
  return followUpsAfterAccept(tracking, row, asked);
}

function blockedFrom(refusal: Refusal): ComposeState['blocked'] {
  return { field: refusal.type === 'validation' ? 'to' : 'body', message: refusal.message };
}

/** The engine refused the send. A send already on its way is not an error: the draft row will name it. */
export function onRefused(state: ComposeState, event: Event<'sendRefused'>): Step {
  const { refusal } = event;
  if (state.send.kind !== 'pending') return still(state);
  if (refusal.type === 'conflict') return still(state);
  if (refusal.type === 'validation' || refusal.type === 'stateMismatch')
    return still({ ...state, send: NO_SEND, open: true, blocked: blockedFrom(refusal) });
  const names = state.send.names;
  const reasonCode = refusal.reasonCode ?? refusal.type;
  const until = refusal.resumeAt;
  return still({
    ...state,
    send: { kind: 'refused', names, reasonCode, ...(until !== undefined ? { until } : {}) },
  });
}

/** A frame for the tracked submission: newer rows replace older ones; a cancelled send hands the draft back. */
export function onSubmission(state: ComposeState, event: Event<'observeSubmission'>): Step {
  const row = event.submission;
  if (state.send.kind !== 'tracking' || state.send.submissionId !== row.id) return still(state);
  if (state.send.row && state.send.row.rev > row.rev) return still(state);
  if (row.state === 'cancelled') {
    const reopen = state.ended !== 'discarded';
    return still({
      ...state,
      send: NO_SEND,
      open: reopen,
      ended: reopen ? null : state.ended,
      attempt: state.attempt + 1,
    });
  }
  const ended = row.state === 'sent' ? 'sent' : state.ended;
  return still({ ...state, send: { ...state.send, row }, ended });
}

const WAITING = new Set(['queued', 'scheduled']);

function rowAction(state: ComposeState, event: Event<'action'>, row: Submission): Step {
  const id = row.id;
  const revision = row.revision;
  const send = (action: ComposeEffect & { type: 'submission' }): Step => ({
    state,
    effects: [action],
  });
  const waiting = WAITING.has(row.state);
  switch (event.action) {
    case 'undo':
      return waiting
        ? send({ type: 'submission', action: { type: 'undo', submissionId: id } })
        : still(state);
    case 'sendNow':
      return waiting || row.state === 'suspended'
        ? send({ type: 'submission', action: { type: 'sendNow', submissionId: id, revision } })
        : still(state);
    case 'sendAnyway':
      return row.state === 'uncertain'
        ? send({ type: 'submission', action: { type: 'sendAnyway', submissionId: id, revision } })
        : still(state);
    case 'retry':
      return row.state === 'failed'
        ? send({ type: 'submission', action: { type: 'retry', submissionId: id, revision } })
        : still(state);
    case 'edit':
      return ['failed', 'uncertain', 'suspended'].includes(row.state)
        ? send({ type: 'submission', action: { type: 'cancel', submissionId: id } })
        : still(state);
    case 'reschedule':
      return event.notBefore !== undefined && (waiting || row.state === 'suspended')
        ? send({
            type: 'submission',
            action: { type: 'reschedule', submissionId: id, notBefore: event.notBefore },
          })
        : still(state);
    case 'checkSent':
      return { state, effects: [{ type: 'checkSent' }] };
  }
}

function pendingAction(state: ComposeState, action: SendAction): Step {
  if (state.send.kind !== 'pending') return still(state);
  if (action === 'undo') return still({ ...state, send: { ...state.send, undoAsked: true } });
  if (action === 'sendNow') return still({ ...state, send: { ...state.send, sendNowAsked: true } });
  return still(state);
}

function refusedAction(state: ComposeState, action: SendAction): Step {
  if (state.send.kind !== 'refused') return still(state);
  if (action === 'edit') return still({ ...state, send: NO_SEND, open: true, ended: null });
  if (action !== 'retry') return still(state);
  const names = state.send.names;
  const pending: ComposeState = {
    ...state,
    send: {
      kind: 'pending',
      pressedAt: 0,
      undoSeconds: 0,
      names,
      alsoDone: false,
      undoAsked: false,
      sendNowAsked: false,
    },
  };
  return submitStep(pending);
}

/** A verb from the tray, the send-failed line or Z. */
export function onAction(state: ComposeState, event: Event<'action'>): Step {
  switch (state.send.kind) {
    case 'pending':
      return pendingAction(state, event.action);
    case 'refused':
      return refusedAction(state, event.action);
    case 'tracking':
      return state.send.row ? rowAction(state, event, state.send.row) : still(state);
    default:
      return still(state);
  }
}
