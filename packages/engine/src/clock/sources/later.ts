import type { DeadlineSource } from '../../ports/time';
import type { FrameBus } from '../../runtime/frames';
import type { StorePort, StoreReader } from '../../store/port';
import { DAY_MS } from '../../calendar/recurrence/time';
import { fromWall, localDayAndHour } from '../zone';
import { announce, noticeFor, RECHECK_MS, threadIdOf, type DueThread } from './notice';

export interface LaterPreset {
  /** The ids the picker uses: `evening`, `tomorrow`, `weekend`, `nextWeek`, `someday`. */
  key: string;
  label: string;
  /** Absent for Someday: Later with no date. */
  until?: number;
}

export interface LaterService {
  readonly source: DeadlineSource;
  /** The Later choices resolved in the owner's zone at the engine clock's `now`. */
  presets(): { now: number; presets: LaterPreset[] };
  /** Launch: stores where announcing starts when it never has, so a Later that fell due while closed is announced late. */
  start(): void;
}

export interface LaterDeps {
  store: StorePort;
  clock: { now(): number };
  frames: Pick<FrameBus, 'emit'>;
  /** The owner's IANA zone, read per call so a change applies at once. */
  zone: () => string;
}

// ------------------------------------------------------------ presets

const HOUR_MS = 3_600_000;
const EVENING_HOUR = 18;
const EVENING_CUTOFF_HOUR = 17;
const MORNING_HOUR = 8;
const SATURDAY = 6;
const DEFAULT_WEEK_START = 1;

/**
 * Today evening (18:00, only before 17:00), Tomorrow (8:00), This weekend (Saturday 8:00, offered Monday to Thursday),
 * Next week (the owner's first weekday, 8:00, never today) and Someday without a date. These are the rules the picker
 * mirrors (`renderer/screens/later/laterPresets.ts`). Wall times are resolved in `zone`, so they stay right across a
 * DST change; `weekStart` is 0 (Sunday) to 6, from `ui.calendar.weekStart`.
 */
export function resolvePresets(
  now: number,
  zone: string,
  weekStart = DEFAULT_WEEK_START,
): LaterPreset[] {
  const { day, weekday, hour } = localDayAndHour(now, zone);
  const at = (ahead: number, atHour: number) =>
    fromWall((day + ahead) * DAY_MS + atHour * HOUR_MS, zone);
  const presets: LaterPreset[] = [];
  if (hour < EVENING_CUTOFF_HOUR)
    presets.push({ key: 'evening', label: 'Today evening', until: at(0, EVENING_HOUR) });
  presets.push({ key: 'tomorrow', label: 'Tomorrow', until: at(1, MORNING_HOUR) });
  if (weekday >= 1 && weekday <= 4)
    presets.push({
      key: 'weekend',
      label: 'This weekend',
      until: at(SATURDAY - weekday, MORNING_HOUR),
    });
  const untilWeekStart = (weekStart - weekday + 7) % 7 || 7;
  presets.push({ key: 'nextWeek', label: 'Next week', until: at(untilWeekStart, MORNING_HOUR) });
  presets.push({ key: 'someday', label: 'Someday' });
  return presets;
}

/** `ui.calendar.weekStart` from the settings document (0 to 6), else Monday. Read like the views lane reads `mail.*`. */
function weekStartOf(q: StoreReader): number {
  const row = q.get<{ day: number | null }>(
    "SELECT json_extract(data, '$.ui.calendar.weekStart') AS day FROM settings WHERE id = 1",
  );
  const day = row?.day;
  return typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6
    ? day
    : DEFAULT_WEEK_START;
}

// ------------------------------------------------------------ the source

/** `meta` key: Later dates up to here (epoch ms) have been announced. */
const FIRED_THROUGH = 'later.fired_through';
/** At most this many Later returns are announced per fire; the rest are still in Home. */
export const MAX_LATER_NOTICES = 20;

const COLUMNS =
  't.account_id AS accountId, t.remote_id AS remoteId, t.subject AS subject, w.later_until AS at';
