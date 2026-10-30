/**
 * What the lists' commands do (DESIGN 7.4, 7.13): the cursor moves and nothing else (decision 7), Enter opens, and the
 * verbs a list owns act on the row under the cursor: Done, Later, bookmark, trash, Restore and Not spam, Move to Home,
 * and the two destructive ones (delete forever, discard a draft) that ask first. Each commit is synchronous on the
 * keydown, starts the hold, and raises one toast keyed by its opId. The screen supplies the live state and side effects
 * as `ListDeps`, so there is no React here and the tests drive it with the stand-in engine.
 */
import type { DataApi, ThreadRow } from '../../data';
import type { PushedToast } from '../../shell';
import { stepKey, neighbourKeys } from './listModel';
import { openKindOf, isThread, type ListRowData, type OpenKind } from './listRows';
import type { ListKind } from './listKinds';
import { UNDO_ACTION, undoHandler } from '../undoOperation';

/** The live state an action reads when its key arrives. */
export interface ListSnapshot {
  readonly ids: readonly string[];
  readonly key: string | null;
  readonly rowOf: (id: string) => ListRowData | undefined;
}

/** A destructive action waiting for the owner's answer. */
export interface Confirmation {
  readonly kind: 'deleteForever' | 'discardDraft';
  readonly ids: readonly string[];
}

/** The screen's side of the actions. */
export interface ListDeps {
  readonly kind: ListKind;
  snapshot(): ListSnapshot;
  setCursor(key: string | null): void;
  /** `api.thread.act`. */
  act: DataApi['thread']['act'];
  /** `api.draft.destroy` for one draft. */
  discardDraft(id: string): Promise<unknown>;
  /** Whether permanent deletion exists (the contract has no such action yet): when false the key does nothing and no confirm opens. */
  canDeleteForever(): boolean;
  /** Permanent deletion of these ids. */
  deleteForever(ids: readonly string[]): Promise<unknown>;
  push(toast: PushedToast): string;
  dismiss(id: string): void;
  /** The hold gate: a key starts or extends it around `ids`. */
  hold: { extend(ids?: readonly string[]): void };
  /** The caller's `onOpen`. */
  open(id: string, kind: OpenKind): void;
  confirmation(): Confirmation | null;
  setConfirmation(next: Confirmation | null): void;
  /** The confirmed toast text of a command, read from the registry. */
  undoLabel(commandId: string, fallback: string): string;
}

/** The commands a list answers, as plain functions. */
export interface ListActions {
  move(delta: 1 | -1): void;
  /** Open the cursor row, or the row with this id (a double-click). */
  open(key?: string): void;
  /** Done on the cursor row, or the row with this key (a hover button). */
  done(key?: string): void;
  later(key?: string): void;
  bookmark(): void;
  /** Trash (#) in mail lists; delete forever in Trash and Spam; discard in Drafts. The last two ask first. */
  trash(): void;
  /** Restore in Trash, Not spam in Spam. */
  restore(key?: string): void;
  /** Move to Home (H) in the Done place. */
  moveToHome(key?: string): void;
  /** The owner chose the destructive row of the open confirmation. */
  confirm(): void;
  cancelConfirm(): void;
}

const TRIAGE_KINDS: readonly ListKind[] = ['all', 'label', 'sent', 'bookmarks', 'later'];

interface Target {
  readonly row: ListRowData;
}

function targetAt(deps: ListDeps, key?: string): Target | null {
  const snapshot = deps.snapshot();
  const at = key ?? snapshot.key;
  const row = at === null ? undefined : snapshot.rowOf(at);
  return row ? { row } : null;
}

function threadAt(deps: ListDeps, key?: string): ThreadRow | null {
  const target = targetAt(deps, key);
  return target && isThread(target.row) ? target.row : null;
}

