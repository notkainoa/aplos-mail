/**
 * What the lists' commands do (DESIGN 7.4, 7.13): the cursor moves and nothing else (decision 7), Enter opens, and the
 * verbs a list owns act on the row under the cursor: Done, Later, bookmark, trash, Restore and Not spam, Move to Home,
 * and the two destructive ones (delete forever, discard a draft) that ask first. Each commit is synchronous on the
 * keydown, starts the hold, and raises one toast keyed by its opId. The screen supplies the live state and side effects
 * as `ListDeps`, so there is no React here and the tests drive it with the stand-in engine.
 */
import type { DataApi, ThreadActArgs, ThreadRow } from '../../data';
import type { PushedToast } from '../../shell';
import type { CommitKind } from '../../ui/props';
import { bulkCount, bulkMessage, bulkTargetOf, type BulkScope } from './bulkTarget';
import { stepKey, neighbourKeys, survivorKey } from './listModel';
import { openKindOf, isThread, type ListRowData, type OpenKind } from './listRows';
import type { ListKind } from './listKinds';
import { UNDO_ACTION, undoHandler } from '../undoOperation';

/** The bulk pick and the view it sits on: what a bulk action needs to name its target. */
export type BulkPick = BulkScope & {
  /** Picked ids in list order. */
  readonly picked: readonly string[];
};

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

