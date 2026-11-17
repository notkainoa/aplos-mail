/**
 * What the reader's commands do (DESIGN 7.5, 7.13, 8): J and K step through the list the reader was opened from, and
 * Done, Later and Trash act on the letter on paper, leave at once, and open the next thread (or go back to the list
 * when none is left). Each write is optimistic through `api.thread.act`, raises one toast keyed by its opId with a
 * per-operation Undo, and says plainly when the engine refuses. The screen supplies the live state and the side effects
 * as `ReaderDeps`, so there is no React here and the tests drive it with the stand-in engine.
 */
import { undoStack, type DataApi, type ThreadAction, type ThreadRow } from '../../data';
import type { PushedToast } from '../../shell';
import { UNDO_ACTION, afterAccepted, undated, undoHandler } from '../undoOperation';
import { failurePhrase, namedToast, senderOf, suggestedLabel } from '../home/homeRows';
import type { MovableLane } from '../home/homeModel';
import { LANE_LABEL } from './readerLane';
import { suggestionFor } from './readerRows';
import type { CursorDirection } from './model/threadCursor';
import { afterRemoval, stepThread } from './readerModel';
import type { SuggestedAction } from '../../ui/props';
import { PLAIN_REPLY, type ReplyRequest } from './readerUi';

/** The screen's side of the actions. */
export interface ReaderDeps {
  /** The thread on paper; null before the first letter. */
  shown(): string | null;
  /** The thread J and K move from: the one asked for last. */
  wanted(): string | null;
  /** The ordered list the reader was opened from. */
  ids(): readonly string[];
  rowOf(id: string): ThreadRow | undefined;
  /** Opens a thread in the reader (the shell's `openThread`). */
  go(id: string): void;
  /**
   * A thread was sent away (Done, Later, Trash) or came back (Undo). A list the screen was opened with is a snapshot, so
   * the screen uses this to keep J and K off threads this reading has already handled.
   */
  markGone(id: string, gone: boolean): void;
  /** Undo of Done, Later or Trash: brings the reader back to the thread, but only while the reader is still open. */
  reopen(id: string): void;
  /** The thread on paper was read from Trash or Spam, so Restore applies (the ⋯ menu offers it, and so does the palette). */
  restorable(): boolean;
  /** Esc, or no thread left: close the reader and show the screen it was opened from. */
  leave(): void;
  /** Closes find on the letter on paper when it is open; true when it was (Esc then has done its job). */
  closeFind(): boolean;
  act: DataApi['thread']['act'];
  push(toast: PushedToast): string;
  dismiss(id: string): void;
  /** The confirmed toast text of a command, read from the registry. */
  undoLabel(commandId: string, fallback: string): string;
  /** Opens the compose page on a forward of this thread's latest message. */
  forward(id: string): void;
  /** Opens the inline reply under the thread (R, ⇧R, hold R, a Reply suggestion). */
  reply(id: string, request?: ReplyRequest): void;
  /** Any suggestion that is not a reply or Done ("View invoice", "Add to calendar"): a later slice's, the screen forwards it. */
  suggested(id: string, action: SuggestedAction): void;
}

/** `go`, but only while the reader is still open: an Undo that lands after Esc must not pull the owner back into it. */
export function whileOpen(
  open: { readonly current: boolean },
  go: (id: string) => void,
): (id: string) => void {
  return id => {
    if (open.current) go(id);
  };
}

/** The commands the reader answers, as plain functions. */
export interface ReaderActions {
  step(direction: CursorDirection): void;
  done(): void;
  later(): void;
  trash(): void;
  /** A thread read from Trash or Spam goes back (to its lane, else the Inbox), leaving the reader like Done. */
  restore(): void;
  bookmark(): void;
  /** U: marks an unread thread read (the reader stays on it); a read thread is marked unread and the reader returns to its list, like Gmail. */
  toggleRead(): void;
  /** F: forwards the thread on paper. */
  forward(): void;
  /** The Importance menu: moves the thread to a lane (the same absolute move as Home's ⌥↑ / ⌥↓); the reader stays on it. */
  lane(to: MovableLane): void;
  /** Z: undoes the newest change; a Done, Later or Trash of this reading brings its thread back, however it is undone. */
  undo(): void;
  /** Space: the filled button's action. */
  suggest(): void;
  /** The palette's name for Space on this thread: "Reply to Jordan Park", "Mark done". */
  suggestedLabel(): string | undefined;
  reply(): void;
  replyAll(): void;
  /** Hold R: the reply opens listening. */
  dictate(): void;
  back(): void;
}

