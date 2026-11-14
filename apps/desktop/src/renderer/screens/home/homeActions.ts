/**
 * What Home's commands do (DESIGN 7.2, 7.13): move the cursor, Done, Later, a lane up or down, the suggested action,
 * Clear from Home. Each one commits synchronously on the keydown (the overlay is applied when `act` returns), starts
 * the hold, and raises the one toast for the operation with its opId as the id. The screen supplies the live state and
 * the side-effects as `HomeDeps`, so this file has no React and the tests drive it with the stand-in engine.
 */
import type { AccountId, DataApi, Id, State, ThreadId, ThreadRow } from '../../data';
import type { PushedToast, ThreadReply } from '../../shell';
import type { CommitKind } from '../../ui/props';
import {
  HOLD_RADIUS,
  jumpSection,
  keyOf,
  laneOf,
  neighbourIds,
  offersReminder,
  stepCursor,
  stepLane,
  suggestedCommand,
  type HomeItem,
  type MovableLane,
  type RowOf,
  type SectionKey,
} from './homeModel';
import { dropFromPick } from '../lists/bulkActions';
import { createHomeBulk, type HomeBulkDeps } from './homeBulk';
import { failurePhrase, senderOf } from './homeRows';
import { UNDO_ACTION, undoHandler } from '../undoOperation';

/** The live state an action reads when its key arrives. */
export interface HomeSnapshot {
  readonly items: readonly HomeItem[];
  readonly key: string | null;
  readonly rowOf: RowOf;
  /** The `home` window's state, for selectors ("Clear from Home" acts on what the owner saw). */
  readonly state: State | null;
  readonly accountId?: AccountId;
  /** The bulk pick in list order; absent while nothing is picked. */
  readonly picked?: readonly ThreadId[];
}

/** How a thread is opened from Home or one by one: a plain open, or the reader with its reply card already up. */
export type OpenHow = 'open' | ThreadReply;

/** A short word for a way of opening a thread (logs and tests). */
export function describeHow(how: OpenHow): string {
  if (how === 'open') return how;
  if (how.nudge) return 'nudge';
  if (how.replyAll) return 'replyAll';
  return how.dictate ? 'dictate' : 'reply';
}

/** R. */
export const REPLY: ThreadReply = { replyAll: false, dictate: false, nudge: false };
/** ⇧R. */
export const REPLY_ALL: ThreadReply = { ...REPLY, replyAll: true };
/** Holding R. */
export const DICTATE: ThreadReply = { ...REPLY, dictate: true };
/** Space on a Follow up row: the reply card starts with the dim nudge. */
export const NUDGE: ThreadReply = { ...REPLY, nudge: true };

/** The screen's side of the actions. */
export interface HomeDeps {
  snapshot(): HomeSnapshot;
  /** `departed`: the row the cursor leaves because its mail went (a bulk action); Undo then hands the card back. */
  setCursor(key: string | null, departed?: string): void;
  /** `api.thread.act`. */
  act: DataApi['thread']['act'];
  push(toast: PushedToast): string;
  dismiss(id: string): void;
  /** The hold gate (`useHold('home')`): a key starts or extends it around `ids`. */
  hold: { extend(ids?: readonly Id[]): void };
  /** The bulk pick (X, ⇧X, ⌘A) and its trash confirmation. Absent: this screen cannot pick (the one-by-one view). */
  bulk?: HomeBulkDeps;
  /** Draws the commit (ghost, chip, edge); it also extends the hold, so only one of the two is called. */
  commit?(kind: CommitKind, holdIds: readonly Id[], rowId: ThreadId): void;
  /** Who may press R: the thread a "Remind me if no reply" toast is offering (and that toast's id), or null. */
  offerReminder(id: ThreadId | null, opId?: string): void;
  reminderOffer(): ThreadId | null;
  /** Opens the Later date presets for this thread (D on the cursor row, or "Set a date" on its Later toast). */
  openDatePicker(id: ThreadId): void;
  /** Opens the thread in the reader, or in its reply card (the reader lane owns both). */
  openThread(id: ThreadId, how: OpenHow): void;
  openLow(): void;
  oneByOne(): void;
  openMore(): void;
  /** `.` with rows picked: the bulk bar's More menu, in place of the cursor row's ⋯ menu. */
  openBulkMore?(): void;
  /** The confirmed toast text of a command ("Done", "Moved to Later"), read from the registry. */
  undoLabel(commandId: string, fallback: string): string;
}

