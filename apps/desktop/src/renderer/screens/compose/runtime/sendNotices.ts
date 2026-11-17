/**
 * The notices a send leaves on the shell's toast stack once no composer shows it (DESIGN 7.6 "one notice per send",
 * 7.13, 7.15 Send failed): a refused or failed send ("Couldn’t send to Jordan. Your draft is saved." · Try again ·
 * Edit), a send later ("Scheduled for tomorrow, 8:00 AM" · Undo), an offline send ("Saved here · will sync"), an Undo
 * that came too late ("Already sent."), and the held sends behind the newest one (the newest is the toast's UndoTray).
 * Each toast's id is its send's, so a send never has two. A failed or unconfirmed send's toast stays until the owner acts
 * on it (a verb or Dismiss); there is no sidebar notice (owner, 2026-11-15). Nothing here sends mail by itself: every verb
 * is the owner's.
 */
import { api, getNow, type Submission } from '../../../data';
import { dismissToast, navigate, openCompose, openThread, pushToast } from '../../../shell';
import { UNDO_ACTION } from '../../undoOperation';
import { recipientPhrase } from '../model/recipients';
import { SEND_COPY } from '../model/sendState';
import { undoRefusalOutcome } from '../model/undoRefusal';
import { refusalOf } from './composeApi';
import { refusedNoticeId, releaseSend } from './sendHandoff';

const TRY_AGAIN = { id: 'retry', label: 'Try again' } as const;
const EDIT = { id: 'edit', label: 'Edit' } as const;
const SEND_NOW = { id: 'sendNow', label: 'Send now' } as const;
const CHECK_SENT = { id: 'checkSent', label: 'Check Sent' } as const;

/** A send the engine refused before it made a submission (the compose page had already closed). */
export interface RefusedSend {
  readonly draftId: string;
  readonly revision: number;
  readonly names: readonly string[];
  readonly notBefore?: number;
  readonly alsoDone?: boolean;
}

/** "Already sent.": an Undo reached the engine after the send had left. */
export function pushAlreadySent(id: string): void {
  pushToast({
    id: `send-late-undo-${id}`,
    kind: 'error',
    message: SEND_COPY.alreadySent,
    undoable: false,
  });
}

/** A refused Undo the engine explained: its own sentence (or the plain fallback), never nothing. */
function pushUndoRefused(id: string, message: string): void {
  pushToast({ id: `send-undo-refused-${id}`, kind: 'error', message, undoable: false });
}

/**
 * Undo for a submission. `row` is the newest row the caller shows for it (a frame may be behind the engine). A send that
 * already left says "Already sent." (the engine's `stateMismatch` or the fixture's `conflict`); any other refusal says
 * why.
 */
export function undoSubmission(id: string, row?: Submission): void {
  void api.submission
    .set({ action: { type: 'undo', submissionId: id } })
    .then(() => reopenSend(row))
    .catch(error => {
      const outcome = undoRefusalOutcome(refusalOf(error), row, getNow());
      if (outcome.kind === 'alreadySent') pushAlreadySent(id);
      if (outcome.kind === 'refused') pushUndoRefused(id, outcome.message);
    });
}

/**
 * An Undo that came from the toast (no composer was showing the send) brings the writing back, as Gmail does, instead
 * of leaving it in Drafts unseen: a reply opens its thread with the reply card on the draft; anything else opens the
 * compose page on the draft.
 */
export function reopenSend(row: Pick<Submission, 'draftId' | 'threadId'> | undefined): void {
  if (!row) return;
  if (row.threadId) {
    openThread(row.threadId, {
      reply: { replyAll: false, dictate: false, nudge: false, draftId: row.draftId },
    });
    return;
  }
  openCompose({ draftId: row.draftId });
}

function unconfirmedToastId(key: string): string {
  return `send-unconfirmed-${key}`;
}

/** "Couldn’t confirm this was sent." · Check Sent, for a send whose `Submission/set` never answered before its page went. It stays until acted on. */
export function pushUnconfirmedSend(key: string): void {
  pushToast({
    id: unconfirmedToastId(key),
    kind: 'error',
    message: SEND_COPY.unconfirmed,
    actions: [CHECK_SENT],
    undoable: false,
    persistent: true,
    onAction: actionId => {
      if (actionId === CHECK_SENT.id) navigate('sent');
    },
  });
}

/** The late answer came: the unconfirmed notice goes (the stack follows the send, or says it failed). */
export function dropUnconfirmedSend(key: string): void {
  dismissToast(unconfirmedToastId(key));
}

