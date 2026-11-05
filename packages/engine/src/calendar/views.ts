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
import { expand, type Override } from './recurrence';
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
  FROM events e JOIN calendars c ON c.id = e.calendar_id
  WHERE c.hidden = 0`;

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
  const rows = q.all<Joined>(SELECT);
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
      if (start < spec.to && end > spec.from) out.push({ id: base.id, event: base, at: start });
      continue;
    }
    const oRows: Override[] = overrides.map(o => {
      const og = eventFromRow(cal, toEvt(o), hidden);
      return {
        recurrenceId: o.recurrence_id,
        ...(o.status === 'cancelled' ? { cancelled: true } : { start: og.start, end: og.end }),
      };
    });
    const rec = resource.recurrence
      ? (JSON.parse(resource.recurrence) as Record<string, unknown>)
      : {};
    const expanded = expand({
      start: fromWire(base.start),
      end: fromWire(base.end),
      allDay: base.allDay,
      ...(base.timeZone ? { tzid: base.timeZone } : {}),
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
  const load = (q: StoreReader) => materialize(q, s, env);
  return {
    kind: 'events',
    rowType: 'Event',
    layout: (q): ViewLayout => ({ total: load(q).length, sections: [] }),
    rows: (q, after, limit): ViewRow[] => {
      const list = load(q);
      const startAt = after
        ? list.findIndex(
            r =>
              r.at > (after.key[0] as number) ||
              (r.at === after.key[0] && r.id > String(after.key[1])),
          )
        : 0;
      return list.slice(Math.max(0, startAt), Math.max(0, startAt) + limit).map(r => ({
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
      { sql: SELECT, params: [] },
      { sql: 'SELECT calendar_id, remote_id, recurrence_id FROM event_hidden', params: [] },
    ],
  };
};

export const plansPlan: ViewCompiler = (): ViewPlan => ({
  kind: 'plans',
  rowType: 'Plan',
  layout: () => ({ total: 0, sections: [] }),
  rows: () => [],
  locate: () => undefined,
  statements: () => [],
});
