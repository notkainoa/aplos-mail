import { ContractError } from '@aplos/contract/contract-error';
import type { StoreReader } from '../store/port';
import type {
  Statement,
  ViewCompiler,
  ViewEnv,
  ViewLayout,
  ViewPlan,
  ViewRow,
} from '../views/specs';
import { expand } from './recurrence/expand';
import { isKnownZone } from './recurrence/zone';
import type { Override } from './recurrence/types';
import { registerViewKind } from '../views/registry';
import {
  eventFromRow,
  fromWire,
  instant,
  occurrenceEvent,
  recurrenceIdToTime,
  toWire,
  type CalRow,
  type EvtRow,
} from './project';

/**
 * The `events` and `plans` view kinds (prov-cal): the calendar grid's windows. `events` materializes the stored
 * masters, overrides and singles of the shown calendars, expands masters on query (ADR-20) and filters hidden and
 * declined rows. `plans` is an empty window until plan storage lands — the screen reads it for the dashed outlines.
 */

const MAX_RANGE_MS = 62 * 86_400_000;

const SELECT = `
  SELECT c.id AS cal_id, c.account_id, c.remote_id AS cal_remote, c.name, c.color, c.is_primary,
         c.hidden AS cal_hidden, c.read_only, c.selected, c.time_zone,
         e.remote_id, e.recurrence_id, e.master_remote_id, e.status, e.recurrence,
         e.start_utc, e.end_utc, e.all_day, e.data
  FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
  WHERE c.hidden = 0 AND a.status <> 'removing'
    AND (e.recurrence_id != '' OR e.recurrence IS NOT NULL
      OR e.start_utc IS NULL OR e.end_utc IS NULL
      OR (e.start_utc < ? + 172800000 AND e.end_utc >= ? - 172800000))`;

interface Joined {
  [k: string]: string | number | null;
  cal_id: number;
  account_id: string;
  cal_remote: string;
  name: string | null;
  color: string | null;
  is_primary: number | null;
  cal_hidden: number | null;
  read_only: number | null;
  selected: number;
  time_zone: string | null;
  remote_id: string;
  recurrence_id: string;
  master_remote_id: string | null;
  status: string;
  recurrence: string | null;
  start_utc: number | null;
  end_utc: number | null;
  all_day: number | null;
  data: string;
}

const toCal = (r: Joined): CalRow => ({
  id: r.cal_id,
  account_id: r.account_id,
  remote_id: r.cal_remote,
  name: r.name,
  color: r.color,
  is_primary: r.is_primary,
  hidden: r.cal_hidden,
  read_only: r.read_only,
  selected: r.selected,
  time_zone: r.time_zone,
  // Not joined (unused here): Calendar/set's passthrough reads it in methods/event.ts.
  change_tag: null,
});

// `EvtRow.id` is the events-table PK — unused in projection; the join column `cal_id` feeds grouping.
const toEvt = (r: Joined): EvtRow => ({
  id: r.cal_id,
  calendar_id: r.cal_id,
  remote_id: r.remote_id,
  recurrence_id: r.recurrence_id,
  master_remote_id: r.master_remote_id,
  status: r.status,
  recurrence: r.recurrence,
  start_utc: r.start_utc,
  end_utc: r.end_utc,
  all_day: r.all_day,
  data: r.data,
});

function hiddenSet(q: StoreReader): Set<string> {
  const set = new Set<string>();
  for (const r of q.all<{ calendar_id: number; remote_id: string; recurrence_id: string }>(
    'SELECT calendar_id, remote_id, recurrence_id FROM event_hidden',
  ))
    set.add(`${r.calendar_id}|${r.remote_id}|${r.recurrence_id}`);
  return set;
}

interface Materialized {
  id: string;
  event: ReturnType<typeof eventFromRow>;
  at: number;
}

interface EventsSpec {
  kind: 'events';
  from: number;
  to: number;
  calendarIds?: string[];
  includeDeclined?: boolean;
  includeHidden?: boolean;
}

function rangeCheck(from: number, to: number) {
  if (to < from || to - from > MAX_RANGE_MS)
    throw new ContractError({
      type: 'rangeTooLarge',
      message: 'Choose a range of at most 62 days.',
    });
}

