import type { Event, Input, Output, Plan, Receipt } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { auditWrites } from '../host/audit';
import {
  calendarFromRow,
  eventFromRow,
  fromWire,
  occurrenceEvent,
  parseCalendarIdIn,
  parseEventIdIn,
  recurrenceIdToTime,
  instant,
  type CalRow,
  type EvtRow,
} from '../calendar/project';
import type { EventFields } from '@aplos/contract';
import type { EventFields as PortFields } from '../ports/calendar';
import { nonce, notImplemented, type AreaHandlers, type MethodContext } from './types';

/** The recurrence expander lives in the calendar chunk (the bundle budget's seam): `Event/get` loads it only
 * for an occurrence id that has no stored override row, and a missing chunk answers `unavailable`, not a throw. */
async function lazyExpand(): Promise<typeof import('../calendar/recurrence/expand').expand> {
  try {
    return (await import('../calendar/recurrence/expand')).expand;
  } catch {
    throw new ContractError({
      type: 'unavailable',
      message: 'This part of the calendar cannot load right now.',
    });
  }
}

/**
 * The `event` area, owned by lane `prov-cal`. Reads come from `calendars`, `events` and `event_hidden`; writes to the
 * provider go through `services.calendar` (CalendarPort), which routes to the account adapter and commits the `saved`
 * facts itself — a stand-in port answers `unavailable` until prov-gov wires it. `Event/hide` is Aplos-only and commits
 * locally. `Plan/*` stays unimplemented until plan storage lands; `Event/extract` needs the AI lane.
 */

const stateOf = (ctx: MethodContext) => ({
  dbEpoch: ctx.services.store.dbEpoch,
  seq: ctx.services.store.seq(),
});

const receipt = (ctx: MethodContext, opId: string): Receipt => ({
  opId,
  appliedState: stateOf(ctx),
  undoable: false,
});

const notFoundCal = () =>
  new ContractError({ type: 'notFound', message: 'This calendar is no longer available.' });

const notFoundEvent = () =>
  new ContractError({ type: 'notFound', message: 'This event is no longer available.' });

/** The calendar a write targets: it must exist for the named account and accept changes. */
function writableCalendar(ctx: MethodContext, accountId: string, calRemote: string): CalRow {
  const row = calRow(ctx, accountId, calRemote);
  if (!row) throw notFoundCal();
  if (row.read_only === 1)
    throw new ContractError({
      type: 'unsupported',
      message: 'This calendar is read-only, so events on it cannot be changed.',
      reasonCode: 'calendar.readOnly',
    });
  return row;
}

/** The synced version of the event a write is based on (`If-Match`), so a change made elsewhere since is a conflict. */
function baseEtag(
  ctx: MethodContext,
  ref: { accountId: string; calRemote: string; remote: string; recurrenceId?: string },
  scope: string,
): string | undefined {
  const occurrence = scope === 'occurrence' && ref.recurrenceId ? ref.recurrenceId : undefined;
  const row = eventRow(ctx, ref.accountId, ref.calRemote, ref.remote, occurrence);
  // An occurrence without an exception row of its own has no version of its own yet.
  if (!row && !occurrence) throw notFoundEvent();
  return row?.etag ?? undefined;
}

/** The change landed elsewhere first: the saved write already holds the newer copy, so the screen can show it. */
const changedElsewhere = () =>
  new ContractError({
    type: 'conflict',
    message: 'This event changed elsewhere. The newer version is shown; make your change again.',
    reasonCode: 'calendar.conflict',
  });

interface HiddenRow {
  [k: string]: string | number | null;
  calendar_id: number;
  remote_id: string;
  recurrence_id: string;
}
const hiddenSet = (ctx: MethodContext) =>
  new Set(
    ctx.services.store
      .read(q => q.all<HiddenRow>('SELECT calendar_id, remote_id, recurrence_id FROM event_hidden'))
      .map(r => `${r.calendar_id}|${r.remote_id}|${r.recurrence_id}`),
  );

const accountIds = (ctx: MethodContext) =>
  ctx.services.store.read(q => q.all<{ id: string }>('SELECT id FROM accounts').map(r => r.id));

function calRow(ctx: MethodContext, accountId: string, remoteId: string): CalRow | undefined {
  return ctx.services.store.read(q =>
    q.get<CalRow>(
      'SELECT id, account_id, remote_id, name, color, is_primary, hidden, read_only, selected, time_zone, change_tag FROM calendars WHERE account_id = ? AND remote_id = ?',
      accountId,
      remoteId,
    ),
  );
}

