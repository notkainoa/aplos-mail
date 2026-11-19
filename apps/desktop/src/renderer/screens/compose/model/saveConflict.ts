/**
 * When the engine refuses a save (ARCH 7.4 compare-and-set): the composer never loops on the same base revision and
 * never drops text. The draft is gone → the local text becomes a new draft. Another window is sending the draft (a live
 * submission locks it) → the local text becomes a new draft, the sending one is left alone, and the composer says
 * "This draft is being sent from another window." (a send pressed meanwhile stops; Send again is explicit). A newer
 * revision from another window → that revision is first kept as a draft of its own, then the local text is saved on top
 * as the next revision (local wins, nothing is overwritten silently). A send pressed meanwhile stops, and the composer
 * comes back.
 */
import type { Draft } from '../../../data';
import { failSave, isDirty } from './autosave';
import type { ComposeState, SaveFailure, Step } from './composeState';
import { fieldsFromDraft, type ComposeFields } from './fields';
import { NO_SEND, SEND_COPY } from './sendState';
import { saveStep, submitStep } from './sendReducer';

const still = (state: ComposeState): Step => ({ state, effects: [] });

/** A pending send cannot name edits the engine never took: the composer comes back with them. */
function stopPendingSend(state: ComposeState): ComposeState {
  if (state.send.kind !== 'pending') return state;
  return { ...state, send: NO_SEND, open: true, ended: null };
}

/** The local text goes to a brand-new draft, saved at once. */
export function forkLocal(state: ComposeState, now: number): Step {
  const save = {
    ...state.save,
    draftId: null,
    revision: null,
    rowRev: null,
    flightSeq: null,
    failures: 0,
    lastFailAt: null,
    waitingForRemote: false,
    firstDirtyAt: now,
    lastEditAt: now,
  };
  const { remote: _gone, ...rest } = stopPendingSend(state);
  void _gone;
  return saveStep({ ...rest, save });
}

function sameRecipients(a: ComposeFields['to'], b: ComposeFields['to']): boolean {
  return a.length === b.length && a.every((r, i) => r.id === b[i]!.id);
}

/** True when the remote row already says what the composer holds. */
export function sameText(remote: Draft, fields: ComposeFields): boolean {
  const theirs = fieldsFromDraft(remote);
  return (
    theirs.body === fields.body &&
    theirs.subject === fields.subject &&
    sameRecipients(theirs.to, fields.to) &&
    sameRecipients(theirs.cc, fields.cc) &&
    sameRecipients(theirs.bcc, fields.bcc)
  );
}

/** True once `remote` says why the save was refused: a live send holds it, or it is a newer revision. */
export function explainsRefusal(state: ComposeState, remote: Draft): boolean {
  return remote.submissionId !== undefined || remote.revision > (state.save.revision ?? 0);
}

/** The remote row matches the local text: adopt its revision, nothing to write. */
function adoptSame(state: ComposeState, remote: Draft): Step {
  const save = {
    ...state.save,
    revision: remote.revision,
    rowRev: remote.rev,
    savedSeq: state.save.editSeq,
    flightSeq: null,
    failures: 0,
    lastFailAt: null,
    waitingForRemote: false,
    firstDirtyAt: null,
  };
  const next = { ...state, save };
  return next.send.kind === 'pending' ? submitStep(next) : still(next);
}

/**
 * Another window's send holds the draft: the local text becomes a draft of its own, and the composer says so. It never
 * sends that copy by itself: a send pressed here stopped, and only a second, explicit Send mails it.
 */
function forkFromSend(state: ComposeState, now: number): Step {
  const step = forkLocal(state, now);
  const blocked = { field: 'body', message: SEND_COPY.sendingElsewhere } as const;
  return { ...step, state: { ...step.state, blocked } };
}

/** Resolves a refused save against the newer row. */
export function resolveRemote(state: ComposeState, remote: Draft, now: number): Step {
  if (remote.submissionId !== undefined) return forkFromSend(state, now);
  if (sameText(remote, state.fields)) return adoptSame(state, remote);
  // The copy is the save in flight: nothing else writes, and a newer row does not start a second copy.
  const save = { ...state.save, waitingForRemote: false, flightSeq: state.save.editSeq };
  return { state: { ...state, save }, effects: [{ type: 'preserve', draft: remote }] };
}

/** The remote revision is kept as its own draft (or could not be): save the local text on top, or fork it. */
export function onPreserved(state: ComposeState, ok: boolean, now: number): Step {
  const remote = state.remote;
  if (!remote) return forkLocal(state, now);
  if (!ok) return forkLocal(state, now);
  const save = {
    ...state.save,
    revision: remote.revision,
    rowRev: remote.rev,
    failures: 0,
    lastFailAt: null,
  };
  return saveStep({ ...state, save });
}

/** A save the engine refused for a reason a retry cannot fix. */
export function onRefusedSave(state: ComposeState, cause: SaveFailure, now: number): Step {
  if (cause === 'gone') return forkLocal(state, now);
  const failed = stopPendingSend({ ...state, save: failSave(state.save, now) });
  const remote = failed.remote;
  if (remote && explainsRefusal(failed, remote)) return resolveRemote(failed, remote, now);
  return still({ ...failed, save: { ...failed.save, waitingForRemote: true } });
}

/** A new row for the draft: it may be the one a refused save is waiting for. */
export function onRemoteRow(state: ComposeState, remote: Draft, now: number): Step | null {
  const waiting = state.save.waitingForRemote && state.save.flightSeq === null;
  if (!waiting || !isDirty(state.save) || !explainsRefusal(state, remote)) return null;
  return resolveRemote(state, remote, now);
}
