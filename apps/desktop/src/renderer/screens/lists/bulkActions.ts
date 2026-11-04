/**
 * The bulk verbs (DESIGN 7.4): one `act` over the picked rows, one toast with Undo, then the picks clear and the cursor
 * settles. `commitBulk` is the shared core: the lists and Home each supply a `BulkSide` (how their rows hold and fly,
 * which toast helpers they use) and call it, so a bulk commit behaves the same on every screen. The rest of this file
 * is the lists' side: the verbs a list owns over its picks, the confirmation before a bulk removal, and the selection
 * keys (X, ⇧X, ⌘A, Esc). No React; the tests drive it through `createListActions`.
 */
import type { DataApi, ThreadActArgs } from '../../data';
import type { PushedToast } from '../../shell';
import type { CommitKind } from '../../ui/props';
import { UNDO_ACTION, undoHandler } from '../undoOperation';
import {
  bulkCount,
  bulkMessage,
  bulkTargetOf,
  type BulkScope,
  type BulkTarget,
} from './bulkTarget';
import { neighbourKeys, survivorKey } from './listModel';
import { isThread } from './listRows';
import type { Confirmation, ListDeps } from './listActions';
import type { ListKind } from './listKinds';

/** The bulk pick and the view it sits on: what a bulk action needs to name its target. */
export type BulkPick = BulkScope & {
  /** Picked ids in list order. */
  readonly picked: readonly string[];
};

/** What X, ⇧X, ⌘A and Esc do to the pick (`useBulk`'s controls). */
export interface PickControls {
  toggle(id: string): void;
  extendTo(id: string): void;
  selectAll(): void;
  clear(): void;
}

/** The lists whose rows can be marked Done, Later, bookmarked and trashed. */
export const TRIAGE_KINDS: readonly ListKind[] = ['all', 'label', 'sent', 'bookmarks', 'later'];

/** The most rows one bulk commit flies; a hundred ghosts would be noise, not feedback. */
export const MAX_FLYING = 6;

type ThreadAction = Parameters<DataApi['thread']['act']>[0]['action'];

/** What a bulk verb sends and says. */
export interface BulkVerb {
  readonly action: ThreadAction;
  readonly kind: PushedToast['kind'];
  readonly message: (count: number) => string;
}

export const DONE_VERB: BulkVerb = {
  action: { type: 'done' },
  kind: 'done',
  message: count => bulkMessage('done', count),
};
export const LATER_VERB: BulkVerb = {
  action: { type: 'later' },
  kind: 'later',
  message: count => bulkMessage('later', count),
};
export const TRASH_VERB: BulkVerb = {
  action: { type: 'trash' },
  kind: 'trash',
  message: count => bulkMessage('trash', count),
};

/** "Restored · 3 emails": a verb's own words, then how many. */
export function countedMessage(label: string, count: number): string {
  return `${label} · ${count === 1 ? '1 email' : `${count} emails`}`;
}

/** A verb whose toast reads "<label> · N emails". */
export function labelledVerb(
  label: string,
  action: ThreadAction,
  kind: PushedToast['kind'],
): BulkVerb {
  return { action, kind, message: count => countedMessage(label, count) };
}

const COMMIT_KINDS: readonly string[] = ['done', 'later', 'trash'];

/** The motion a toast kind draws on the rows leaving; null for a verb that only holds (bookmark, restore). */
function commitKindOf(kind: PushedToast['kind']): CommitKind | null {
  return COMMIT_KINDS.includes(kind) ? (kind as CommitKind) : null;
}

/** `Thread/act` arguments for a target: named ids (copied, the contract's array is mutable) or the whole-view selector. */
function actArgs(target: BulkTarget, action: ThreadAction): ThreadActArgs {
  return 'ids' in target ? { ids: [...target.ids], action } : { selector: target.selector, action };
}

/** How a screen draws and holds a bulk commit. */
export interface BulkSide {
  act: DataApi['thread']['act'];
  push(toast: PushedToast): string;
  dismiss(id: string): void;
  /** The rows leaving: pin the rows around the cursor and, for a commit kind, fly the first few. */
  leave(kind: CommitKind | null, rowIds: readonly string[]): void;
}

