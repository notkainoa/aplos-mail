/**
 * What Home's commands do (DESIGN 7.2, 7.13): move the cursor, Done, Later, a lane up or down, the suggested action,
 * Clear from Home. Each one commits synchronously on the keydown (the overlay is applied when `act` returns), starts
 * the hold, and raises the one toast for the operation with its opId as the id. The screen supplies the live state and
 * the side-effects as `HomeDeps`, so this file has no React and the tests drive it with the stand-in engine.
 */
import type { AccountId, DataApi, Id, State, ThreadId, ThreadRow } from '../../data';
import type { PushedToast } from '../../shell';
import type { CommitKind } from '../../ui/props';
import {
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
import { senderOf } from './homeRows';

/** The live state an action reads when its key arrives. */
export interface HomeSnapshot {
  readonly items: readonly HomeItem[];
  readonly key: string | null;
  readonly rowOf: RowOf;
  /** The `home` window's state, for selectors ("Clear from Home" acts on what the owner saw). */
  readonly state: State | null;
  readonly accountId?: AccountId;
}

/** What a command run reports back (the registry's `RunResult` status). */
export type RunStatus = 'ran' | 'failed' | 'unknown' | 'unhandled' | 'disabled' | 'other';

/** How a thread is opened when the reader is not mounted by this lane: plain open, or reply. */
export type OpenHow = 'open' | 'reply';

/** The screen's side of the actions. */
export interface HomeDeps {
  snapshot(): HomeSnapshot;
  setCursor(key: string | null): void;
  /** `api.thread.act`. */
  act: DataApi['thread']['act'];
  push(toast: PushedToast): string;
  dismiss(id: string): void;
  /** The hold gate (`useHold('home')`): a key starts or extends it around `ids`. */
  hold: { extend(ids?: readonly Id[]): void };
  /** Draws the commit (ghost, chip, edge); it also extends the hold, so only one of the two is called. */
  commit?(kind: CommitKind, holdIds: readonly Id[]): void;
  /** Who may press R: the thread a "Remind me if no reply" toast is offering, or null. */
  offerReminder(id: ThreadId | null): void;
  reminderOffer(): ThreadId | null;
  /** Runs a registry command (Space on a reply runs `mail.reply`, which the reader lane owns). */
  runCommand(id: string): RunStatus;
  /** Fallback when a command is not handled yet. */
  openThread(id: ThreadId, how: OpenHow): void;
  openLow(): void;
  oneByOne(): void;
  openMore(): void;
  /** The confirmed toast text of a command ("Done", "Moved to Later"), read from the registry. */
  undoLabel(commandId: string, fallback: string): string;
}

/** The commands Home answers, as plain functions. */
export interface HomeActions {
  move(delta: 1 | -1): void;
  jump(delta: 1 | -1): void;
  /** Done on the row under the cursor, or on the row with this cursor key (a hover button). */
  done(key?: string): void;
  later(key?: string): void;
  lane(direction: 'up' | 'down'): void;
  /** Move to Trash (#); the toast offers Undo. */
  trash(): void;
  /** Bookmark or remove the bookmark on the row under the cursor. */
  bookmark(): void;
  suggested(): void;
  open(): void;
  clearFromHome(): void;
  remind(): void;
}

/** Radius of rows pinned around the cursor while a burst lasts. */
const HOLD_RADIUS = 3;

const LANE_LABEL: Readonly<Record<MovableLane, string>> = {
  do: 'Do now',
  update: 'Important updates',
  low: 'Low importance',
};

const UNDO = { id: 'undo', label: 'Undo', commandId: 'app.undo' } as const;

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
  const around = (snapshot: HomeSnapshot) =>
    neighbourIds(snapshot.items, snapshot.key, HOLD_RADIUS);

  function startHold(snapshot: HomeSnapshot, kind?: CommitKind): void {
    const ids = around(snapshot);
    if (kind && deps.commit) deps.commit(kind, ids);
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
    const snapshot = read(key);
    const target = targetOf(snapshot);
    if (!target) return;
    startHold(snapshot, 'done');
    const { opId, receipt } = deps.act({ ids: [target.row.id], action: { type: 'done' } });
    const remind = offersReminder(target.row, target.section);
    deps.push({
      id: opId,
      kind: 'done',
      message: deps.undoLabel('mail.done', 'Done'),
      undoable: true,
      actions: remind
        ? [
            { id: 'remind', label: 'Remind me if no reply', commandId: 'mail.remindIfNoReply' },
            UNDO,
          ]
        : [UNDO],
    });
    deps.offerReminder(remind ? target.row.id : null);
    failOnReject(opId, receipt);
  }

  function later(key?: string): void {
    const snapshot = read(key);
    const target = targetOf(snapshot);
    if (!target) return;
    startHold(snapshot, 'later');
    const { opId, receipt } = deps.act({ ids: [target.row.id], action: { type: 'later' } });
    deps.push({
      id: opId,
      kind: 'later',
      message: deps.undoLabel('mail.later', 'Moved to Later'),
      undoable: true,
      actions: [{ id: 'setDate', label: 'Set a date', commandId: 'mail.setDate' }, UNDO],
    });
    failOnReject(opId, receipt);
  }

  function lane(direction: 'up' | 'down'): void {
    const snapshot = deps.snapshot();
    const target = targetOf(snapshot);
    const from = target && target.section !== 'follow' ? laneOf(target.row) : null;
    const to = from ? stepLane(from, direction) : null;
    if (!target || !to) return;
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
      actions: [{ id: 'always', label: always }, UNDO],
      onAction: actionId => {
        if (actionId !== 'always') return;
        deps.act({
          ids: [target.row.id],
          action: { type: 'lane', lane: to, alsoForSender: true },
        });
      },
    });
    failOnReject(opId, receipt);
  }

  function trash(): void {
    const snapshot = deps.snapshot();
    const target = targetOf(snapshot);
    if (!target) return;
    startHold(snapshot, 'trash');
    const { opId, receipt } = deps.act({ ids: [target.row.id], action: { type: 'trash' } });
    deps.push({
      id: opId,
      kind: 'trash',
      message: deps.undoLabel('mail.trash', 'Moved to Trash'),
      undoable: true,
      actions: [UNDO],
    });
    failOnReject(opId, receipt);
  }

  function bookmark(): void {
    const target = targetOf(deps.snapshot());
    if (!target) return;
    const on = !target.row.workflow.bookmarked;
    const { opId, receipt } = deps.act({ ids: [target.row.id], action: { type: 'bookmark', on } });
    deps.push({
      id: opId,
      kind: 'bookmark',
      message: on ? 'Bookmarked' : 'Bookmark removed',
      undoable: true,
      actions: [UNDO],
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
    if (command === 'mail.done') return done();
    if (command === 'mail.open') return deps.openThread(target.row.id, 'open');
    const status = deps.runCommand(command);
    if (status === 'unhandled' || status === 'unknown') deps.openThread(target.row.id, 'reply');
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
      actions: [UNDO],
    });
    failOnReject(opId, receipt);
  }

  function remind(): void {
    const id = deps.reminderOffer();
    if (id === null) return;
    deps.offerReminder(null);
    const { opId, receipt } = deps.act({
      ids: [id],
      action: { type: 'reminder', ifNoReply: true },
    });
    deps.push({ id: opId, kind: 'info', message: 'Reminder set', undoable: true, actions: [UNDO] });
    failOnReject(opId, receipt);
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
    trash,
    bookmark,
    suggested,
    open,
    clearFromHome,
    remind,
  };
}
