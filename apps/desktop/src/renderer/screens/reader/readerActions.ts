/**
 * What the reader's commands do (DESIGN 7.5, 7.13, 8): J and K step through the list the reader was opened from, and
 * Done, Later and Trash act on the letter on paper, leave at once, and open the next thread (or go back to the list
 * when none is left). Each write is optimistic through `api.thread.act`, raises one toast keyed by its opId with a
 * per-operation Undo, and says plainly when the engine refuses. The screen supplies the live state and the side effects
 * as `ReaderDeps`, so there is no React here and the tests drive it with the stand-in engine.
 */
import type { DataApi, ThreadAction, ThreadRow } from '../../data';
import type { PushedToast } from '../../shell';
import { UNDO_ACTION, undoHandler } from '../undoOperation';
import { failurePhrase } from '../home/homeRows';
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
  /** Esc, or no thread left: close the reader and show the screen it was opened from. */
  leave(): void;
  act: DataApi['thread']['act'];
  push(toast: PushedToast): string;
  dismiss(id: string): void;
  /** The confirmed toast text of a command, read from the registry. */
  undoLabel(commandId: string, fallback: string): string;
  /** Opens the inline reply under the thread (R, ⇧R, hold R, a Reply suggestion). */
  reply(id: string, request?: ReplyRequest): void;
  /** Any suggestion that is not a reply or Done ("View invoice", "Add to calendar"): a later slice's, the screen forwards it. */
  suggested(id: string, action: SuggestedAction): void;
}

/** The commands the reader answers, as plain functions. */
export interface ReaderActions {
  step(direction: CursorDirection): void;
  done(): void;
  later(): void;
  trash(): void;
  bookmark(): void;
  /** Space: the filled button's action. */
  suggest(): void;
  reply(): void;
  replyAll(): void;
  /** Hold R: the reply opens listening. */
  dictate(): void;
  back(): void;
}

/** Home's Follow up section suggests this; the reply opens with the nudge as dim text. */
const FOLLOW_UP_VERB = 'Reply with a nudge';
const NUDGE: ReplyRequest = { ...PLAIN_REPLY, suggest: { kind: 'followUp' } };

type Toasted = Omit<PushedToast, 'id' | 'undoable' | 'actions' | 'onAction'>;

export function createReaderActions(deps: ReaderDeps): ReaderActions {
  /** Threads this reading has already sent away: the letter on paper may outlive its thread by a moment. */
  const left = new Set<string>();

  function current(): ThreadRow | undefined {
    const id = deps.shown();
    return id === null || left.has(id) ? undefined : deps.rowOf(id);
  }

  /** A refused write says so once, plainly, where the thread already left: the row returns to its list. */
  function failOnReject(opId: string, action: ThreadAction, receipt: Promise<unknown>): void {
    receipt.catch(() => {
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

  function actOn(row: ThreadRow, action: ThreadAction, toast: Toasted): string {
    const { opId, receipt } = deps.act({ ids: [row.id], action });
    deps.push({
      id: opId,
      undoable: true,
      actions: [UNDO_ACTION],
      onAction: undoHandler(opId),
      ...toast,
    });
    failOnReject(opId, action, receipt);
    return opId;
  }

  /** The thread leaves the list: pick who is next from the list as it was, then write, then show them. */
  function leaveList(row: ThreadRow, action: ThreadAction, toast: Toasted): void {
    const next = afterRemoval(deps.ids(), row.id);
    left.add(row.id);
    actOn(row, action, toast);
    if (next === null) deps.leave();
    else deps.go(next);
  }

  function done(): void {
    const row = current();
    if (row)
      leaveList(
        row,
        { type: 'done' },
        { kind: 'done', message: deps.undoLabel('mail.done', 'Done') },
      );
  }

  function later(): void {
    const row = current();
    if (!row) return;
    const message = deps.undoLabel('mail.later', 'Moved to Later');
    leaveList(row, { type: 'later' }, { kind: 'later', message });
  }

  function trash(): void {
    const row = current();
    if (!row) return;
    const message = deps.undoLabel('mail.trash', 'Moved to Trash');
    leaveList(row, { type: 'trash' }, { kind: 'trash', message });
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

  function replyWith(request: ReplyRequest): void {
    const id = deps.shown();
    if (id !== null) deps.reply(id, request);
  }

  return {
    step: direction => {
      left.clear();
      const next = stepThread(deps.ids(), deps.wanted(), direction);
      if (next !== null) deps.go(next);
    },
    done,
    later,
    trash,
    bookmark,
    suggest: () => {
      const row = current();
      if (!row) return;
      const suggestion = suggestionFor(row);
      if (suggestion.isDone) return done();
      if (suggestion.verb === FOLLOW_UP_VERB) return replyWith(NUDGE);
      if (suggestion.verb === 'Reply' || suggestion.icon === 'reply') return replyWith(PLAIN_REPLY);
      deps.suggested(row.id, suggestion);
    },
    reply: () => replyWith(PLAIN_REPLY),
    replyAll: () => replyWith({ ...PLAIN_REPLY, replyAll: true }),
    dictate: () => replyWith({ ...PLAIN_REPLY, dictate: true }),
    back: () => deps.leave(),
  };
}