function getCalendars(args: Input<'Calendar/get'>, ctx: MethodContext): Output<'Calendar/get'> {
  const list = ctx.services.store.read(q =>
    args.accountId
      ? q.all<CalRow>(
          'SELECT id, account_id, remote_id, name, color, is_primary, hidden, read_only, selected, time_zone FROM calendars WHERE account_id = ? ORDER BY is_primary DESC, name, remote_id',
          args.accountId,
        )
      : q.all<CalRow>(
          'SELECT id, account_id, remote_id, name, color, is_primary, hidden, read_only, selected, time_zone FROM calendars ORDER BY account_id, is_primary DESC, name, remote_id',
        ),
  );
  return { list: list.map(calendarFromRow) };
}

function setCalendar(args: Input<'Calendar/set'>, ctx: MethodContext): Output<'Calendar/set'> {
  const ref = parseCalendarIdIn(args.id, accountIds(ctx));
  const row = calRow(ctx, ref.accountId, ref.remoteId);
  if (!row) throw notFoundCal();
  ctx.services.store.commit({
    opId: args.opId,
    origin: 'local',
    writes: [
      {
        kind: 'calendar',
        accountId: ref.accountId,
        remoteId: ref.remoteId,
        name: row.name ?? '',
        hidden: row.hidden === 1,
        readOnly: row.read_only === 1,
        ...(row.is_primary === 1 ? { primary: true } : {}),
        ...(row.time_zone ? { timeZone: row.time_zone } : {}),
        // An omitted field keeps the stored value — the upsert writes absent fields as NULL.
        color: args.colorTag ?? row.color ?? undefined,
        ...(row.change_tag ? { changeTag: row.change_tag } : {}),
        ...(args.shown === undefined ? {} : { selected: args.shown }),
      },
      ...auditWrites(ctx.caller, 'Calendar/set', args.id),
    ],
  });
  const after = calRow(ctx, ref.accountId, ref.remoteId)!;
  return { calendar: calendarFromRow(after), receipt: receipt(ctx, args.opId) };
}

const zone = (ctx: MethodContext, accountId: string, calRemote: string) =>
  ctx.services.store.read(
    q =>
      q.get<{ time_zone: string }>(
        'SELECT time_zone FROM calendars WHERE account_id = ? AND remote_id = ?',
        accountId,
        calRemote,
      )?.time_zone ?? 'UTC',
  );

/** One stored event row plus its calendar row, looked up by the parsed contract id. */
function eventRow(
  ctx: MethodContext,
  accountId: string,
  calRemote: string,
  remote: string,
  recId?: string,
) {
  // An occurrence's contract id names the RESOURCE's remote id (the master); a Google override row carries the
  // instance remote_id and master_remote_id, a CalDAV one shares the master's remote_id — match either column.
  const on = recId
    ? '(e.remote_id = ? OR e.master_remote_id = ?) AND e.recurrence_id = ?'
    : "e.remote_id = ? AND e.master_remote_id IS NULL AND e.recurrence_id = ''";
  const params: (string | number)[] = recId ? [remote, remote, recId] : [remote];
  return ctx.services.store.read(q =>
    q.get<EvtRow & { cal_row: number; etag: string | null }>(
      `SELECT e.id, e.calendar_id, e.remote_id, e.recurrence_id, e.master_remote_id, e.status, e.etag,
              e.recurrence, e.start_utc, e.end_utc, e.all_day, e.data, c.id AS cal_row
       FROM events e JOIN calendars c ON c.id = e.calendar_id
       WHERE c.account_id = ? AND c.remote_id = ? AND ${on}`,
      accountId,
      calRemote,
      ...params,
    ),
  );
}