/** The commands Home answers, as plain functions. */
export interface HomeActions {
  move(delta: 1 | -1): void;
  jump(delta: 1 | -1): void;
  /**
   * Done on the picked rows when any are picked, else on the row under the cursor, or on the row with this cursor key
   * (a hover button or the focus letter's own, which always mean their own row). Later, Trash and Bookmark follow the same rule.
   */
  done(key?: string): void;
  later(key?: string): void;
  lane(direction: 'up' | 'down'): void;
  /** The Importance menu's move: straight to a lane (the same absolute `lane` action as ⌥↑ / ⌥↓), on the row under the cursor. */
  laneTo(to: MovableLane): void;
  /** Move to Trash (#); the toast offers Undo. With picks it asks first. */
  trash(key?: string): void;
  /** Bookmark or remove the bookmark on the row under the cursor. */
  bookmark(key?: string): void;
  /** X: pick or unpick the cursor row; the cursor stays. Does nothing on the Low band. */
  select(): void;
  /** ⇧X: pick the run from the anchor to the cursor. */
  selectRange(): void;
  /** ⌘A: every loaded row. */
  selectAll(): void;
  /** Esc. */
  clearSelection(): void;
  /** The owner chose Move to Trash on the bulk confirmation. */
  confirm(): void;
  cancelConfirm(): void;
  suggested(): void;
  open(): void;
  clearFromHome(): void;
  /** `.`: the bulk More menu while rows are picked, else the cursor row's ⋯ menu. */
  more(): void;
  /** R, ⇧R, hold R: opens the row under the cursor in the reader with its reply card up. */
  reply(how?: ThreadReply): void;
  /** U: marks the row under the cursor read or unread. */
  toggleRead(): void;
  /** R, or "Remind me if no reply" on that thread's own Done toast. */
  remind(id?: ThreadId): void;
  /** D on the cursor row, or "Set a date" on that thread's own Later toast: opens the date presets. */
  setDate(id?: ThreadId): void;
  /** An operation was undone (its toast's Undo, or Z): its toast closes and its reminder offer, if it had one, is withdrawn. */
  undone(opId: string): void;
}

const LANE_LABEL: Readonly<Record<MovableLane, string>> = {
  do: 'Do now',
  update: 'Important updates',
  low: 'Low importance',
};

interface Target {
  readonly row: ThreadRow;
  readonly section: SectionKey;
}

function targetOf(snapshot: HomeSnapshot): Target | null {
  const item = snapshot.items.find(candidate => keyOf(candidate) === snapshot.key);
  if (!item || item.kind !== 'row') return null;
  const row = snapshot.rowOf(item.id);
  return row ? { row, section: item.section } : null;
}

