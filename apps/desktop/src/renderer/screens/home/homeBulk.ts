/**
 * Home's bulk pick (DESIGN 7.2, 7.4): the same verbs as the lists, over the ordinary rows. The focus letter row can be
 * picked like any other (it just draws no wash while it is under the cursor); the Low band never can. Done, Later and
 * Bookmark act on the picks with one `act` and one Undo toast through `commitBulk`; Trash asks first. No React: the
 * screen supplies `HomeBulkDeps`, and the tests drive it with the stand-in engine.
 */
import type { ThreadId } from '../../data';
import type { CommitKind } from '../../ui/props';
import {
  DONE_VERB,
  LATER_VERB,
  MAX_FLYING,
  TRASH_VERB,
  commitBulk,
  confirmedIds,
  createPickActions,
  labelledVerb,
  type BulkSide,
  type BulkVerb,
  type PickActions,
  type PickControls,
} from '../lists/bulkActions';
import type { Confirmation } from '../lists/listActions';
import { survivorKey } from '../lists/listModel';
import type { HomeDeps, HomeSnapshot } from './homeActions';
import { HOLD_RADIUS, keyOf, neighbourIds, pickableIds, pickableKey } from './homeModel';

/** The screen's side of the pick: the controls X, ⇧X, ⌘A and Esc drive, and the trash confirmation. */
export interface HomeBulkDeps {
  readonly selection: PickControls;
  confirmation(): Confirmation | null;
  setConfirmation(next: Confirmation | null): void;
}

/** The verbs Home runs over its picks. */
export interface HomeBulk extends PickActions {
  /** The picked ids in list order, or null when nothing is picked. */
  picks(): readonly ThreadId[] | null;
  done(picked: readonly ThreadId[]): void;
  later(picked: readonly ThreadId[]): void;
  bookmark(picked: readonly ThreadId[]): void;
  /** Asks first; nothing moves until `confirm`. */
  trash(picked: readonly ThreadId[]): void;
  /** The owner chose Move to Trash. */
  confirm(): void;
  cancelConfirm(): void;
}

/** The rows leaving fly (the first few) and the rows around the cursor stay still. */
function leaveRows(
  deps: HomeDeps,
  kind: CommitKind | null,
  rowIds: readonly ThreadId[],
  snapshot: HomeSnapshot,
): void {
  const holdIds = [...rowIds, ...neighbourIds(snapshot.items, snapshot.key, HOLD_RADIUS)];
  if (kind === null || !deps.commit) return deps.hold.extend(holdIds);
  for (const id of rowIds.slice(0, MAX_FLYING)) {
    deps.commit(kind, holdIds, id);
  }
}

function sideOf(deps: HomeDeps): BulkSide {
  return {
    act: args => deps.act(args),
    push: toast => deps.push(toast),
    dismiss: id => deps.dismiss(id),
    leave: (kind, rowIds) => leaveRows(deps, kind, rowIds, deps.snapshot()),
  };
}

function commitPicks(
  deps: HomeDeps,
  bulk: HomeBulkDeps,
  picked: readonly string[],
  verb: BulkVerb,
) {
  const snapshot = deps.snapshot();
  const cursorAfter = survivorKey(snapshot.items.map(keyOf), snapshot.key, picked);
  commitBulk(sideOf(deps), {
    target: { ids: picked },
    verb,
    rowIds: picked,
    count: picked.length,
    settle: () => {
      bulk.selection.clear();
      // The card's mail is among the picks and leaves Home (Done, Later, Trash): Undo should bring the card back to it.
      // A Bookmark leaves every mail where it is, so there is nothing to hand back.
      const leaves = verb.action.type !== 'bookmark';
      const cardKey =
        snapshot.key !== null && picked.includes(snapshot.key) ? snapshot.key : undefined;
      deps.setCursor(cursorAfter, leaves ? cardKey : undefined);
    },
  });
}

/** Bookmark the picks, or remove the bookmark from all of them when every one has it. */
function bookmarkVerb(deps: HomeDeps, picked: readonly ThreadId[]): BulkVerb {
  const marked = (id: ThreadId) => deps.snapshot().rowOf(id)?.workflow.bookmarked === true;
  const on = !picked.every(marked);
  return labelledVerb(on ? 'Bookmarked' : 'Bookmark removed', { type: 'bookmark', on }, 'bookmark');
}

/** Home's bulk verbs; `undefined` without a pick (the one-by-one view, which never picks). */
export function createHomeBulk(deps: HomeDeps): HomeBulk | undefined {
  const bulk = deps.bulk;
  if (!bulk) return undefined;
  const cursorRow = () => {
    const { items, key } = deps.snapshot();
    return pickableKey(items, key);
  };
  const commit = (picked: readonly ThreadId[], verb: BulkVerb) =>
    commitPicks(deps, bulk, picked, verb);
  return {
    ...createPickActions(bulk.selection, cursorRow, () =>
      deps.hold.extend(pickableIds(deps.snapshot().items)),
    ),
    picks: () => {
      const picked = deps.snapshot().picked;
      return picked && picked.length > 0 ? picked : null;
    },
    done: picked => commit(picked, DONE_VERB),
    later: picked => commit(picked, LATER_VERB),
    bookmark: picked => commit(picked, bookmarkVerb(deps, picked)),
    trash: picked =>
      bulk.setConfirmation({ kind: 'trashPicked', ids: picked, count: picked.length }),
    confirm: () => {
      const pending = bulk.confirmation();
      bulk.setConfirmation(null);
      if (!pending) return;
      // The rows the owner was asked about, not whatever is picked by now.
      const asked = confirmedIds(pending.ids, pickableIds(deps.snapshot().items));
      if (asked.length > 0) commit(asked, TRASH_VERB);
    },
    cancelConfirm: () => bulk.setConfirmation(null),
  };
}