// Spells out the partial index `wf_later`'s own condition (`status = 'later'`), so SQLite can use it.
const DUE = `SELECT ${COLUMNS} FROM thread_workflow w INDEXED BY wf_later JOIN threads t ON t.id = w.thread_id
  WHERE w.status = 'later' AND w.later_until > ? AND w.later_until <= ? ORDER BY w.later_until, w.thread_id LIMIT ?`;
const NEXT = `SELECT min(later_until) AS at FROM thread_workflow INDEXED BY wf_later WHERE status = 'later' AND later_until > ?`;

/** For the plan test: the SQL whose query plan must use `wf_later`. */
export const LATER_QUERIES = { due: DUE, next: NEXT } as const;

type Row = DueThread & Record<string, string | number | null>;

const firedThrough = (q: StoreReader) =>
  q.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', FIRED_THROUGH)?.value;

/**
 * The `later` deadline source over `thread_workflow.later_until` where `status = 'later'`. A Later thread whose date
 * has come stays `later`: Home shows it as back from Later by comparing `later_until` with the clock (views), so the
 * source changes no thread. It announces each return once, as a `reminder` host event (`kind: 'later'`), and moves a
 * watermark (`meta` key `later.fired_through`) past it. One empty commit per thread, its opId naming the return,
 * stops two engines racing from announcing twice.
 */
export function createLater({ store, clock, frames, zone }: LaterDeps): LaterService {
  /** Where the watermark starts when none is stored yet: the engine's first look, so old dates stay quiet. */
  const startedAt = clock.now();
  /** A stored watermark past `now` came from a clock that was ahead: it must not silence what is due, so this run's start stands in. */
  const through = (q: StoreReader, now: number) => {
    const stored = Number(firedThrough(q));
    const base = Number.isFinite(stored) && stored <= now ? stored : startedAt;
    // Idle fires move the watermark here only; it is committed when something was announced or it is a day old.
    return seenThrough !== undefined && seenThrough <= now ? Math.max(base, seenThrough) : base;
  };
  /** Where the last fire looked up to: kept in memory so an idle minute costs no commit row (the `commits` table is never pruned). */
  let seenThrough: number | undefined;

  /** True when the stored watermark must be written: absent, from a clock that was ahead, or more than a day behind. */
  const staleWatermark = (now: number) => {
    const raw = store.read(firedThrough);
    const stored = Number(raw);
    return raw === undefined || !Number.isFinite(stored) || stored > now || now - stored > DAY_MS;
  };

  function announceReturn(row: Row, now: number) {
    const result = store.commit({
      opId: `later:returned:${threadIdOf(row)}:${row.at}`,
      origin: 'system',
      writes: [],
    });
    if (!result.replayed) announce(frames, noticeFor('later', row, now, zone()));
  }

  const source: DeadlineSource = {
    id: 'later',
    // The views lane calls `changed` after a Later is set; the recheck is the fallback for a write that bypasses it.
    next: async () =>
      Math.min(
        store.read(q => q.get<{ at: number | null }>(NEXT, through(q, clock.now()))?.at) ??
          Infinity,
        clock.now() + RECHECK_MS,
      ),
    async fire(now) {
      const due = store.read(q => q.all<Row>(DUE, through(q, now), now, MAX_LATER_NOTICES));
      for (const row of due) announceReturn(row, now);
      // Nothing due and a fresh watermark: nothing to protect, and no row for the table that keeps every opId.
      if (due.length === 0 && !staleWatermark(now)) {
        seenThrough = now;
        return;
      }
      // After the announcements: a throw above leaves the watermark, and the retry replays what was announced.
      // It may move back with the clock: the per-thread opIds keep a return from being announced twice.
      store.commit({
        opId: `later:through:${now}`,
        origin: 'system',
        writes: [{ kind: 'meta', key: FIRED_THROUGH, value: String(now) }],
      });
      seenThrough = now;
    },
  };

  return {
    source,
    start() {
      if (store.read(firedThrough) !== undefined) return;
      store.commit({
        opId: `later:begin:${startedAt}`,
        origin: 'system',
        writes: [{ kind: 'meta', key: FIRED_THROUGH, value: String(startedAt) }],
      });
    },
    presets() {
      const now = clock.now();
      const weekStart = store.read(weekStartOf);
      return { now, presets: resolvePresets(now, zone(), weekStart) };
    },
  };
}