function materialize(q: StoreReader, spec: EventsSpec, env: ViewEnv): Materialized[] {
  const rows = q.all<Joined>(SELECT, spec.to, spec.from);
  const hidden = hiddenSet(q);
  // The pair, not just remote_id: `primary` (and the owner's email) repeat across accounts.
  const wanted = spec.calendarIds ? new Set(spec.calendarIds) : undefined;
  const out: Materialized[] = [];
  // Overrides travel with their master (grouped per calendar+remote).
  const groups = new Map<string, { master?: Joined; single?: Joined; overrides: Joined[] }>();
  for (const r of rows) {
    if (wanted ? !wanted.has(`${r.account_id}:${r.cal_remote}`) : r.selected !== 1) continue;
    const key = `${r.cal_id}|${r.master_remote_id ?? r.remote_id}`;
    const g = groups.get(key) ?? { overrides: [] };
    if (r.recurrence_id === '') {
      if (r.recurrence) g.master = r;
      else g.single = r;
    } else g.overrides.push(r);
    groups.set(key, g);
  }
  for (const { master, single, overrides } of groups.values()) {
    // An override can arrive before its master (F3): a group of only override rows stays out until the master syncs.
    const resource = master ?? single;
    if (!resource) continue;
    const cal = toCal(resource);
    const evt = toEvt(resource);
    const base = eventFromRow(cal, evt, hidden);
    const resourceHidden = hidden.has(`${resource.cal_id}|${resource.remote_id}|`);
    if (!master) {
      // A single event: overlap by its own times.
      const start = instant(base.start, env.zone);
      const end = instant(base.end, env.zone);
      // Half-open window: only a zero-length event at exactly `from` counts as inside; an event
      // ending at `from` (incl. exclusive all-day ends) belongs to the window before.
      if (start < spec.to && (end > spec.from || (end === start && start >= spec.from)))
        out.push({ id: base.id, event: base, at: start });
      continue;
    }
    const oRows: Override[] = overrides.map(o => {
      const og = eventFromRow(cal, toEvt(o), hidden);
      return {
        recurrenceId: o.recurrence_id,
        ...(o.status === 'cancelled'
          ? { cancelled: true }
          : { start: fromWire(og.start), end: fromWire(og.end) }),
      };
    });
    const rec = resource.recurrence
      ? (JSON.parse(resource.recurrence) as Record<string, unknown>)
      : {};
    const expanded = expand({
      start: fromWire(base.start),
      end: fromWire(base.end),
      allDay: base.allDay,
      ...(base.timeZone && isKnownZone(base.timeZone) ? { tzid: base.timeZone } : {}),
      rrule: rec.rrule as string[] | undefined,
      rdate: rec.rdate as string[] | undefined,
      exdate: rec.exdate as string[] | undefined,
      overrides: oRows,
      range: { from: spec.from, to: spec.to },
      floatingZone: env.zone,
    });
    const overridden = new Map(overrides.map(o => [o.recurrence_id, o]));
    for (const occ of expanded.occurrences) {
      const oRow = occ.overridden ? overridden.get(occ.recurrenceId) : undefined;
      const occHidden =
        resourceHidden ||
        hidden.has(`${resource.cal_id}|${resource.remote_id}|${occ.recurrenceId}`);
      const event = oRow
        ? {
            ...eventFromRow(cal, toEvt(oRow), hidden),
            id: `${base.id}@${occ.recurrenceId}`,
            seriesId: base.id,
            originalStart: recurrenceIdToTime(occ.recurrenceId),
          }
        : occurrenceEvent(base, occ, false, occHidden);
      out.push({ id: event.id, event, at: instant(toWire(occ.start), env.zone) });
    }
  }
  const filtered = out.filter(({ event }) => {
    if (event.status === 'cancelled') return false;
    if (!spec.includeDeclined && event.myResponse === 'declined') return false;
    if (!spec.includeHidden && event.hidden) return false;
    return true;
  });
  filtered.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  return filtered;
}