async function readEvent(ctx: MethodContext, id: string): Promise<Event | undefined> {
  const ref = parseEventIdIn(id, accountIds(ctx));
  const hidden = hiddenSet(ctx);
  const z = zone(ctx, ref.accountId, ref.calRemote);
  if (!ref.recurrenceId) {
    const row = eventRow(ctx, ref.accountId, ref.calRemote, ref.remote);
    if (!row) return undefined;
    const cal = calRow(ctx, ref.accountId, ref.calRemote)!;
    return eventFromRow(cal, row, hidden);
  }
  // An occurrence: the stored override wins; else expand the master for its plain occurrence.
  const oRow = eventRow(ctx, ref.accountId, ref.calRemote, ref.remote, ref.recurrenceId);
  const cal = calRow(ctx, ref.accountId, ref.calRemote);
  if (!cal) return undefined;
  if (oRow) return eventFromRow(cal, oRow, hidden);
  const master = eventRow(ctx, ref.accountId, ref.calRemote, ref.remote);
  if (!master || !master.recurrence) return undefined;
  const base = eventFromRow(cal, master, hidden);
  let rec: { rrule?: string[]; rdate?: string[]; exdate?: string[] };
  try {
    rec = JSON.parse(master.recurrence) as typeof rec;
  } catch {
    return undefined;
  }
  // Bound the expansion to a day around the occurrence's original start (its id carries the key).
  const at = instant(recurrenceIdToTime(ref.recurrenceId), z);
  const day = 86_400_000;
  const expanded = (await lazyExpand())({
    start: fromWire(base.start),
    end: fromWire(base.end),
    allDay: base.allDay,
    ...(base.timeZone ? { tzid: base.timeZone } : {}),
    rrule: rec.rrule,
    rdate: rec.rdate,
    exdate: rec.exdate,
    overrides: [],
    range: { from: at - day, to: at + day },
    floatingZone: z,
    limit: 5_000,
  });
  const occ = expanded.occurrences.find(o => o.recurrenceId === ref.recurrenceId);
  if (!occ) return undefined;
  const isHidden = hidden.has(`${master.calendar_id}|${ref.remote}|${ref.recurrenceId}`);
  return occurrenceEvent(base, occ, occ.overridden, isHidden);
}

async function getEvents(
  args: Input<'Event/get'>,
  ctx: MethodContext,
): Promise<Output<'Event/get'>> {
  const list: Event[] = [];
  const notFound: string[] = [];
  for (const id of args.ids) {
    let event;
    try {
      event = await readEvent(ctx, id);
    } catch (error) {
      if (error instanceof ContractError && error.type === 'notFound') event = undefined;
      else throw error;
    }
    if (event) list.push(event);
    else notFound.push(id);
  }
  return { state: stateOf(ctx), list, notFound };
}

/** The wire `EventFields` to the port's: `title` is `summary`, times go to the engine union, attendees take
 * the port's required response/organizer/self (the provider fills the truth back in on save). */
function toPortFields(f: Partial<EventFields>): Partial<PortFields> {
  const out: Partial<PortFields> = {};
  // `threadId` (link the event to its mail) has no port field in this round and is dropped on purpose.
  const withZone = (t: EventFields['start'] | undefined) =>
    t && t.type === 'floating' && !t.timeZone && f.timeZone ? { ...t, timeZone: f.timeZone } : t;
  if (f.title !== undefined) out.summary = f.title;
  if (f.start !== undefined) out.start = withZone(f.start) ?? f.start;
  if (f.end !== undefined) out.end = withZone(f.end) ?? f.end;
  if (f.allDay !== undefined) out.allDay = f.allDay;
  if (f.location !== undefined) out.location = f.location;
  if (f.description !== undefined) out.description = f.description;
  if (f.attendees !== undefined)
    out.attendees = f.attendees.map(a => ({
      address: a.address,
      ...(a.name ? { name: a.name } : {}),
      response: 'needsAction',
      organizer: false,
      self: false,
      ...(a.optional ? { optional: true } : {}),
    }));
  return out;
}

/** `audit: true` methods whose commit lives in the port still get a listener audit row, under a nonce opId. */
const auditCall = (ctx: MethodContext, method: string, target?: string) => {
  const writes = auditWrites(ctx.caller, method, target);
  if (writes.length) ctx.services.store.commit({ opId: nonce(ctx), origin: 'local', writes });
};

function hideEvents(args: Input<'Event/hide'>, ctx: MethodContext): Output<'Event/hide'> {
  const writes = args.ids.map(id => {
    const ref = parseEventIdIn(id, accountIds(ctx));
    return {
      kind: 'eventHidden' as const,
      accountId: ref.accountId,
      calendarRemoteId: ref.calRemote,
      remoteId: ref.remote,
      ...(ref.recurrenceId ? { recurrenceId: ref.recurrenceId } : {}),
      hidden: args.hidden,
    };
  });
  ctx.services.store.commit({
    opId: args.opId,
    origin: 'local',
    writes: [...writes, ...auditWrites(ctx.caller, 'Event/hide')],
  });
  return receipt(ctx, args.opId);
}