/** One bulk commit. */
export interface BulkCommit {
  readonly target: BulkTarget;
  readonly verb: BulkVerb;
  /** The rows that leave, in list order. */
  readonly rowIds: readonly string[];
  /** The number the toast names. */
  readonly count: number;
  /** Runs after the act is issued: the picks clear and the cursor settles (decided before the act moved the rows). */
  readonly settle: () => void;
}

/** One bulk action: one `act` over the target, one toast with Undo, then the screen settles. */
export function commitBulk(side: BulkSide, commit: BulkCommit): void {
  const { verb, target, rowIds } = commit;
  side.leave(commitKindOf(verb.kind), rowIds);
  const { opId, receipt } = side.act(actArgs(target, verb.action));
  side.push({
    id: opId,
    undoable: true,
    actions: [UNDO_ACTION],
    onAction: undoHandler(opId),
    kind: verb.kind,
    message: verb.message(commit.count),
  });
  receipt.catch(() => side.dismiss(opId));
  commit.settle();
}

/** What the owner confirmed, still on screen: the confirmed ids that are loaded now, in the order they were asked about. */
export function confirmedIds(asked: readonly string[], loaded: readonly string[]): string[] {
  const live = new Set(loaded);
  return asked.filter(id => live.has(id));
}

/** Whether two id lists name the same rows in the same order. */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, at) => id === b[at]);
}

/**
 * A row acted on by itself leaves the pick: while the hold keeps it in the view it must not be picked again by the next
 * bulk action. `picked` is the pick as it stood before the act.
 */
export function dropFromPick(
  selection: PickControls | undefined,
  picked: readonly string[] | undefined,
  id: string,
): void {
  if (picked?.includes(id)) selection?.toggle(id);
}

/** The keys that change the pick, over a cursor key the screen decides (Home's can be on a row only). */
export interface PickActions {
  select(): void;
  selectRange(): void;
  selectAll(): void;
  clearSelection(): void;
}

export function createPickActions(
  selection: PickControls | undefined,
  cursorKey: () => string | null,
  holdAll: () => void = () => undefined,
): PickActions {
  const withCursor = (run: (id: string) => void) => {
    const key = cursorKey();
    if (key !== null) run(key);
  };
  return {
    select: () => withCursor(id => selection?.toggle(id)),
    selectRange: () => withCursor(id => selection?.extendTo(id)),
    selectAll: () => {
      // Mail arriving while the whole view is picked waits, so what the owner sees picked is what they act on.
      holdAll();
      selection?.selectAll();
    },
    clearSelection: () => selection?.clear(),
  };
}

// ---------------------------------------------------------------------------
// The lists' side
// ---------------------------------------------------------------------------

/** The rows around the cursor stay still; with a commit kind the rows leaving also fly. */
export function holdRows(
  deps: ListDeps,
  kind: CommitKind | null,
  rowIds: readonly string[],
  extra: readonly string[] = [],
): void {
  const snapshot = deps.snapshot();
  const holdIds = [...extra, ...neighbourKeys(snapshot.ids, snapshot.key)];
  if (kind !== null && deps.commit) deps.commit(kind, holdIds, rowIds);
  else deps.hold.extend(holdIds);
}

function listSide(deps: ListDeps): BulkSide {
  return {
    act: args => deps.act(args),
    push: toast => deps.push(toast),
    dismiss: id => deps.dismiss(id),
    leave: (kind, rowIds) => holdRows(deps, kind, rowIds, rowIds),
  };
}

/** The bulk pick, or null when nothing is picked. */
function picksOf(deps: ListDeps): BulkPick | null {
  const bulk = deps.snapshot().bulk;
  return bulk && bulk.picked.length > 0 ? bulk : null;
}

/** The number a bar, a toast and a question name: the whole view after ⌘A past the window, else the picks. */
function countOf(pick: BulkPick): number {
  return bulkCount({ ...pick, count: pick.picked.length });
}

