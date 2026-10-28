import { sha256Hex } from '../../diag/sha256';
import type { DeadlineSource } from '../../ports/time';
import type { StorePort, StoreReader, WorkflowWrite } from '../../store/port';

/**
 * Host event for a reminder that came due. `firedAt - dueAt` is large when the engine was asleep, so the UI can say
 * "was due 9:00" (Decision 3, ARCH 7.5). The host-event channel is not built yet: the runtime injects `emit`.
 */
export interface ReminderEvent {
  kind: 'reminder';
  threadId: string;
  dueAt: number;
  firedAt: number;
}

export interface ReminderItem {
  threadId: string;
  at: number;
  firedAt?: number;
  ifNoReply: boolean;
  title: string;
}

export interface ReminderService {
  readonly source: DeadlineSource;
  /** Upcoming reminders and fired ones the user has not seen yet, soonest first. */
  list(): ReminderItem[];
  /** Marks fired reminders of these threads seen. Unfired reminders and unknown ids are left alone. */
  ack(opId: string, threadIds: readonly string[]): { dbEpoch: string; seq: number };
}

export interface ReminderDeps {
  store: StorePort;
  emit: (event: ReminderEvent) => void;
}

interface Row {
  accountId: string;
  remoteId: string;
  subject: string | null;
  at: number;
  firedAt: number | null;
}

const COLUMNS = `t.account_id AS accountId, t.remote_id AS remoteId, t.subject AS subject,
  w.reminder_at AS at, w.reminder_fired_at AS firedAt`;
const FROM = 'FROM thread_workflow w JOIN threads t ON t.id = w.thread_id';
// Spells out the partial index `timers_wf`'s own condition, so SQLite can use it.
const PENDING = 'w.reminder_at IS NOT NULL AND w.reminder_fired_at IS NULL';
const DUE = `SELECT ${COLUMNS} ${FROM} WHERE ${PENDING} AND w.reminder_at <= ? ORDER BY w.reminder_at, w.thread_id`;
const NEXT = `SELECT min(reminder_at) AS at FROM thread_workflow WHERE reminder_at IS NOT NULL AND reminder_fired_at IS NULL`;
const LISTED = `SELECT ${COLUMNS} ${FROM} WHERE w.reminder_at IS NOT NULL ORDER BY w.reminder_at, w.thread_id`;

/** The plan test's view of the SQL whose query plan must use `timers_wf`. */
export const REMINDER_QUERIES = { due: DUE, next: NEXT } as const;

/** A contract thread id: `accountId:remoteId` (ARCH 3.1). Built here, never parsed. */
const threadIdOf = (row: Pick<Row, 'accountId' | 'remoteId'>) => `${row.accountId}:${row.remoteId}`;

function nextAt(q: StoreReader): number | undefined {
  return q.get<{ at: number | null }>(NEXT)?.at ?? undefined;
}

const toItem = (row: Row): ReminderItem => ({
  threadId: threadIdOf(row),
  at: row.at,
  ...(row.firedAt === null ? {} : { firedAt: row.firedAt }),
  // The workflow row has no "only if nobody replied" column yet (eng-store request): never stored, so false.
  ifNoReply: false,
  title: row.subject || '(no subject)',
});

function workflowPatch(row: Row, patch: WorkflowWrite['patch']): WorkflowWrite {
  return { kind: 'workflow', accountId: row.accountId, remoteThreadId: row.remoteId, patch };
}

/**
 * The `reminders` deadline source and the `Reminder/*` reads over `thread_workflow.reminder_at`. `fire` marks every
 * due reminder fired in one `system` commit, then emits one host event each. The commit's opId names the due set and
 * `now`, so a repeat of the same fire (a crash, two engines) replays as a no-op and emits nothing.
 */
export function createReminders({ store, emit }: ReminderDeps): ReminderService {
  const source: DeadlineSource = {
    id: 'reminders',
    next: async () => store.read(nextAt),
    async fire(now) {
      const due = store.read(q => q.all<Row & Record<string, string | number | null>>(DUE, now));
      if (!due.length) return;
      const key = due.map(r => `${threadIdOf(r)}@${r.at}`).join('|');
      const result = store.commit({
        opId: `reminders:fire:${now}:${sha256Hex(key)}`,
        origin: 'system',
        writes: due.map(r => workflowPatch(r, { reminderFiredAt: now })),
      });
      if (result.replayed) return;
      for (const r of due) announce(r, now);
    },
  };

  function announce(row: Row, firedAt: number) {
    try {
      emit({ kind: 'reminder', threadId: threadIdOf(row), dueAt: row.at, firedAt });
    } catch {
      // One failing listener never keeps the rest from hearing; the fired reminder stays in `list()` until acked.
    }
  }

  return {
    source,
    list: () =>
      store.read(q => q.all<Row & Record<string, string | number | null>>(LISTED)).map(toItem),
    ack(opId, threadIds) {
      const wanted = new Set(threadIds);
      // "Seen" has no column: an acked reminder drops `reminder_at` and keeps `reminder_fired_at` (eng-store request).
      const seen = store
        .read(q => q.all<Row & Record<string, string | number | null>>(LISTED))
        .filter(r => r.firedAt !== null && wanted.has(threadIdOf(r)));
      const result = store.commit({
        opId,
        origin: 'local',
        writes: seen.map(r => workflowPatch(r, { reminderAt: null })),
      });
      return { dbEpoch: result.dbEpoch, seq: result.seq };
    },
  };
}
