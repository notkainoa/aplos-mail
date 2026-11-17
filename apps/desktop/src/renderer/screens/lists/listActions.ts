/**
 * What the lists' commands do (DESIGN 7.4, 7.13): the cursor moves and nothing else (decision 7), Enter opens, and the
 * verbs a list owns act on the row under the cursor: Done, Later, bookmark, trash, Restore and Not spam, Move to Home,
 * and the two destructive ones (delete forever, discard a draft) that ask first. Each commit is synchronous on the
 * keydown, starts the hold, and raises one toast keyed by its opId. The screen supplies the live state and side effects
 * as `ListDeps`, so there is no React here and the tests drive it with the stand-in engine.
 */
import type { DataApi, ThreadRow } from '../../data';
import type { PushedToast } from '../../shell';
import type { CommitKind } from '../../ui/props';
import {
  TRIAGE_KINDS,
  countedMessage,
  createListBulk,
  dropFromPick,
  createPickActions,
  holdRows,
  type BulkPick,
  type PickControls,
} from './bulkActions';
import { namedToast } from '../home/homeRows';
import { stepKey, neighbourKeys } from './listModel';
import { openKindOf, isThread, type ListRowData, type OpenKind } from './listRows';
import type { ListKind } from './listKinds';
import { UNDO_ACTION, triageSlot, undoHandler } from '../undoOperation';

/** The live state an action reads when its key arrives. */
export interface ListSnapshot {
  readonly ids: readonly string[];
  readonly key: string | null;
  readonly rowOf: (id: string) => ListRowData | undefined;
  /** The bulk pick; absent while nothing is picked. */
  readonly bulk?: BulkPick;
}

/** A destructive action waiting for the owner's answer. */
export interface Confirmation {
  readonly kind: 'deleteForever' | 'discardDraft' | 'trashPicked';
  readonly ids: readonly string[];
  /** The number the question names, when it is not `ids.length` (a whole-view pick). Absent for a single row. */
  readonly count?: number;
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
  /** `.` with rows picked: opens the bulk bar's More menu. Absent: there is no bar to open. */
  openMore?(): void;
  /** Opens the compose page on a forward of this thread's latest message. */
  forward?(id: string): void;
  /** The caller's `onOpen`; `listIds` are the threads the list shows, in order, so the reader's J and K walk them. */
  open(id: string, kind: OpenKind, listIds?: readonly string[]): void;
  confirmation(): Confirmation | null;
  setConfirmation(next: Confirmation | null): void;
  /** The confirmed toast text of a command, read from the registry. */
  undoLabel(commandId: string, fallback: string): string;
  /** Changes the bulk pick. Absent: the list cannot pick (tests that never do). */
  selection?: PickControls;
  /**
   * Draws a Done, Later or Trash commit on the rows leaving (ghost, chip, edge) and extends the hold; only one of this and
   * `hold.extend` is called. Absent: the hold alone.
   */
  commit?(kind: CommitKind, holdIds: readonly string[], rowIds: readonly string[]): void;
}

/** The commands a list answers, as plain functions. */
export interface ListActions {
  move(delta: 1 | -1): void;
  /** Open the cursor row, or the row with this id (a double-click). */
  open(key?: string): void;
  /** X: pick or unpick the cursor row; the cursor stays. */
  select(): void;
  /** ⇧X: pick the run from the anchor to the cursor. */
  selectRange(): void;
  /** ⌘A. */
  selectAll(): void;
  /** Esc. */
  clearSelection(): void;
  /** `.`: the bulk More menu while rows are picked; nothing otherwise (a list has no row menu). */
  more(): void;
  /**
   * Done on the picked rows when any are picked, else on the cursor row, or the row with this key (a hover button, which
   * always means its own row). The other verbs follow the same rule.
   */
  done(key?: string): void;
  later(key?: string): void;
  bookmark(): void;
  /** Trash (#) in mail lists; delete forever in Trash and Spam; discard in Drafts. The last two ask first. */
  trash(): void;
  /** F: forwards the cursor row's thread (one row at a time: with rows picked it does nothing). */
  forward(): void;
  /** Restore in Trash, Not spam in Spam. */
  restore(key?: string): void;
  /** Move to Home (H) in the Done place. */
  moveToHome(key?: string): void;
  /** The owner chose the destructive row of the open confirmation. */
  confirm(): void;
  cancelConfirm(): void;
}

