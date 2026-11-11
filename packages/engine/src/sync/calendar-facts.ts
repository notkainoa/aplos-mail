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
 * `provider_memory['cal.sync']`: every calendar the last list saw — `[{id, primary?, sync?}]` with `sync:true`
 * on the selected-and-not-hidden ones. `CalendarAdapter.plan` emits `cal:<id>` steps for the syncable entries
 * (a `PlanInput` carries no store access and a `sync_state` row cannot be deleted to say "stop"), and the
 * adapter's resync path diffs the remembered ids against a full list to find the removed ones.
 */
export const CAL_SYNC_MEMORY_KEY = 'cal.sync';

/** One remembered calendar entry (`sync` marks the ones that get `cal:<id>` steps). */
export interface SyncSetEntry {
  id: string;
  primary?: boolean;
  sync?: boolean;
}

/** The remembered entries, or none — unknown/malformed is an empty set, never a crash. */
export function parseSyncSet(raw: string | undefined): SyncSetEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (c): c is SyncSetEntry =>
            typeof c === 'object' && c !== null && typeof (c as SyncSetEntry).id === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

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
  previous?: readonly SyncSetEntry[],
): StoreWrite[] {
  const writes: StoreWrite[] = [];
  // A delta list only touches the entries it names: merge into `previous` or an empty delta would
  // silently stop every `cal:<id>` step (and a resync's full list already folded removals into
  // `result.removed`).
  const set = new Map<string, SyncSetEntry>(
    (previous ?? []).map(e => [
      e.id,
      { id: e.id, ...(e.primary ? { primary: true } : {}), ...(e.sync ? { sync: true } : {}) },
    ]),
  );
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
    set.set(c.remoteId, {
      id: c.remoteId,
      ...(c.primary ? { primary: true } : {}),
      ...((c.selected || c.primary === true) && !c.hidden ? { sync: true } : {}),
    });
  }
  for (const remoteId of result.removed) {
    writes.push({ kind: 'calendarDelete', accountId: id, remoteId });
    // Its `cal:<id>` state goes with it: a re-added calendar resuming from the stale cursor would
    // silently miss every event before it.
    writes.push(
      syncStateWrite(id, {
        scope: `cal:${remoteId}` as const,
        generation: 0,
        updatedAt: result.nextState.updatedAt,
      }),
    );
    set.delete(remoteId);
  }
  writes.push(syncStateWrite(id, result.nextState), {
    kind: 'providerMemory',
    accountId: id,
    values: { [CAL_SYNC_MEMORY_KEY]: JSON.stringify([...set.values()]) },
  });
  return writes;
}

/**
 * The event rows and removals of one calendar's facts: a sync step's, or a confirmed write's (no `seenGen`, so the
 * resync sweep never counts a written row as seen in a round).
 */
export function eventFactWrites(
  accountId: AccountId,
  calendarRemoteId: string,
  facts: { upserts: readonly EventFacts[]; removals: readonly string[] },
  seenGen?: number,
): StoreWrite[] {
  const writes: StoreWrite[] = [];
  // One row per (remoteId, recurrenceId): the store refuses a repeat within a commit, so a provider
  // listing the same event twice (a page race) keeps the last copy instead of wedging the calendar.
  const byRemote = new Map<string, Map<string, EventRow>>();
  for (const f of facts.upserts) {
    const rows = byRemote.get(f.remoteId) ?? new Map<string, EventRow>();
    rows.set(f.recurrenceId ?? '', eventRow(f));
    byRemote.set(f.remoteId, rows);
  }
  for (const [remoteId, rows] of byRemote) {
    writes.push({
      kind: 'event',
      accountId,
      calendarRemoteId,
      remoteId,
      rows: [...rows.values()],
      ...(seenGen !== undefined ? { seenGen } : {}),
    });
  }
  for (const remoteId of facts.removals)
    writes.push({ kind: 'eventDelete', accountId, calendarRemoteId, remoteId });
  return writes;
}

/** Everything one `CalendarStepResult` writes, in one commit with its `nextState` (F3, ports.walk.md). */
export function calendarStepWrites(
  result: CalendarStepResult,
  ctx: CalendarWriteContext,
): StoreWrite[] {
  const id = ctx.account.id;
  const writes = eventFactWrites(id, ctx.calendarRemoteId, result, result.nextState.generation);
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