/** Home's Follow up section suggests this; the reply opens with the nudge as dim text. */
export const FOLLOW_UP_VERB = 'Reply with a nudge';
const NUDGE: ReplyRequest = { ...PLAIN_REPLY, suggest: { kind: 'followUp' } };

/** What happens to a thread that left when its write is undone (it comes back and the reader opens it) or refused (it comes back where it was). */
interface Restore {
  readonly undone: () => void;
  readonly rejected: () => void;
}

type Toasted = Omit<PushedToast, 'id' | 'undoable' | 'actions' | 'onAction'>;

export function createReaderActions(deps: ReaderDeps): ReaderActions {
  /**
   * Threads this reading has already sent away: the letter on paper may outlive its thread by a moment (Done, J, then
   * Done again before the next letter lands). An entry stays until another letter is on paper, so a second E (or L, #,
   * B, Space, R) on a thread that already left does nothing instead of running Done on it twice. While the next letter
   * is still loading these keys are therefore ignored on purpose: nothing is queued and no state is cleared, the
   * toast for the first one is already up, and the next letter takes the keys the moment it lands.
   */
  const left = new Set<string>();

  /** What bringing a thread back does, by the operation that sent it away: the toast's Undo and Z both run it. */
  const restorers = new Map<string, () => void>();

  function current(): ThreadRow | undefined {
    const id = deps.shown();
    for (const gone of left) if (gone !== id) left.delete(gone);
    return id === null || left.has(id) ? undefined : deps.rowOf(id);
  }

  /** A refused write says so once, plainly, where the thread already left: the row returns to its list. */
  function failOnReject(
    opId: string,
    action: ThreadAction,
    receipt: Promise<unknown>,
    rejected?: () => void,
  ): void {
    receipt.catch(() => {
      rejected?.();
      deps.dismiss(opId);
      deps.push({
        id: `${opId}-failed`,
        kind: 'info',
        message: `Couldn’t ${failurePhrase(action)}.`,
        undoable: false,
        persistent: true,
      });
    });
  }

  /** The thread is part of this reading again: J, K and Done see it. */
  function forget(id: string): void {
    left.delete(id);
    deps.markGone(id, false);
  }

  /** An operation was undone, by its toast's Undo or by Z: its toast closes, then its thread comes back. */
  function undone(opId: string, restore?: () => void): () => void {
    return () => {
      deps.dismiss(opId);
      restore?.();
    };
  }

  function actOn(row: ThreadRow, action: ThreadAction, toast: Toasted, restore?: Restore): string {
    const { opId, receipt } = deps.act({ ids: [row.id], action });
    if (restore) restorers.set(opId, restore.undone);
    deps.push({
      id: opId,
      undoable: true,
      actions: [UNDO_ACTION],
      onAction: undoHandler(opId, undone(opId, restore?.undone)),
      ...toast,
    });
    failOnReject(opId, action, receipt, restore?.rejected);
    return opId;
  }

  /** The thread leaves the list: pick who is next from the list as it was, then write, then show them. */
  function leaveList(row: ThreadRow, action: ThreadAction, toast: Toasted): void {
    const next = afterRemoval(deps.ids(), row.id);
    left.add(row.id);
    deps.markGone(row.id, true);
    // Undo puts the row back in its list, and the reader goes back to it.
    actOn(row, action, toast, {
      undone: () => {
        forget(row.id);
        deps.reopen(row.id);
      },
      rejected: () => forget(row.id),
    });
    if (next === null) deps.leave();
    else deps.go(next);
  }

  function done(): void {
    const row = current();
    if (row)
      leaveList(
        row,
        { type: 'done' },
        { kind: 'done', message: namedToast(deps.undoLabel('mail.done', 'Done'), row) },
      );
  }

  function later(): void {
    const row = current();
    if (!row) return;
    const message = namedToast(undated(deps.undoLabel('mail.later', 'Moved to Later')), row);
    leaveList(row, { type: 'later' }, { kind: 'later', message });
  }

  function trash(): void {
    const row = current();
    if (!row) return;
    const message = namedToast(deps.undoLabel('mail.trash', 'Moved to Trash'), row);
    leaveList(row, { type: 'trash' }, { kind: 'trash', message });
  }

  function restore(): void {
    const row = current();
    if (!row || !deps.restorable()) return;
    const message = deps.undoLabel('mail.restore', 'Restored');
    leaveList(row, { type: 'restore' }, { kind: 'info', message });
  }

  function bookmark(): void {
    const row = current();
    if (!row) return;
    const on = !row.workflow.bookmarked;
    actOn(
      row,
      { type: 'bookmark', on },
      { kind: 'bookmark', message: on ? 'Bookmarked' : 'Bookmark removed' },
    );
  }

  function toggleRead(): void {
    const row = current();
    if (!row) return;
    const unread = row.unread;
    actOn(
      row,
      { type: unread ? 'read' : 'unread' },
      { kind: 'info', message: unread ? 'Marked read' : 'Marked unread' },
    );
    // A thread marked unread goes back to its list: reading it again would only mark it read.
    if (!unread) deps.leave();
  }

  function forward(): void {
    const row = current();
    if (row) deps.forward(row.id);
  }

  /** "Always do this for X": the same move, as a sender rule. A refusal says so instead of going unheard. */
  function setRule(id: string, to: MovableLane): void {
    const action = { type: 'lane', lane: to, alsoForSender: true } as const;
    const { opId, receipt } = deps.act({ ids: [id], action });
    failOnReject(opId, action, receipt);
  }

  function lane(to: MovableLane): void {
    const row = current();
    if (!row) return;
    const action = { type: 'lane', lane: to } as const;
    const { opId, receipt } = deps.act({ ids: [row.id], action });
    deps.push({
      id: opId,
      kind: 'info',
      message: `Moved to ${LANE_LABEL[to]}`,
      undoable: true,
      actions: [{ id: 'always', label: `Always do this for ${senderOf(row)}` }, UNDO_ACTION],
      onAction: actionId => {
        if (actionId === 'always') setRule(row.id, to);
        else undoHandler(opId, undone(opId))(actionId);
      },
    });
    failOnReject(opId, action, receipt);
  }

  function replyWith(request: ReplyRequest): void {
    const id = deps.shown();
    if (id !== null) deps.reply(id, request);
  }

  return {
    step: direction => {
      const next = stepThread(deps.ids(), deps.wanted(), direction);
      if (next !== null) deps.go(next);
    },
    done,
    later,
    trash,
    restore,
    bookmark,
    toggleRead,
    forward,
    lane,
    undo: () => {
      const outcome = undoStack.undoLast();
      if (outcome?.kind !== 'operation') return;
      afterAccepted(outcome.result, undone(outcome.opId, restorers.get(outcome.opId)));
    },
    suggest: () => {
      const row = current();
      if (!row) return;
      const suggestion = suggestionFor(row);
      if (suggestion.isDone) return done();
      if (suggestion.verb === FOLLOW_UP_VERB) return replyWith(NUDGE);
      if (suggestion.verb === 'Reply' || suggestion.icon === 'reply') return replyWith(PLAIN_REPLY);
      deps.suggested(row.id, suggestion);
    },
    suggestedLabel: () => {
      const row = current();
      return row ? suggestedLabel(suggestionFor(row), senderOf(row)) : undefined;
    },
    reply: () => replyWith(PLAIN_REPLY),
    replyAll: () => replyWith({ ...PLAIN_REPLY, replyAll: true }),
    dictate: () => replyWith({ ...PLAIN_REPLY, dictate: true }),
    back: () => {
      if (!deps.closeFind()) deps.leave();
    },
  };
}
