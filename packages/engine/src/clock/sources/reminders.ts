import type { DeadlineSource } from '../../ports/time';
import type { FrameBus } from '../../runtime/frames';
import type { StorePort, StoreReader, WorkflowWrite } from '../../store/port';
import { announce, clampTitle, noticeFor, RECHECK_MS, threadIdOf, type DueThread } from './notice';

export interface ReminderItem {
  threadId: string;
  at: number;
  firedAt?: number;
  ifNoReply: boolean;
  title: string;
}

export interface ReminderService {
  readonly source: DeadlineSource;
  /** Upcoming reminders and fired ones the owner has not seen yet, soonest first. */
  list(): ReminderItem[];
  /** Marks fired reminders of these threads seen. Upcoming reminders and unknown ids are left alone. */
  ack(opId: string, threadIds: readonly string[]): { dbEpoch: string; seq: number };
}

export interface ReminderDeps {
  store: StorePort;
  clock: { now(): number };
  frames: Pick<FrameBus, 'emit'>;
  /** The owner's IANA zone, read per call, for "was due 9:00". */
  zone: () => string;
}

interface Row extends DueThread {
  firedAt: number | null;
  editedAt: number | null;
}

const COLUMNS = `t.account_id AS accountId, t.remote_id AS remoteId, t.subject AS subject,
  w.reminder_at AS at, w.reminder_fired_at AS firedAt, w.edited_at AS editedAt`;
const JOIN = 'JOIN threads t ON t.id = w.thread_id';
const FROM_PENDING = `FROM thread_workflow w INDEXED BY timers_wf ${JOIN}`;
const FROM_ANY = `FROM thread_workflow w INDEXED BY reminders_wf ${JOIN}`;
// The pending reads name `timers_wf` (unfired reminders only, the smallest index). Migration 0004 added `reminders_wf`
// on the same column for every reminder, and without the hint the planner may pick either. The condition below is
// `timers_wf`'s own, so SQLite can use it.
const PENDING = 'w.reminder_at IS NOT NULL AND w.reminder_fired_at IS NULL';
const ORDER = 'ORDER BY w.reminder_at, w.thread_id';
const DUE = `SELECT ${COLUMNS} ${FROM_PENDING} WHERE ${PENDING} AND w.reminder_at <= ? ${ORDER} LIMIT ?`;
const NEXT =
  'SELECT min(reminder_at) AS at FROM thread_workflow INDEXED BY timers_wf WHERE reminder_at IS NOT NULL AND reminder_fired_at IS NULL';
// `Reminder/list` is two bounded reads: the upcoming ones (`timers_wf`) and the fired ones the owner has not acked,
// newest reminder first through `reminders_wf` (migration 0004; no sort, and the LIMIT stops the read early).
// `ack` needs the fired ones without a limit (it matches by id).
const UPCOMING = `SELECT ${COLUMNS} ${FROM_PENDING} WHERE ${PENDING} ${ORDER} LIMIT ?`;
const FIRED_WHERE = 'w.reminder_at IS NOT NULL AND w.reminder_fired_at IS NOT NULL';
const FIRED = `SELECT ${COLUMNS} ${FROM_ANY} WHERE ${FIRED_WHERE} ORDER BY w.reminder_at DESC, w.thread_id DESC LIMIT ?`;
const FIRED_ALL = `SELECT ${COLUMNS} ${FROM_ANY} WHERE ${FIRED_WHERE} ${ORDER}`;

/** A fire announces at most this many reminders; `next()` stays due while more are left, so the loop comes back. */
export const MAX_REMINDERS_PER_FIRE = 50;
/** `Reminder/list` returns at most this many upcoming and this many fired reminders. */
export const MAX_LISTED = 200;

/** For the plan test: the SQL whose query plan must use `timers_wf` (due, next, upcoming) or `reminders_wf` (fired). */
export const REMINDER_QUERIES = { due: DUE, next: NEXT, upcoming: UPCOMING, fired: FIRED } as const;

type SqlRow = Row & Record<string, string | number | null>;

const nextAt = (q: StoreReader) => q.get<{ at: number | null }>(NEXT)?.at ?? undefined;

const toItem = (row: Row): ReminderItem => ({
  threadId: threadIdOf(row),
  at: row.at,
  ...(row.firedAt === null ? {} : { firedAt: row.firedAt }),
  // The workflow row has no "only if nobody replied" column yet (an eng-store request): never stored, so false.
  ifNoReply: false,
  title: clampTitle(row.subject),
});

const workflowPatch = (row: Row, patch: WorkflowWrite['patch']): WorkflowWrite => ({
  kind: 'workflow',
  accountId: row.accountId,
  remoteThreadId: row.remoteId,
  patch,
});

/**
 * The `reminders` deadline source and the `Reminder/*` reads over `thread_workflow.reminder_at`. A fired reminder keeps
 * `reminder_at` and gains `reminder_fired_at`; `ack` drops `reminder_at`, the same two columns `Thread/act` writes.
 * Neither touches `edited_at`: Counts reads it as "handled today" and a firing is not triage.
 */
export function createReminders({ store, clock, frames, zone }: ReminderDeps): ReminderService {
  /** One commit per reminder, its opId naming the reminder: two engines racing replay instead of firing twice. */
  function fireOne(row: Row, now: number) {
    const opId = `reminder:fired:${threadIdOf(row)}:${row.at}:${row.editedAt ?? 0}`;
    const result = store.commit({
      opId,
      origin: 'system',
      writes: [workflowPatch(row, { reminderFiredAt: now })],
    });
    // Nothing changed when the thread was deleted after the read: there is no reminder left to announce.
    if (!result.replayed && result.changed > 0)
      announce(frames, noticeFor('reminder', row, now, zone()));
  }

  const source: DeadlineSource = {
    id: 'reminders',
    // The views lane calls `changed` after a reminder is set; the recheck is the fallback for a write that bypasses it.
    next: async () => Math.min(store.read(nextAt) ?? Infinity, clock.now() + RECHECK_MS),
    async fire(now) {
      const due = store.read(q => q.all<SqlRow>(DUE, now, MAX_REMINDERS_PER_FIRE));
      let failure: unknown;
      for (const row of due)
        try {
          fireOne(row, now);
        } catch (error) {
          // A thread deleted mid-fire must not keep the others waiting; the loop retries what is left.
          failure ??= error;
        }
      if (failure !== undefined) throw failure;
    },
  };

  return {
    source,
    list: () =>
      store
        .read(q => [...q.all<SqlRow>(UPCOMING, MAX_LISTED), ...q.all<SqlRow>(FIRED, MAX_LISTED)])
        .sort((a, b) => a.at - b.at)
        .map(toItem),
    ack(opId, threadIds) {
      const wanted = new Set(threadIds);
      const seen = store
        .read(q => q.all<SqlRow>(FIRED_ALL))
        .filter(row => wanted.has(threadIdOf(row)));
      const result = store.commit({
        opId,
        origin: 'local',
        writes: seen.map(row => workflowPatch(row, { reminderAt: null })),
      });
      return { dbEpoch: result.dbEpoch, seq: result.seq };
    },
  };
}
