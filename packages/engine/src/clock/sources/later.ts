import { sha256Hex } from '../../diag/sha256';
import type { Clock, DeadlineSource } from '../../ports/time';
import type { StorePort, StoreReader, WorkflowWrite } from '../../store/port';
import { localTime, usableZone, zonedEpoch } from '../zone';

/** Host event for a thread that came back from Later; `firedAt - dueAt` large means "was due 9:00" (ARCH 7.5). */
export interface LaterEvent {
  kind: 'later';
  threadId: string;
  dueAt: number;
  firedAt: number;
}

export interface LaterPreset {
  key: string;
  label: string;
  /** Absent for Someday: Later with no date. */
  until?: number;
}

export interface LaterService {
  readonly source: DeadlineSource;
  /** The Later choices resolved in the configured zone at the engine clock's `now`. */
  presets(): { now: number; presets: LaterPreset[] };
}

export interface LaterDeps {
  store: StorePort;
  clock: Clock;
  /** The configured IANA zone (settings are eng-contract's); read on every call so a change applies at once. */
  timeZone?: () => string | undefined;
  /** Optional: told about each returned thread. */
  emit?: (event: LaterEvent) => void;
}

interface Row {
  accountId: string;
  remoteId: string;
  at: number;
}

const COLUMNS = 't.account_id AS accountId, t.remote_id AS remoteId, w.later_until AS at';
// Spells out the partial index `wf_later`'s own condition (`status = 'later'`), so SQLite can use it.
const DUE = `SELECT ${COLUMNS} FROM thread_workflow w INDEXED BY wf_later JOIN threads t ON t.id = w.thread_id
  WHERE w.status = 'later' AND w.later_until <= ? ORDER BY w.later_until, w.thread_id`;
const NEXT = `SELECT min(later_until) AS at FROM thread_workflow INDEXED BY wf_later WHERE status = 'later'`;

/** The plan test's view of the SQL whose query plan must use `wf_later`. */
export const LATER_QUERIES = { due: DUE, next: NEXT } as const;

const nextAt = (q: StoreReader) => q.get<{ at: number | null }>(NEXT)?.at ?? undefined;

// ------------------------------------------------------------ presets

const EVENING_HOUR = 18;
const EVENING_CUTOFF_HOUR = 17;
const MORNING_HOUR = 9;
const SATURDAY = 6;
const MONDAY = 1;

/**
 * Today evening (18:00, only while it is before 17:00), Tomorrow and Next week (Monday), This weekend (Saturday)
 * all at 09:00 local, and Someday without a date. This weekend is left out on Saturday after 09:00 and on Sunday,
 * when it is already here. Wall times are resolved in `zone`, so they stay right across a DST change.
 */
export function resolvePresets(now: number, zone: string): LaterPreset[] {
  const local = localTime(now, zone);
  const at = (daysAhead: number, hour: number) =>
    zonedEpoch(zone, local.year, local.month, local.day + daysAhead, hour);
  const presets: LaterPreset[] = [];
  if (local.hour < EVENING_CUTOFF_HOUR)
    presets.push({ key: 'today-evening', label: 'Today evening', until: at(0, EVENING_HOUR) });
  presets.push({ key: 'tomorrow', label: 'Tomorrow', until: at(1, MORNING_HOUR) });
  const toSaturday = (SATURDAY - local.weekday + 7) % 7;
  const weekend = at(toSaturday, MORNING_HOUR);
  if (weekend > now && local.weekday !== 0)
    presets.push({ key: 'weekend', label: 'This weekend', until: weekend });
  const toMonday = (MONDAY - local.weekday + 7) % 7 || 7;
  presets.push({ key: 'next-week', label: 'Next week', until: at(toMonday, MORNING_HOUR) });
  presets.push({ key: 'someday', label: 'Someday' });
  return presets;
}

// ------------------------------------------------------------ the source

const threadIdOf = (row: Row) => `${row.accountId}:${row.remoteId}`;

/** A thread back in Home: new again, no Later date, visible. Later has no stored "before" status; Home is `new`. */
const returnPatch = (row: Row): WorkflowWrite => ({
  kind: 'workflow',
  accountId: row.accountId,
  remoteThreadId: row.remoteId,
  patch: { status: 'new', laterUntil: null, hiddenFromHome: false },
});

/**
 * The `later` deadline source over `thread_workflow.later_until` where `status = 'later'`. `fire` returns every due
 * thread to Home in one `system` commit. A returned thread is no longer `later`, so a repeat fire (a crash) finds
 * nothing, and the opId names the due set and `now` so two engines racing replay instead of repeating.
 */
export function createLater({ store, clock, timeZone, emit }: LaterDeps): LaterService {
  const source: DeadlineSource = {
    id: 'later',
    next: async () => store.read(nextAt),
    async fire(now) {
      const due = store.read(q => q.all<Row & Record<string, string | number>>(DUE, now));
      if (!due.length) return;
      const key = due.map(r => `${threadIdOf(r)}@${r.at}`).join('|');
      const result = store.commit({
        opId: `later:fire:${now}:${sha256Hex(key)}`,
        origin: 'system',
        writes: due.map(returnPatch),
      });
      if (result.replayed || !emit) return;
      for (const r of due) announce(emit, r, now);
    },
  };

  return {
    source,
    presets() {
      const now = clock.now();
      return { now, presets: resolvePresets(now, usableZone(timeZone?.())) };
    },
  };
}

function announce(emit: (event: LaterEvent) => void, row: Row, firedAt: number) {
  try {
    emit({ kind: 'later', threadId: threadIdOf(row), dueAt: row.at, firedAt });
  } catch {
    // One failing listener never keeps the rest from hearing.
  }
}