export const eventsPlan: ViewCompiler = (spec, env): ViewPlan => {
  const s = spec as EventsSpec;
  rangeCheck(s.from, s.to);
  const memo = new WeakMap<StoreReader, Materialized[]>();
  const load = (q: StoreReader) => {
    let m = memo.get(q);
    if (!m) {
      m = materialize(q, s, env);
      memo.set(q, m);
    }
    return m;
  };
  return {
    kind: 'events',
    rowType: 'Event',
    layout: (q): ViewLayout => ({ total: load(q).length, sections: [] }),
    rows: (q, after, limit): ViewRow[] => {
      const list = load(q);
      const found = after
        ? list.findIndex(
            r =>
              r.at > (after.key[0] as number) ||
              (r.at === after.key[0] && r.id > String(after.key[1])),
          )
        : 0;
      // -1 means the cursor is past the end — serve [], never page 1 again.
      const startAt = found < 0 ? (after ? list.length : 0) : found;
      return list.slice(startAt, startAt + limit).map(r => ({
        id: r.id,
        at: { part: 0, key: [r.at, r.id] },
      }));
    },
    locate: (q, id) => {
      const index = load(q).findIndex(r => r.id === id);
      if (index < 0) return undefined;
      const r = load(q)[index]!;
      return { index, at: { part: 0, key: [r.at, r.id] } };
    },
    statements: (_q): Statement[] => [
      { sql: SELECT, params: [s.to, s.from] },
      { sql: 'SELECT calendar_id, remote_id, recurrence_id FROM event_hidden', params: [] },
    ],
  };
};

interface PlanWindowRow {
  [k: string]: string | number | null;
  id: number;
  account_id: string;
  remote_id: string;
  start_utc: number | null;
  start_date: string | null;
  end_utc: number | null;
  end_date: string | null;
  all_day: number;
}

/**
 * The `plans` window (prov-cal): open proposals from the `plans` table, oldest start first, optionally a
 * thread and always an overlap of `[from, to)` when the grid asks for a range. Same keyset paging shape as
 * `eventsPlan`; a `Plan` change row re-renders through `statements`.
 */
export const plansPlan: ViewCompiler = (spec, env): ViewPlan => {
  const s = spec as { kind: 'plans'; threadId?: string; from?: number; to?: number };
  const startMs = (r: PlanWindowRow): number =>
    r.all_day ? instant({ type: 'date', date: r.start_date! }, env.zone) : r.start_utc!;
  const endMs = (r: PlanWindowRow): number => {
    const end = r.all_day ? instant({ type: 'date', date: r.end_date! }, env.zone) : r.end_utc!;
    const start = startMs(r);
    // A zero-length all-day plan still covers its day for the grid's overlap test.
    return end <= start ? start + 86_400_000 : end;
  };
  const load = (q: StoreReader) => {
    const rows = q
      .all<PlanWindowRow>(
        `SELECT p.id, p.account_id, t.remote_id, p.start_utc, p.start_date, p.end_utc, p.end_date,
                p.all_day
         FROM plans p JOIN threads t ON t.id = p.thread_id WHERE p.state = 'open' ORDER BY p.id`,
      )
      .map(r => ({
        id: `${r.account_id}:plan-${r.id}`,
        at: startMs(r),
        end: endMs(r),
        threadId: `${r.account_id}:${r.remote_id}`,
      }))
      .filter(
        r =>
          (!s.threadId || r.threadId === s.threadId) &&
          (s.from === undefined || r.end > s.from) &&
          (s.to === undefined || r.at < s.to),
      );
    rows.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    return rows;
  };
  const memo = new WeakMap<StoreReader, ReturnType<typeof load>>();
  const list = (q: StoreReader) => {
    let m = memo.get(q);
    if (!m) {
      m = load(q);
      memo.set(q, m);
    }
    return m;
  };
  return {
    kind: 'plans',
    rowType: 'Plan',
    layout: (q): ViewLayout => ({ total: list(q).length, sections: [] }),
    rows: (q, after, limit): ViewRow[] => {
      const l = list(q);
      const found = after
        ? l.findIndex(
            r =>
              r.at > (after.key[0] as number) ||
              (r.at === after.key[0] && r.id > String(after.key[1])),
          )
        : 0;
      const startAt = found < 0 ? (after ? l.length : 0) : found;
      return l.slice(startAt, startAt + limit).map(r => ({
        id: r.id,
        at: { part: 0, key: [r.at, r.id] },
      }));
    },
    locate: (q, id) => {
      const index = list(q).findIndex(r => r.id === id);
      if (index < 0) return undefined;
      const r = list(q)[index]!;
      return { index, at: { part: 0, key: [r.at, r.id] } };
    },
    statements: (_q): Statement[] => [
      {
        sql: 'SELECT id, account_id, thread_id, start_utc, start_date, end_utc, end_date, all_day, state FROM plans',
        params: [],
      },
    ],
  };
};

// Self-register at this module's import time — the lazy chunk runs this once (import caching), so
// registerViewKind's double-registration guard is still honored.
registerViewKind('events', eventsPlan);
registerViewKind('plans', plansPlan);
