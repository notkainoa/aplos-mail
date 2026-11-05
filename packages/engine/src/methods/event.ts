import type { Event, Input, Output, Plan, Receipt } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { auditWrites } from '../host/audit';
import {
  calendarFromRow,
  eventFromRow,
  fromWire,
  occurrenceEvent,
  parseCalendarId,
  parseEventId,
  type CalRow,
  type EvtRow,
} from '../calendar/project';
import { expand } from '../calendar/recurrence';
import { notImplemented, type AreaHandlers, type MethodContext } from './types';

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

function calRow(ctx: MethodContext, accountId: string, remoteId: string): CalRow | undefined {
  return ctx.services.store.read(q =>
    q.get<CalRow>(
      'SELECT id, account_id, remote_id, name, color, is_primary, hidden, read_only, selected, time_zone FROM calendars WHERE account_id = ? AND remote_id = ?',
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
  const ref = parseCalendarId(args.id);
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
        ...(args.shown === undefined ? {} : { selected: args.shown }),
        ...(args.colorTag === undefined ? {} : { color: args.colorTag }),
      },
      ...auditWrites(ctx.caller, 'Calendar/set', args.id),
    ],
  });
  const after = calRow(ctx, ref.accountId, ref.remoteId)!;
  return { calendar: calendarFromRow(after), receipt: receipt(ctx, args.opId) };
}

const zone = (ctx: MethodContext) =>
  ctx.services.store.read(
    q =>
      q.get<{ time_zone: string }>(
        'SELECT time_zone FROM calendars WHERE is_primary = 1 AND time_zone IS NOT NULL LIMIT 1',
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
  return ctx.services.store.read(q =>
    q.get<EvtRow & { cal_row: number }>(
      `SELECT e.id, e.calendar_id, e.remote_id, e.recurrence_id, e.master_remote_id, e.status,
              e.recurrence, e.start_utc, e.end_utc, e.all_day, e.data, c.id AS cal_row
       FROM events e JOIN calendars c ON c.id = e.calendar_id
       WHERE c.account_id = ? AND c.remote_id = ? AND e.remote_id = ? AND e.recurrence_id = ?`,
      accountId,
      calRemote,
      remote,
      recId ?? '',
    ),
  );
}

function readEvent(ctx: MethodContext, id: string): Event | undefined {
  const ref = parseEventId(id);
  const hidden = hiddenSet(ctx);
  const z = zone(ctx);
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
  const rec = JSON.parse(master.recurrence) as {
    rrule?: string[];
    rdate?: string[];
    exdate?: string[];
  };
  const expanded = expand({
    start: fromWire(base.start),
    end: fromWire(base.end),
    allDay: base.allDay,
    ...(base.timeZone ? { tzid: base.timeZone } : {}),
    rrule: rec.rrule,
    rdate: rec.rdate,
    exdate: rec.exdate,
    overrides: [],
    range: { from: 0, to: 2 ** 42 },
    floatingZone: z,
    limit: 20_000,
  });
  const occ = expanded.occurrences.find(o => o.recurrenceId === ref.recurrenceId);
  if (!occ) return undefined;
  const isHidden = hidden.has(`${master.calendar_id}|${ref.remote}|${ref.recurrenceId}`);
  return occurrenceEvent(base, occ, true, isHidden);
}

function getEvents(args: Input<'Event/get'>, ctx: MethodContext): Output<'Event/get'> {
  const list: Event[] = [];
  const notFound: string[] = [];
  for (const id of args.ids) {
    let event;
    try {
      event = readEvent(ctx, id);
    } catch (error) {
      if (error instanceof ContractError && error.type === 'notFound') event = undefined;
      else throw error;
    }
    if (event) list.push(event);
    else notFound.push(id);
  }
  return { state: stateOf(ctx), list, notFound };
}

function hideEvents(args: Input<'Event/hide'>, ctx: MethodContext): Output<'Event/hide'> {
  const writes = args.ids.flatMap(id => {
    const ref = parseEventId(id);
    return [
      {
        kind: 'eventHidden' as const,
        accountId: ref.accountId,
        calendarRemoteId: ref.calRemote,
        remoteId: ref.remote,
        ...(ref.recurrenceId ? { recurrenceId: ref.recurrenceId } : {}),
        hidden: args.hidden,
      },
    ];
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
    const cal = parseCalendarId(change.calendarId);
    const result = await ctx.services.calendar.put(cal.accountId, {
      calendarRemoteId: cal.remoteId,
      scope: 'occurrence',
      fields: change.fields as Output<'Event/set'> extends never ? never : never,
      notify,
    } as never);
    return savedEvent(ctx, args.opId, result, cal.accountId, cal.remoteId);
  }
  const ref = parseEventId(change.id);
  if (change.type === 'destroy') {
    const result = await ctx.services.calendar.remove(ref.accountId, {
      calendarRemoteId: ref.calRemote,
      remoteId: ref.remote,
      ...(ref.recurrenceId ? { recurrenceId: ref.recurrenceId } : {}),
      scope: change.scope,
      notify,
    });
    if (result.kind === 'conflict')
      throw new ContractError({ type: 'conflict', message: 'This event changed elsewhere.' });
    return { receipt: receipt(ctx, args.opId) };
  }
  const result = await ctx.services.calendar.put(ref.accountId, {
    calendarRemoteId: ref.calRemote,
    remoteId: ref.remote,
    ...(ref.recurrenceId ? { recurrenceId: ref.recurrenceId } : {}),
    scope: change.scope,
    fields: change.fields as never,
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
  if (result.kind === 'conflict')
    throw new ContractError({ type: 'conflict', message: 'This event changed elsewhere.' });
  // The port committed the saved facts; read the first upsert back for the response.
  const first = result.upserts[0];
  const event = first ? readEvent(ctx, `${accountId}:${calRemote}:${first.remoteId}`) : undefined;
  return { ...(event ? { event } : {}), receipt: receipt(ctx, opId) };
}

async function rsvp(args: Input<'Event/rsvp'>, ctx: MethodContext): Promise<Output<'Event/rsvp'>> {
  const ref = parseEventId(args.id);
  const result = await ctx.services.calendar.rsvp(
    ref.accountId,
    {
      calendarRemoteId: ref.calRemote,
      remoteId: ref.remote,
      ...(ref.recurrenceId ? { recurrenceId: ref.recurrenceId } : {}),
      scope: args.scope,
    },
    args.response,
    { notify: args.notify ?? true },
  );
  if (result.kind === 'conflict')
    throw new ContractError({ type: 'conflict', message: 'This event changed elsewhere.' });
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
