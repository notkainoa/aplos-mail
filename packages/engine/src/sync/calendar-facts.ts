import type {
  AdapterAccount,
  AccountId,
  CalendarFacts,
  CalendarStepResult,
  EventFacts,
  EventTime,
  StoreWrite,
} from '../ports';
import { fromWall, isKnownZone } from '../calendar/recurrence/zone';
import type { EventRow } from '../store/port';
import { quarantineDelay, syncStateWrite } from './facts';

// Calendar facts to store writes (the `calendars` list and `cal:<id>` steps), one commit per step like `stepWrites`.
// `EventFacts.raw` lands in `events.data` verbatim; `start_utc`/`end_utc` exist only for the SQL window filter.

/**
 * `provider_memory['cal.sync']`: the remote ids (and `primary` flag) of the calendars the last list said to sync —
 * selected and not hidden. `CalendarAdapter.plan` reads it to emit `cal:<id>` steps, since `PlanInput` carries no
 * store access and a `sync_state` row cannot be deleted to say "stop".
 */
export const CAL_SYNC_MEMORY_KEY = 'cal.sync';

export interface CalendarWriteContext {
  account: AdapterAccount;
  /** The step's calendar (`cal:<id>` minus the prefix); deletions name no calendar on their facts. */
  calendarRemoteId: string;
  now: number;
  /** `sync_failures.attempts` so far, by item (same rule as `stepWrites`). */
  failures: ReadonlyMap<string, number>;
}

/** An `EventTime` as epoch ms for the `start_utc`/`end_utc` range columns; floating resolves against its zone. */
function epochOf(t: EventTime): number {
  if (t.type === 'utc') return t.utc;
  if (t.type === 'date') {
    const [y = 1970, m = 1, d = 1] = t.date.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }
  const wall = Date.parse(`${t.local}Z`);
  const tz = t.timeZone;
  return tz !== undefined && isKnownZone(tz) ? fromWall(wall, tz) : wall;
}

/** One `EventFacts` as its `EventRow`; Google gives one row per `remoteId` (masters and overrides alike). */
function eventRow(f: EventFacts): EventRow {
  return {
    ...(f.recurrenceId ? { recurrenceId: f.recurrenceId } : {}),
    ...(f.masterRemoteId ? { masterRemoteId: f.masterRemoteId } : {}),
    status: f.status,
    ...(f.etag ? { etag: f.etag } : {}),
    ...(f.rrule || f.rdate || f.exdate
      ? {
          recurrence: {
            ...(f.rrule ? { rrule: f.rrule } : {}),
            ...(f.rdate ? { rdate: f.rdate } : {}),
            ...(f.exdate ? { exdate: f.exdate } : {}),
          },
        }
      : {}),
    startUtc: epochOf(f.start),
    endUtc: epochOf(f.end),
    allDay: f.allDay,
    data: f.raw,
  };
}

/** The `calendars` list's writes: calendar rows, removals, the list's resume token and the sync set. */
export function calendarListWrites(
  id: AccountId,
  result: {
    calendars: CalendarFacts[];
    removed: string[];
    nextState: Parameters<typeof syncStateWrite>[1];
  },
): StoreWrite[] {
  const writes: StoreWrite[] = [];
  const sync: { id: string; primary?: true }[] = [];
  for (const c of result.calendars) {
    writes.push({
      kind: 'calendar',
      accountId: id,
      remoteId: c.remoteId,
      name: c.name,
      ...(c.color !== undefined ? { color: c.color } : {}),
      ...(c.primary !== undefined ? { primary: c.primary } : {}),
      hidden: c.hidden,
      selected: c.selected,
      readOnly: c.readOnly,
      ...(c.timeZone !== undefined ? { timeZone: c.timeZone } : {}),
      ...(c.changeTag !== undefined ? { changeTag: c.changeTag } : {}),
    });
    if (c.selected && !c.hidden)
      sync.push({ id: c.remoteId, ...(c.primary ? { primary: true } : {}) });
  }
  for (const remoteId of result.removed) {
    writes.push({ kind: 'calendarDelete', accountId: id, remoteId });
  }
  writes.push(syncStateWrite(id, result.nextState), {
    kind: 'providerMemory',
    accountId: id,
    values: { [CAL_SYNC_MEMORY_KEY]: JSON.stringify(sync) },
  });
  return writes;
}

/** Everything one `CalendarStepResult` writes, in one commit with its `nextState` (F3, ports.walk.md). */
export function calendarStepWrites(
  result: CalendarStepResult,
  ctx: CalendarWriteContext,
): StoreWrite[] {
  const id = ctx.account.id;
  const writes: StoreWrite[] = [];
  const byRemote = new Map<string, EventRow[]>();
  for (const f of result.upserts) {
    const rows = byRemote.get(f.remoteId) ?? [];
    rows.push(eventRow(f));
    byRemote.set(f.remoteId, rows);
  }
  for (const [remoteId, rows] of byRemote) {
    writes.push({
      kind: 'event',
      accountId: id,
      calendarRemoteId: ctx.calendarRemoteId,
      remoteId,
      rows,
      seenGen: result.nextState.generation,
    });
  }
  for (const remoteId of result.removals) {
    writes.push({
      kind: 'eventDelete',
      accountId: id,
      calendarRemoteId: ctx.calendarRemoteId,
      remoteId,
    });
  }
  if (result.scopeCovered && result.done) {
    writes.push({
      kind: 'eventSweep',
      accountId: id,
      calendarRemoteId: result.scopeCovered.scope.slice(4),
      generation: result.scopeCovered.generation,
      ...(result.scopeCovered.bound?.from !== undefined
        ? { from: result.scopeCovered.bound.from }
        : {}),
      ...(result.scopeCovered.bound?.to !== undefined ? { to: result.scopeCovered.bound.to } : {}),
    });
  }
  writes.push(syncStateWrite(id, result.nextState));
  for (const q of result.quarantine ?? []) {
    const attempts = (ctx.failures.get(q.item) ?? 0) + 1;
    writes.push({
      kind: 'syncFailure',
      accountId: id,
      item: q.item,
      failure: {
        attempts,
        nextRetryAt: ctx.now + quarantineDelay(attempts),
        lastReason: q.error.reason,
      },
    });
  }
  return writes;
}