function actOnPicks(deps: ListDeps, pick: BulkPick, verb: BulkVerb): void {
  const snapshot = deps.snapshot();
  const cursorAfter = survivorKey(snapshot.ids, snapshot.key, pick.picked);
  commitBulk(listSide(deps), {
    target: bulkTargetOf(pick),
    verb,
    rowIds: pick.picked,
    count: countOf(pick),
    settle: () => {
      deps.selection?.clear();
      deps.setCursor(cursorAfter);
    },
  });
}

/** Bookmark the picks, or remove the bookmark from all of them when every one has it. */
function bookmarkVerb(deps: ListDeps, pick: BulkPick): BulkVerb {
  const marked = (id: string) => {
    const row = deps.snapshot().rowOf(id);
    return row !== undefined && isThread(row) && row.workflow.bookmarked;
  };
  const on = !pick.picked.every(marked);
  return labelledVerb(on ? 'Bookmarked' : 'Bookmark removed', { type: 'bookmark', on }, 'bookmark');
}

/** # with rows picked: every kind asks first, because a bulk removal is the one thing Undo may not reach in time. */
function askToTrash(deps: ListDeps, pick: BulkPick): void {
  const ids = pick.picked;
  // Deleting and discarding name the rows they act on; only a whole-view trash may name the view's total.
  const count = ids.length;
  if (deps.kind === 'drafts') return deps.setConfirmation({ kind: 'discardDraft', ids, count });
  if (deps.kind === 'trash' || deps.kind === 'spam') {
    if (deps.canDeleteForever()) deps.setConfirmation({ kind: 'deleteForever', ids, count });
    return;
  }
  const asked = countOf(pick);
  if (TRIAGE_KINDS.includes(deps.kind))
    deps.setConfirmation({ kind: 'trashPicked', ids, count: asked });
}

/**
 * The rows a confirmed trash moves: the live pick when it is still exactly what was asked about (a whole-view pick keeps
 * its selector), else the asked-about rows that are still loaded. Nothing when none are.
 */
function confirmedPick(deps: ListDeps, pending: Confirmation): BulkPick | null {
  const pick = picksOf(deps);
  if (pick && sameIds(pick.picked, pending.ids)) return pick;
  const { ids } = deps.snapshot();
  const picked = confirmedIds(pending.ids, ids);
  if (picked.length === 0) return null;
  return {
    loadedIds: ids,
    total: picked.length,
    spec: null,
    state: null,
    allPicked: false,
    picked,
  };
}

/** The verbs a list runs over its picks. The caller has already checked the list owns the verb. */
export interface ListBulk {
  /** The bulk pick, or null when nothing is picked. */
  picks(): BulkPick | null;
  done(pick: BulkPick): void;
  later(pick: BulkPick): void;
  bookmark(pick: BulkPick): void;
  restore(pick: BulkPick): void;
  moveToHome(pick: BulkPick): void;
  /** Asks first; nothing moves until `confirmTrash`. */
  trash(pick: BulkPick): void;
  /** The owner confirmed this question: trash the rows it named, not whatever is picked by now. */
  confirmTrash(pending: Confirmation): void;
}

export function createListBulk(deps: ListDeps): ListBulk {
  const act = (pick: BulkPick, verb: BulkVerb) => actOnPicks(deps, pick, verb);
  return {
    picks: () => picksOf(deps),
    done: pick => act(pick, DONE_VERB),
    later: pick => act(pick, LATER_VERB),
    bookmark: pick => act(pick, bookmarkVerb(deps, pick)),
    restore: pick => {
      const label = deps.undoLabel('mail.restore', 'Restored');
      act(pick, labelledVerb(label, { type: 'restore' }, 'info'));
    },
    moveToHome: pick => {
      const label = deps.undoLabel('done.moveToHome', 'Moved to Home');
      act(pick, labelledVerb(label, { type: 'restore' }, 'home'));
    },
    trash: pick => askToTrash(deps, pick),
    confirmTrash: pending => {
      const pick = confirmedPick(deps, pending);
      if (pick) act(pick, TRASH_VERB);
    },
  };
}