/** What X, ⇧X, ⌘A and Esc do to the pick (`useBulk`'s controls). */
export interface PickControls {
  toggle(id: string): void;
  extendTo(id: string): void;
  selectAll(): void;
  clear(): void;
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
  /**
   * Done on the picked rows when any are picked, else on the cursor row, or the row with this key (a hover button, which
   * always means its own row). The other verbs follow the same rule.
   */
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
const COMMIT_KINDS: readonly string[] = ['done', 'later', 'trash'];

type ThreadAction = Parameters<DataApi['thread']['act']>[0]['action'];

/** What a bulk verb sends and says. */
interface BulkVerb {
  readonly action: ThreadAction;
  readonly kind: PushedToast['kind'];
  readonly message: (count: number) => string;
}

const DONE_VERB: BulkVerb = {
  action: { type: 'done' },
  kind: 'done',
  message: count => bulkMessage('done', count),
};
const LATER_VERB: BulkVerb = {
  action: { type: 'later' },
  kind: 'later',
  message: count => bulkMessage('later', count),
};
const TRASH_VERB: BulkVerb = {
  action: { type: 'trash' },
  kind: 'trash',
  message: count => bulkMessage('trash', count),
};

/** "Restored · 3 emails": a verb's own words, then how many. */
function countedMessage(label: string, count: number): string {
  return `${label} · ${count === 1 ? '1 email' : `${count} emails`}`;
}

/** `Thread/act` arguments for the picks: named ids (copied, the contract's array is mutable) or the whole-view selector. */
function actArgs(pick: BulkPick, action: ThreadAction): ThreadActArgs {
  const target = bulkTargetOf(pick);
  return 'ids' in target ? { ids: [...target.ids], action } : { selector: target.selector, action };
}

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

function threadAt(deps: ListDeps, key?: string): ThreadRow | null {
  const target = targetAt(deps, key);
  return target && isThread(target.row) ? target.row : null;
}

export function createListActions(deps: ListDeps): ListActions {
  /** The rows around the cursor stay still; with a commit kind the rows leaving also fly. */
  function hold(kind: CommitKind | null, rowIds: readonly string[], extra: readonly string[] = []) {
    const snapshot = deps.snapshot();
    const holdIds = [...extra, ...neighbourKeys(snapshot.ids, snapshot.key)];
    if (kind !== null && deps.commit) deps.commit(kind, holdIds, rowIds);
    else deps.hold.extend(holdIds);
  }

  /** The bulk pick, or null when nothing is picked. */
  function picks(): BulkPick | null {
    const bulk = deps.snapshot().bulk;
    return bulk && bulk.picked.length > 0 ? bulk : null;
  }

  /** The number a bar, a toast and a question name: the whole view after ⌘A past the window, else the picks. */
  function countOf(pick: BulkPick): number {
    return bulkCount({ ...pick, count: pick.picked.length });
  }

  /** One bulk action: one `act` over the target, one toast with Undo, then the picks clear and the cursor settles. */
  function actOnPicks(pick: BulkPick, verb: BulkVerb): void {
    const snapshot = deps.snapshot();
    hold(commitKindOf(verb.kind), pick.picked, pick.picked);
    const { opId, receipt } = deps.act(actArgs(pick, verb.action));
    deps.push({
      id: opId,
      undoable: true,
      actions: [UNDO_ACTION],
      onAction: undoHandler(opId),
      kind: verb.kind,
      message: verb.message(countOf(pick)),
    });
    failOnReject(opId, receipt);
    deps.selection?.clear();
    deps.setCursor(survivorKey(snapshot.ids, snapshot.key, pick.picked));
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
    hold(commitKindOf(toast.kind), [row.id]);
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
    const pick = key === undefined && TRIAGE_KINDS.includes(deps.kind) ? picks() : null;
    if (pick) return actOnPicks(pick, DONE_VERB);
    const row = threadAt(deps, key);
    if (!row || !TRIAGE_KINDS.includes(deps.kind)) return;
    actOn(row, { type: 'done' }, { kind: 'done', message: deps.undoLabel('mail.done', 'Done') });
  }

  function later(key?: string): void {
    const pick = key === undefined && TRIAGE_KINDS.includes(deps.kind) ? picks() : null;
    if (pick) return actOnPicks(pick, LATER_VERB);
    const row = threadAt(deps, key);
    if (!row || !TRIAGE_KINDS.includes(deps.kind)) return;
    const message = deps.undoLabel('mail.later', 'Moved to Later');
    actOn(row, { type: 'later' }, { kind: 'later', message });
  }

  /** Bookmark the picks, or remove the bookmark from all of them when every one has it. */
  function bookmarkPicks(pick: BulkPick): void {
    const marked = (id: string) => {
      const row = deps.snapshot().rowOf(id);
      return row !== undefined && isThread(row) && row.workflow.bookmarked;
    };
    const on = !pick.picked.every(marked);
    actOnPicks(pick, {
      action: { type: 'bookmark', on },
      kind: 'bookmark',
      message: count => countedMessage(on ? 'Bookmarked' : 'Bookmark removed', count),
    });
  }

  function bookmark(): void {
    const pick = TRIAGE_KINDS.includes(deps.kind) ? picks() : null;
    if (pick) return bookmarkPicks(pick);
    const row = threadAt(deps);
    if (!row || !TRIAGE_KINDS.includes(deps.kind)) return;
    const on = !row.workflow.bookmarked;
    const message = on ? 'Bookmarked' : 'Bookmark removed';
    actOn(row, { type: 'bookmark', on }, { kind: 'bookmark', message });
  }

  function restore(key?: string): void {
    const pick =
      key === undefined && (deps.kind === 'trash' || deps.kind === 'spam') ? picks() : null;
    if (pick) {
      const label = deps.undoLabel('mail.restore', 'Restored');
      return actOnPicks(pick, {
        action: { type: 'restore' },
        kind: 'info',
        message: count => countedMessage(label, count),
      });
    }
    const row = threadAt(deps, key);
    if (!row || (deps.kind !== 'trash' && deps.kind !== 'spam')) return;
    const message = deps.undoLabel('mail.restore', 'Restored');
    actOn(row, { type: 'restore' }, { kind: 'info', message });
  }

  function moveToHome(key?: string): void {
    const pick = key === undefined && deps.kind === 'done' ? picks() : null;
    if (pick) {
      const label = deps.undoLabel('done.moveToHome', 'Moved to Home');
      return actOnPicks(pick, {
        action: { type: 'restore' },
        kind: 'home',
        message: count => countedMessage(label, count),
      });
    }
    const row = threadAt(deps, key);
    if (!row || deps.kind !== 'done') return;
    const message = deps.undoLabel('done.moveToHome', 'Moved to Home');
    actOn(row, { type: 'restore' }, { kind: 'home', message });
  }

  /** # with rows picked: every kind asks first, because a bulk removal is the one thing Undo may not reach in time. */
  function trashPicks(pick: BulkPick): void {
    const count = countOf(pick);
    const ids = pick.picked;
    if (deps.kind === 'drafts') return deps.setConfirmation({ kind: 'discardDraft', ids, count });
    if (deps.kind === 'trash' || deps.kind === 'spam') {
      if (deps.canDeleteForever()) deps.setConfirmation({ kind: 'deleteForever', ids, count });
      return;
    }
    if (TRIAGE_KINDS.includes(deps.kind)) deps.setConfirmation({ kind: 'trashPicked', ids, count });
  }

  function trash(): void {
    const pick = picks();
    if (pick) return trashPicks(pick);
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
    hold(null, ids);
    deps.deleteForever(ids).then(
      () => notice(`delete-${ids.join(',')}`, 'Deleted forever'),
      () => notice('delete-failed', 'Couldn’t delete that. It is still here.', true),
    );
  }

  /** Several drafts discarded at once say so once, not once each. */
  function discardMany(ids: readonly string[]): void {
    Promise.all(ids.map(id => deps.discardDraft(id))).then(
      () => notice(`discard-${ids.join(',')}`, countedMessage('Drafts discarded', ids.length)),
      () => notice('discard-failed', 'Couldn’t discard the drafts. Some are still saved.', true),
    );
  }

  function confirmDiscard(ids: readonly string[]): void {
    hold(null, ids);
    if (ids.length > 1) return discardMany(ids);
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
    if (pending.kind === 'trashPicked') return confirmTrashPicks();
    if (pending.kind === 'deleteForever') confirmDelete(pending.ids);
    else confirmDiscard(pending.ids);
    deps.selection?.clear();
  }

  /** The owner confirmed: trash whatever is picked now (the dialog's keys leave the pick as it was). */
  function confirmTrashPicks(): void {
    const pick = picks();
    if (pick) actOnPicks(pick, TRASH_VERB);
  }

  function withCursor(run: (id: string) => void): void {
    const key = deps.snapshot().key;
    if (key !== null) run(key);
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
    select: () => withCursor(id => deps.selection?.toggle(id)),
    selectRange: () => withCursor(id => deps.selection?.extendTo(id)),
    selectAll: () => deps.selection?.selectAll(),
    clearSelection: () => deps.selection?.clear(),
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