export function createListActions(deps: ListDeps): ListActions {
  function hold(): void {
    const snapshot = deps.snapshot();
    deps.hold.extend(neighbourKeys(snapshot.ids, snapshot.key));
  }

  function failOnReject(opId: string, receipt: Promise<unknown>): void {
    receipt.catch(() => deps.dismiss(opId));
  }

  /** One thread action, one toast. */
  function actOn(
    row: ThreadRow,
    action: Parameters<DataApi['thread']['act']>[0]['action'],
    toast: Omit<PushedToast, 'id' | 'undoable' | 'actions'>,
  ): void {
    hold();
    const { opId, receipt } = deps.act({ ids: [row.id], action });
    deps.push({
      id: opId,
      undoable: true,
      actions: [UNDO_ACTION],
      onAction: undoHandler(opId),
      ...toast,
    });
    failOnReject(opId, receipt);
  }

  function done(key?: string): void {
    const row = threadAt(deps, key);
    if (!row || !TRIAGE_KINDS.includes(deps.kind)) return;
    actOn(row, { type: 'done' }, { kind: 'done', message: deps.undoLabel('mail.done', 'Done') });
  }

  function later(key?: string): void {
    const row = threadAt(deps, key);
    if (!row || !TRIAGE_KINDS.includes(deps.kind)) return;
    const message = deps.undoLabel('mail.later', 'Moved to Later');
    actOn(row, { type: 'later' }, { kind: 'later', message });
  }

  function bookmark(): void {
    const row = threadAt(deps);
    if (!row || !TRIAGE_KINDS.includes(deps.kind)) return;
    const on = !row.workflow.bookmarked;
    const message = on ? 'Bookmarked' : 'Bookmark removed';
    actOn(row, { type: 'bookmark', on }, { kind: 'bookmark', message });
  }

  function restore(key?: string): void {
    const row = threadAt(deps, key);
    if (!row || (deps.kind !== 'trash' && deps.kind !== 'spam')) return;
    const message = deps.undoLabel('mail.restore', 'Restored');
    actOn(row, { type: 'restore' }, { kind: 'info', message });
  }

  function moveToHome(key?: string): void {
    const row = threadAt(deps, key);
    if (!row || deps.kind !== 'done') return;
    const message = deps.undoLabel('done.moveToHome', 'Moved to Home');
    actOn(row, { type: 'restore' }, { kind: 'home', message });
  }

  function trash(): void {
    const target = targetAt(deps);
    if (!target) return;
    if (deps.kind === 'drafts') {
      deps.setConfirmation({ kind: 'discardDraft', ids: [target.row.id] });
      return;
    }
    if (deps.kind === 'trash' || deps.kind === 'spam') {
      if (deps.canDeleteForever())
        deps.setConfirmation({ kind: 'deleteForever', ids: [target.row.id] });
      return;
    }
    const row = threadAt(deps);
    if (!row || !TRIAGE_KINDS.includes(deps.kind)) return;
    const message = deps.undoLabel('mail.trash', 'Moved to Trash');
    actOn(row, { type: 'trash' }, { kind: 'trash', message });
  }

  function notice(id: string, message: string, persistent = false): void {
    deps.push({ id, kind: 'info', message, undoable: false, persistent });
  }

  function confirmDelete(ids: readonly string[]): void {
    hold();
    deps.deleteForever(ids).then(
      () => notice(`delete-${ids.join(',')}`, 'Deleted forever'),
      () => notice('delete-failed', 'Couldn’t delete that. It is still here.', true),
    );
  }

  function confirmDiscard(ids: readonly string[]): void {
    hold();
    for (const id of ids) {
      deps.discardDraft(id).then(
        () => notice(`discard-${id}`, 'Draft discarded'),
        () => notice('discard-failed', 'Couldn’t discard the draft. It is still saved.', true),
      );
    }
  }

  function confirm(): void {
    const pending = deps.confirmation();
    deps.setConfirmation(null);
    if (!pending) return;
    if (pending.kind === 'deleteForever') confirmDelete(pending.ids);
    else confirmDiscard(pending.ids);
  }

  return {
    move: delta => {
      const snapshot = deps.snapshot();
      const key = stepKey(snapshot.ids, snapshot.key, delta);
      deps.setCursor(key);
      deps.hold.extend(neighbourKeys(snapshot.ids, key));
    },
    open: key => {
      const target = targetAt(deps, key);
      if (target) deps.open(target.row.id, openKindOf(target.row));
    },
    done,
    later,
    bookmark,
    trash,
    restore,
    moveToHome,
    confirm,
    cancelConfirm: () => deps.setConfirmation(null),
  };
}