/** The lists Restore and Not spam belong to. */
const SPAM_KINDS: readonly ListKind[] = ['trash', 'spam'];

type ThreadAction = Parameters<DataApi['thread']['act']>[0]['action'];

const COMMIT_KINDS: readonly string[] = ['done', 'later', 'trash'];

function commitKindOf(kind: PushedToast['kind']): CommitKind | null {
  return COMMIT_KINDS.includes(kind) ? (kind as CommitKind) : null;
}

interface Target {
  readonly row: ListRowData;
}

function targetAt(deps: ListDeps, key?: string): Target | null {
  const snapshot = deps.snapshot();
  const at = key ?? snapshot.key;
  const row = at === null ? undefined : snapshot.rowOf(at);
  return row ? { row } : null;
}

/** The ids of the threads the list draws, in order (a draft or submission row is not a thread the reader steps to). */
function threadIdsOf(snapshot: ListSnapshot): readonly string[] {
  return snapshot.ids.filter(id => {
    const row = snapshot.rowOf(id);
    return row === undefined || isThread(row);
  });
}

/** The toasts that name their thread (the triage slot). */
const NAMED_KINDS: ReadonlySet<string> = new Set(['done', 'later', 'trash']);

function threadAt(deps: ListDeps, key?: string): ThreadRow | null {
  const target = targetAt(deps, key);
  return target && isThread(target.row) ? target.row : null;
}

/** The single-row verbs: one thread action, one toast. */
function createRowVerbs(deps: ListDeps) {
  function actOn(
    row: ThreadRow,
    action: ThreadAction,
    toast: Omit<PushedToast, 'id' | 'undoable' | 'actions'>,
  ): void {
    const picked = deps.snapshot().bulk?.picked;
    holdRows(deps, commitKindOf(toast.kind), [row.id]);
    const { opId, receipt } = deps.act({ ids: [row.id], action });
    if (action.type !== 'bookmark') dropFromPick(deps.selection, picked, row.id);
    deps.push({
      id: opId,
      undoable: true,
      actions: [UNDO_ACTION],
      onAction: undoHandler(opId),
      ...toast,
      ...triageSlot(toast.kind),
      message: NAMED_KINDS.has(toast.kind) ? namedToast(toast.message, row) : toast.message,
    });
    receipt.catch(() => deps.dismiss(opId));
  }

  /** Acts on the row at `key` (or the cursor) when this list owns the verb. */
  function onRow(
    kinds: readonly ListKind[],
    key: string | undefined,
    action: ThreadAction,
    toast: Omit<PushedToast, 'id' | 'undoable' | 'actions'>,
  ): void {
    const row = threadAt(deps, key);
    if (row && kinds.includes(deps.kind)) actOn(row, action, toast);
  }

  return { actOn, onRow };
}

/** Delete forever and discard a draft, once the owner has confirmed. */
function createDestroyers(deps: ListDeps) {
  function notice(id: string, message: string): void {
    deps.push({ id, kind: 'info', message, undoable: false });
  }

  /** A refusal: the alert icon and a close button, and it fades after 8 s like any error toast. */
  function failure(id: string, message: string): void {
    deps.push({ id, kind: 'error', message, undoable: false });
  }

  function confirmDelete(ids: readonly string[]): void {
    holdRows(deps, null, ids);
    deps.deleteForever(ids).then(
      () => notice(`delete-${ids.join(',')}`, 'Deleted forever'),
      () => failure('delete-failed', 'Couldn’t delete that. It is still here.'),
    );
  }

  /** Several drafts discarded at once say so once, not once each. */
  function discardMany(ids: readonly string[]): void {
    Promise.all(ids.map(id => deps.discardDraft(id))).then(
      () => notice(`discard-${ids.join(',')}`, countedMessage('Drafts discarded', ids.length)),
      () => failure('discard-failed', 'Couldn’t discard the drafts. Some are still saved.'),
    );
  }

  function confirmDiscard(ids: readonly string[]): void {
    holdRows(deps, null, ids);
    if (ids.length > 1) return discardMany(ids);
    for (const id of ids) {
      deps.discardDraft(id).then(
        () => notice(`discard-${id}`, 'Draft discarded'),
        () => failure('discard-failed', 'Couldn’t discard the draft. It is still saved.'),
      );
    }
  }

  return { confirmDelete, confirmDiscard };
}