async function setEvent(
  args: Input<'Event/set'>,
  ctx: MethodContext,
): Promise<Output<'Event/set'>> {
  const { change } = args;
  const notify = args.notify;
  if (change.type === 'create') {
    const cal = parseCalendarIdIn(change.calendarId, accountIds(ctx));
    writableCalendar(ctx, cal.accountId, cal.remoteId);
    const result = await ctx.services.calendar.put(cal.accountId, {
      calendarRemoteId: cal.remoteId,
      scope: 'occurrence',
      fields: toPortFields(change.fields),
      notify,
    });
    return savedEvent(ctx, args.opId, result, cal.accountId, cal.remoteId);
  }
  const ref = parseEventIdIn(change.id, accountIds(ctx));
  writableCalendar(ctx, ref.accountId, ref.calRemote);
  const etag = baseEtag(ctx, ref, change.scope);
  const target = {
    calendarRemoteId: ref.calRemote,
    remoteId: ref.remote,
    ...(ref.recurrenceId ? { recurrenceId: ref.recurrenceId } : {}),
    ...(etag ? { etag } : {}),
  };
  if (change.type === 'destroy') {
    const result = await ctx.services.calendar.remove(ref.accountId, {
      ...target,
      scope: change.scope,
      notify,
    });
    if (result.kind === 'conflict') throw changedElsewhere();
    auditCall(ctx, 'Event/set', args.opId);
    return { receipt: receipt(ctx, args.opId) };
  }
  const result = await ctx.services.calendar.put(ref.accountId, {
    ...target,
    scope: change.scope,
    fields: toPortFields(change.fields),
    notify,
  });
  return savedEvent(ctx, args.opId, result, ref.accountId, ref.calRemote);
}

async function savedEvent(
  ctx: MethodContext,
  opId: string,
  result: Awaited<ReturnType<MethodContext['services']['calendar']['put']>>,
  accountId: string,
  calRemote: string,
): Promise<Output<'Event/set'>> {
  if (result.kind === 'conflict') throw changedElsewhere();
  auditCall(ctx, 'Event/set', opId);
  // The port committed the saved facts; read the first upsert back for the response. A saved override's
  // contract id names its master plus the recurrence key (`masterRemoteId ?? remoteId`, then `@recId`).
  const first = result.upserts[0];
  const id = first
    ? `${accountId}:${calRemote}/${first.masterRemoteId ?? first.remoteId}${first.recurrenceId ? `@${first.recurrenceId}` : ''}`
    : undefined;
  const event = id ? await readEvent(ctx, id) : undefined;
  return { ...(event ? { event } : {}), receipt: receipt(ctx, opId) };
}

async function rsvp(args: Input<'Event/rsvp'>, ctx: MethodContext): Promise<Output<'Event/rsvp'>> {
  const ref = parseEventIdIn(args.id, accountIds(ctx));
  writableCalendar(ctx, ref.accountId, ref.calRemote);
  const etag = baseEtag(ctx, ref, args.scope);
  const result = await ctx.services.calendar.rsvp(
    ref.accountId,
    {
      calendarRemoteId: ref.calRemote,
      remoteId: ref.remote,
      ...(ref.recurrenceId ? { recurrenceId: ref.recurrenceId } : {}),
      ...(etag ? { etag } : {}),
      scope: args.scope,
    },
    args.response,
    { notify: args.notify ?? true },
  );
  if (result.kind === 'conflict') throw changedElsewhere();
  auditCall(ctx, 'Event/rsvp', args.opId);
  return receipt(ctx, args.opId);
}

function getPlans(args: Input<'Plan/get'>, ctx: MethodContext): Output<'Plan/get'> {
  return { state: stateOf(ctx), list: [] as Plan[], notFound: args.ids };
}

const noPlan = () =>
  new ContractError({ type: 'notFound', message: 'This plan is no longer waiting.' });

export const handlers: AreaHandlers<'event'> = {
  'Calendar/get': getCalendars,
  'Calendar/set': setCalendar,
  'Event/get': getEvents,
  'Event/set': setEvent,
  'Event/hide': hideEvents,
  'Event/rsvp': rsvp,
  'Event/extract': notImplemented('Event/extract'),
  'Plan/get': getPlans,
  'Plan/confirm': () => {
    throw noPlan();
  },
  'Plan/dismiss': () => {
    throw noPlan();
  },
};