export function createHomeActions(deps: HomeDeps): HomeActions {
  /** The operation whose Done toast is offering a reminder (the one R answers), or null. */
  let offeredOp: string | null = null;

  const undone = (opId: string): void => {
    // Z undoes without the toast's own button, so the toast (and its live "Remind me if no reply") closes here.
    deps.dismiss(opId);
    if (opId !== offeredOp) return;
    offeredOp = null;
    deps.offerReminder(null);
  };

  const offer = (opId: string | null, id: ThreadId | null): void => {
    offeredOp = opId;
    deps.offerReminder(id, opId ?? undefined);
  };

  const bulk = createHomeBulk(deps);
  /** The picks when the verb is for them: no key (a hover button or the letter means its own row). */
  const pickedFor = (key?: string) => (key === undefined ? (bulk?.picks() ?? null) : null);

  /** A row acted on by itself leaves the pick, so the hold keeping it in view cannot get it picked again. */
  const unpick = (snapshot: HomeSnapshot, id: ThreadId) =>
    dropFromPick(deps.bulk?.selection, snapshot.picked, id);

  const around = (snapshot: HomeSnapshot) =>
    neighbourIds(snapshot.items, snapshot.key, HOLD_RADIUS);

  /** Pins the rows around the key; with a `kind` it also draws the commit on the row that is leaving (`rowId`). */
  function startHold(snapshot: HomeSnapshot, kind?: CommitKind, rowId?: ThreadId): void {
    const ids = around(snapshot);
    if (kind && rowId !== undefined && deps.commit) deps.commit(kind, ids, rowId);
    else deps.hold.extend(ids);
  }

  function failOnReject(opId: string, receipt: Promise<unknown>): void {
    receipt.catch(() => deps.dismiss(opId));
  }

  const read = (key?: string): HomeSnapshot => {
    const snapshot = deps.snapshot();
    return key === undefined ? snapshot : { ...snapshot, key };
  };

  function done(key?: string): void {
    const picked = pickedFor(key);
    if (picked) return bulk?.done(picked);
    const snapshot = read(key);
    const target = targetOf(snapshot);
    if (!target) return;
    startHold(snapshot, 'done', target.row.id);
    const { opId, receipt } = deps.act({ ids: [target.row.id], action: { type: 'done' } });
    unpick(snapshot, target.row.id);
    const remind = offersReminder(target.row, target.section);
    deps.push({
      id: opId,
      kind: 'done',
      message: deps.undoLabel('mail.done', 'Done'),
      undoable: true,
      actions: remind
        ? [
            { id: 'remind', label: 'Remind me if no reply', keysFrom: 'mail.remindIfNoReply' },
            UNDO_ACTION,
          ]
        : [UNDO_ACTION],
      onAction: actionId => {
        if (actionId === 'remind') remindAbout(target.row.id);
        else undoHandler(opId, () => undone(opId))(actionId);
      },
    });
    offer(remind ? opId : null, remind ? target.row.id : null);
    failOnReject(opId, receipt);
  }

  function later(key?: string): void {
    const picked = pickedFor(key);
    if (picked) return bulk?.later(picked);
    const snapshot = read(key);
    const target = targetOf(snapshot);
    if (!target) return;
    startHold(snapshot, 'later', target.row.id);
    const { opId, receipt } = deps.act({ ids: [target.row.id], action: { type: 'later' } });
    unpick(snapshot, target.row.id);
    deps.push({
      id: opId,
      kind: 'later',
      message: deps.undoLabel('mail.later', 'Moved to Later'),
      undoable: true,
      actions: [{ id: 'setDate', label: 'Set a date', keysFrom: 'mail.setDate' }, UNDO_ACTION],
      onAction: actionId => {
        if (actionId === 'setDate') deps.openDatePicker(target.row.id);
        else undoHandler(opId, () => undone(opId))(actionId);
      },
    });
    failOnReject(opId, receipt);
  }

  function lane(direction: 'up' | 'down'): void {
    const snapshot = deps.snapshot();
    const target = targetOf(snapshot);
    const from = target && target.section !== 'follow' ? laneOf(target.row) : null;
    const to = from ? stepLane(from, direction) : null;
    if (target && to) moveToLane(snapshot, target, to);
  }

  function laneTo(to: MovableLane): void {
    const snapshot = deps.snapshot();
    const target = targetOf(snapshot);
    if (target && target.section !== 'follow') moveToLane(snapshot, target, to);
  }

  function moveToLane(snapshot: HomeSnapshot, target: Target, to: MovableLane): void {
    startHold(snapshot);
    // The absolute lane, not `laneStep`: the overlay can place a row in a named lane at once, and a retry is idempotent.
    const { opId, receipt } = deps.act({
      ids: [target.row.id],
      action: { type: 'lane', lane: to },
    });
    const always = `Always do this for ${senderOf(target.row)}`;
    deps.push({
      id: opId,
      kind: 'info',
      message: `Moved to ${LANE_LABEL[to]}`,
      undoable: true,
      actions: [{ id: 'always', label: always }, UNDO_ACTION],
      onAction: actionId => {
        if (actionId !== 'always') return undoHandler(opId)(actionId);
        setRule(target.row.id, to);
      },
    });
    failOnReject(opId, receipt);
  }

  /** "Always do this for X": the same move, as a rule. A refusal says so instead of going unheard. */
  function setRule(id: ThreadId, to: MovableLane): void {
    const action = { type: 'lane', lane: to, alsoForSender: true } as const;
    const { opId, receipt } = deps.act({ ids: [id], action });
    receipt.catch(() =>
      deps.push({
        id: opId,
        kind: 'info',
        message: `Couldn’t ${failurePhrase(action)}.`,
        undoable: false,
        persistent: true,
      }),
    );
  }

  function trash(key?: string): void {
    const picked = pickedFor(key);
    if (picked) return bulk?.trash(picked);
    const snapshot = read(key);
    const target = targetOf(snapshot);
    if (!target) return;
    startHold(snapshot, 'trash', target.row.id);
    const { opId, receipt } = deps.act({ ids: [target.row.id], action: { type: 'trash' } });
    unpick(snapshot, target.row.id);
    deps.push({
      id: opId,
      kind: 'trash',
      message: deps.undoLabel('mail.trash', 'Moved to Trash'),
      undoable: true,
      actions: [UNDO_ACTION],
      onAction: undoHandler(opId),
    });
    failOnReject(opId, receipt);
  }

  function bookmark(key?: string): void {
    const picked = pickedFor(key);
    if (picked) return bulk?.bookmark(picked);
    const target = targetOf(read(key));
    if (!target) return;
    const on = !target.row.workflow.bookmarked;
    const { opId, receipt } = deps.act({ ids: [target.row.id], action: { type: 'bookmark', on } });
    deps.push({
      id: opId,
      kind: 'bookmark',
      message: on ? 'Bookmarked' : 'Bookmark removed',
      undoable: true,
      actions: [UNDO_ACTION],
      onAction: undoHandler(opId),
    });
    failOnReject(opId, receipt);
  }

  function open(): void {
    const snapshot = deps.snapshot();
    const item = snapshot.items.find(candidate => keyOf(candidate) === snapshot.key);
    if (item?.kind === 'low') deps.openLow();
    else if (item) deps.openThread(item.id, 'open');
  }

  function suggested(): void {
    const target = targetOf(deps.snapshot());
    if (!target) return open();
    const command = suggestedCommand(target.row, target.section);
    if (command === 'mail.done') return done(target.row.id);
    if (command === 'mail.open') return deps.openThread(target.row.id, 'open');
    deps.openThread(target.row.id, target.section === 'follow' ? NUDGE : REPLY);
  }

  function reply(how: ThreadReply = REPLY): void {
    const target = targetOf(deps.snapshot());
    if (target) deps.openThread(target.row.id, how);
  }

  function toggleRead(): void {
    const target = targetOf(deps.snapshot());
    if (!target) return;
    const { row } = target;
    const { opId, receipt } = deps.act({
      ids: [row.id],
      action: { type: row.unread ? 'read' : 'unread' },
    });
    deps.push({
      id: opId,
      kind: 'info',
      message: row.unread ? 'Marked read' : 'Marked unread',
      undoable: true,
      actions: [UNDO_ACTION],
      onAction: undoHandler(opId),
    });
    failOnReject(opId, receipt);
  }

  function clearFromHome(): void {
    const { state, accountId } = deps.snapshot();
    if (!state) return;
    const { opId, receipt } = deps.act({
      selector: { spec: { kind: 'home', accountId }, section: 'fromLater', atState: state },
      action: { type: 'clearFromHome' },
    });
    deps.push({
      id: opId,
      kind: 'later',
      message: deps.undoLabel('home.clearFromHome', 'Moved to Later'),
      undoable: true,
      actions: [UNDO_ACTION],
      onAction: undoHandler(opId),
    });
    failOnReject(opId, receipt);
  }

  /** Sets "Remind me if no reply" on `id`; the live offer ends when it was for this thread. */
  function remindAbout(id: ThreadId): void {
    if (deps.reminderOffer() === id) offer(null, null);
    const { opId, receipt } = deps.act({
      ids: [id],
      action: { type: 'reminder', ifNoReply: true },
    });
    deps.push({
      id: opId,
      kind: 'info',
      message: 'Reminder set',
      undoable: true,
      actions: [UNDO_ACTION],
      onAction: undoHandler(opId),
    });
    failOnReject(opId, receipt);
  }

  function remind(id?: ThreadId): void {
    const at = id ?? deps.reminderOffer();
    if (at !== null) remindAbout(at);
  }

  function setDate(id?: ThreadId): void {
    const at = id ?? targetOf(deps.snapshot())?.row.id;
    if (at !== undefined) deps.openDatePicker(at);
  }

  function moveCursor(next: (snapshot: HomeSnapshot) => string | null): void {
    const snapshot = deps.snapshot();
    const key = next(snapshot);
    deps.setCursor(key);
    deps.hold.extend(neighbourIds(snapshot.items, key, HOLD_RADIUS));
  }

  return {
    move: delta => moveCursor(s => stepCursor(s.items, s.key, delta)),
    jump: delta => moveCursor(s => jumpSection(s.items, s.key, delta)),
    done,
    later,
    lane,
    laneTo,
    trash,
    bookmark,
    suggested,
    reply,
    toggleRead,
    open,
    clearFromHome,
    more: () => (bulk?.picks() && deps.openBulkMore ? deps.openBulkMore() : deps.openMore()),
    select: () => bulk?.select(),
    selectRange: () => bulk?.selectRange(),
    selectAll: () => bulk?.selectAll(),
    clearSelection: () => bulk?.clearSelection(),
    confirm: () => bulk?.confirm(),
    cancelConfirm: () => bulk?.cancelConfirm(),
    remind,
    setDate,
    undone,
  };
}