/**
 * A failed send is one error toast that stays until the owner acts on it: Try again, Edit or Dismiss (owner,
 * 2026-11-15). There is no sidebar notice. The draft is always saved.
 */
function pushFailure(id: string, recipient: string, onAction: (actionId: string) => void): void {
  pushToast({
    id,
    kind: 'error',
    message: SEND_COPY.failed(recipient),
    actions: [TRY_AGAIN, EDIT],
    undoable: false,
    persistent: true,
    onAction,
  });
}

/** Sends a refused draft again with what the press asked for; a second refusal comes back as the same notice. */
function sendAgain(refused: RefusedSend): void {
  const action = {
    type: 'send',
    draftId: refused.draftId,
    revision: refused.revision,
    ...(refused.alsoDone ? { alsoDone: true } : {}),
    ...(refused.notBefore !== undefined && refused.notBefore > getNow()
      ? { notBefore: refused.notBefore }
      : {}),
  } as const;
  api.submission
    .set({ action })
    .then(({ submission }) => releaseSend(submission.id, true, submission))
    .catch(() => pushRefusedSend(refused));
}

/** "Couldn’t send to Jordan. Your draft is saved." · Try again · Edit, for a send refused with no thread showing it. */
export function pushRefusedSend(refused: RefusedSend): void {
  const id = refusedNoticeId(refused.draftId);
  const recipient = recipientPhrase(refused.names);
  pushFailure(id, recipient, actionId => {
    if (actionId === TRY_AGAIN.id) sendAgain(refused);
    if (actionId === EDIT.id) openCompose({ draftId: refused.draftId });
  });
}

/** Edit after a failed send: the submission lets the draft go, then the compose page opens on it. */
function editFailed(row: Submission): void {
  void api.submission
    .set({ action: { type: 'cancel', submissionId: row.id } })
    .then(() => openCompose({ draftId: row.draftId }))
    .catch(() => undefined);
}

/** Try again after a failed send: the stack follows it again, so its next phase is shown too. */
function retryFailed(row: Submission): void {
  void api.submission
    .set({ action: { type: 'retry', submissionId: row.id, revision: row.revision } })
    .then(() => releaseSend(row.id, true))
    .catch(() => pushFailedSubmission(row));
}

/** The same notice for a handed-off submission that failed; one per failure (`rev`). */
export function pushFailedSubmission(row: Submission): void {
  const recipient = recipientPhrase(row.toNames);
  pushFailure(`send-failed-${row.id}-${row.rev}`, recipient, actionId => {
    if (actionId === TRY_AGAIN.id) retryFailed(row);
    if (actionId === EDIT.id) editFailed(row);
  });
}

/** "Scheduled for …" · Undo, or "Saved here · will sync", once per send. */
export function pushSendNotice(id: string, kind: 'scheduled' | 'offline', message: string): void {
  const undoable = kind === 'scheduled';
  pushToast({
    id: `send-${id}:${kind}`,
    kind: kind === 'offline' ? 'offline' : 'info',
    message,
    actions: undoable ? [UNDO_ACTION] : [],
    undoable,
    onAction: actionId => {
      if (actionId === UNDO_ACTION.id) undoSubmission(id);
    },
  });
}

/** The toast id of a held send shown behind the newest one. */
export function heldToastId(id: string): string {
  return `send-held-${id}`;
}

/** A held send behind the newest: "Sending to Mina in 6 s" · Undo · Send now, an Undo toast (never evicted). */
export function pushHeldSend(row: Submission, recipients: string, secondsLeft: number): void {
  pushToast({
    id: heldToastId(row.id),
    kind: 'info',
    message: `Sending to ${recipients} in ${Math.max(0, Math.ceil(secondsLeft))} s`,
    actions: [{ id: UNDO_ACTION.id, label: UNDO_ACTION.label }, SEND_NOW],
    undoable: true,
    persistent: true,
    onAction: actionId => {
      if (actionId === UNDO_ACTION.id) undoSubmission(row.id, row);
      if (actionId === SEND_NOW.id)
        void api.submission
          .set({ action: { type: 'sendNow', submissionId: row.id, revision: row.revision } })
          .catch(() => undefined);
    },
  });
}

/** The held toast goes once that send is the newest (its tray takes over) or no longer held. */
export function dropHeldSend(id: string): void {
  dismissToast(heldToastId(id));
}