export function createListActions(deps: ListDeps): ListActions {
  const bulk = createListBulk(deps);
  const picking = createPickActions(
    deps.selection,
    () => deps.snapshot().key,
    () => deps.hold.extend(deps.snapshot().ids),
  );
  const { onRow } = createRowVerbs(deps);
  const { confirmDelete, confirmDiscard } = createDestroyers(deps);

  /** The picks when the verb is for them: no key (a hover button means its own row) and a list that owns the verb. */
  function pickIn(kinds: readonly ListKind[], key?: string) {
    return key === undefined && kinds.includes(deps.kind) ? bulk.picks() : null;
  }

  function done(key?: string): void {
    const pick = pickIn(TRIAGE_KINDS, key);
    if (pick) return bulk.done(pick);
    const toast = { kind: 'done', message: deps.undoLabel('mail.done', 'Done') } as const;
    onRow(TRIAGE_KINDS, key, { type: 'done' }, toast);
  }

  function later(key?: string): void {
    const pick = pickIn(TRIAGE_KINDS, key);
    if (pick) return bulk.later(pick);
    const message = deps.undoLabel('mail.later', 'Moved to Later');
    onRow(TRIAGE_KINDS, key, { type: 'later' }, { kind: 'later', message });
  }

  function bookmark(): void {
    const pick = pickIn(TRIAGE_KINDS);
    if (pick) return bulk.bookmark(pick);
    const row = threadAt(deps);
    if (!row) return;
    const on = !row.workflow.bookmarked;
    const message = on ? 'Bookmarked' : 'Bookmark removed';
    onRow(TRIAGE_KINDS, undefined, { type: 'bookmark', on }, { kind: 'bookmark', message });
  }

  function restore(key?: string): void {
    const pick = pickIn(SPAM_KINDS, key);
    if (pick) return bulk.restore(pick);
    const message = deps.undoLabel('mail.restore', 'Restored');
    onRow(SPAM_KINDS, key, { type: 'restore' }, { kind: 'info', message });
  }

  function moveToHome(key?: string): void {
    const pick = pickIn(['done'], key);
    if (pick) return bulk.moveToHome(pick);
    const message = deps.undoLabel('done.moveToHome', 'Moved to Home');
    onRow(['done'], key, { type: 'restore' }, { kind: 'home', message });
  }

  function trash(): void {
    const pick = bulk.picks();
    if (pick) return bulk.trash(pick);
    const target = targetAt(deps);
    if (!target) return;
    if (deps.kind === 'drafts')
      return deps.setConfirmation({ kind: 'discardDraft', ids: [target.row.id] });
    if (deps.kind === 'trash' || deps.kind === 'spam') {
      if (deps.canDeleteForever())
        deps.setConfirmation({ kind: 'deleteForever', ids: [target.row.id] });
      return;
    }
    const message = deps.undoLabel('mail.trash', 'Moved to Trash');
    onRow(TRIAGE_KINDS, undefined, { type: 'trash' }, { kind: 'trash', message });
  }

  function confirm(): void {
    const pending = deps.confirmation();
    deps.setConfirmation(null);
    if (!pending) return;
    if (pending.kind === 'trashPicked') return bulk.confirmTrash(pending);
    if (pending.kind === 'deleteForever') confirmDelete(pending.ids);
    else confirmDiscard(pending.ids);
    deps.selection?.clear();
  }

  function move(delta: 1 | -1): void {
    const snapshot = deps.snapshot();
    const key = stepKey(snapshot.ids, snapshot.key, delta);
    deps.setCursor(key);
    deps.hold.extend(neighbourKeys(snapshot.ids, key));
  }

  function open(key?: string): void {
    const target = targetAt(deps, key);
    if (target) deps.open(target.row.id, openKindOf(target.row), threadIdsOf(deps.snapshot()));
  }

  function forward(): void {
    if (bulk.picks()) return;
    const target = targetAt(deps);
    if (target && isThread(target.row)) deps.forward?.(target.row.id);
  }

  function more(): void {
    if (bulk.picks()) deps.openMore?.();
  }

  return {
    move,
    open,
    more,
    ...picking,
    done,
    later,
    bookmark,
    trash,
    forward,
    restore,
    moveToHome,
    confirm,
    cancelConfirm: () => deps.setConfirmation(null),
  };
}
