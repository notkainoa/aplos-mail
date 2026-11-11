import type { Event, Input, Output, Receipt } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { auditWrites } from '../host/audit';
import { fromWall, isKnownZone, toWall } from '../calendar/recurrence/zone';
import { eventIdForOp } from '../calendar/event-id';
import { runCall } from '../calendar/holds-call';
import type { HeldCall, HoldSpec } from '../calendar/holds-types';
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
import { nonce, type AreaHandlers, type MethodContext } from './types';

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

/**
 * A write that tells guests (`notify`) waits its undo window as a hold when the engine has one: the receipt is
 * undoable until `undoUntil` and `Operation/undo` cancels it before Google hears of it. Anything else goes at once.
 */
async function holdIfNotifying(
  ctx: MethodContext,
  spec: Omit<HoldSpec, 'windowMs'>,
  notify: boolean | undefined,
): Promise<Receipt | undefined> {
  const holds = ctx.services.calendarHolds;
  if (!holds || notify !== true) return undefined;
  const receipt = await holds.hold(spec);
  auditCall(ctx, spec.method, spec.opId);
  return receipt;
}

async function setEvent(
  args: Input<'Event/set'>,
  ctx: MethodContext,
): Promise<Output<'Event/set'>> {
  const { change } = args;
  const notify = args.notify;
  const spec = (targets: string[], call: HeldCall) => ({
    opId: args.opId,
    method: 'Event/set' as const,
    targets,
    call,
  });
  if (change.type === 'create') {
    const cal = parseCalendarIdIn(change.calendarId, accountIds(ctx));
    writableCalendar(ctx, cal.accountId, cal.remoteId);
    const call: HeldCall = {
      op: 'put',
      account: cal.accountId,
      change: {
        calendarRemoteId: cal.remoteId,
        scope: 'occurrence',
        fields: toPortFields(change.fields),
        notify,
        // The event id derives from the op id, so a re-sent create meets 409, not a duplicate.
        newRemoteId: await eventIdForOp(cal.accountId, args.opId),
      },
    };
    const held = await holdIfNotifying(ctx, spec([change.calendarId], call), notify);
    if (held) return { receipt: held };
    return savedEvent(
      ctx,
      args.opId,
      await runCall(ctx.services.calendar, call),
      cal.accountId,
      cal.remoteId,
    );
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
    const call: HeldCall = {
      op: 'remove',
      account: ref.accountId,
      ref: { ...target, scope: change.scope, notify },
    };
    const held = await holdIfNotifying(ctx, spec([change.id], call), notify);
    if (held) return { receipt: held };
    const result = await runCall(ctx.services.calendar, call);
    if (result.kind === 'conflict') throw changedElsewhere();
    auditCall(ctx, 'Event/set', args.opId);
    return { receipt: receipt(ctx, args.opId) };
  }
  const fields = toPortFields(change.fields);
  // A 'series' edit opened from one occurrence carries that occurrence's new times; the series must move by
  // the DELTA, not to the occurrence's absolute times (MED, #394: a naive patch would drag the whole series
  // to the clicked instance's slot).
  if (change.scope === 'series' && ref.recurrenceId)
    rebaseSeriesTimes(ctx, { ...ref, recurrenceId: ref.recurrenceId }, fields);
  const call: HeldCall = {
    op: 'put',
    account: ref.accountId,
    change: { ...target, scope: change.scope, fields, notify },
  };
  const held = await holdIfNotifying(ctx, spec([change.id], call), notify);
  if (held) return { receipt: held };
  return savedEvent(
    ctx,
    args.opId,
    await runCall(ctx.services.calendar, call),
    ref.accountId,
    ref.calRemote,
  );
}

/**
 * Rebase `fields.start`/`end` onto the master when a series edit was opened from one occurrence: the user's
 * new times describe THE OCCURRENCE, so the master's stored times shift by the same delta (keeps the
 * master's own slot, duration and zone). `utc` and `date` times rebase; a `floating` time passes through.
 */
/**
 * A series time change that cannot be moved by an offset: the whole series would land on the clicked occurrence's slot,
 * silently corrupting every future event, so it is refused with a plain sentence instead.
 */
const seriesTimeRefusal = () =>
  new ContractError({
    type: 'unsupported',
    message: 'Edit the first event of the series to change the time of every event.',
    reasonCode: 'calendar.floatingSeries',
  });

interface RebaseBase {
  master: { start_utc: number; end_utc: number; zone?: string; allDay: boolean };
  occStart: number;
  occEnd: number;
}

/** The master's and the occurrence's stored times, the base every rebase measures from. */
function rebaseBase(
  ctx: MethodContext,
  ref: { accountId: string; calRemote: string; remote: string; recurrenceId: string },
): RebaseBase {
  const stored = eventRow(ctx, ref.accountId, ref.calRemote, ref.remote);
  if (!stored || stored.start_utc === null || stored.end_utc === null) throw notFoundEvent();
  let masterZone: string | undefined;
  try {
    const start = (JSON.parse(stored.data) as { start?: { timeZone?: unknown } }).start;
    masterZone = typeof start?.timeZone === 'string' ? start.timeZone : undefined;
  } catch {
    masterZone = undefined;
  }
  const master = {
    start_utc: stored.start_utc,
    end_utc: stored.end_utc,
    allDay: stored.all_day === 1,
    ...(masterZone ? { zone: masterZone } : {}),
  };
  const occ = eventRow(ctx, ref.accountId, ref.calRemote, ref.remote, ref.recurrenceId);
  const occStart =
    occ?.start_utc ??
    instant(recurrenceIdToTime(ref.recurrenceId), zone(ctx, ref.accountId, ref.calRemote));
  // The occurrence's own end: a stored override's, else its slot (the master's span from its start).
  const occEnd = occ?.end_utc ?? occStart + (master.end_utc - master.start_utc);
  return { master, occStart, occEnd };
}

function rebaseSeriesTimes(
  ctx: MethodContext,
  ref: { accountId: string; calRemote: string; remote: string; recurrenceId: string },
  fields: Partial<PortFields>,
): void {
  const start = fields.start;
  const end = fields.end;
  if (!start && !end) return;
  // Mixed kinds (a utc start with a date end) describe nothing a single offset can move.
  if (start && end && start.type !== end.type) throw seriesTimeRefusal();
  const kind = (start ?? end)!.type;
  if (kind === 'floating') return rebaseZoned(rebaseBase(ctx, ref), fields);
  const base = rebaseBase(ctx, ref);
  if (kind === 'utc') {
    // An all-day series keeps whole-day times, and a zone Aplos cannot read cannot move on its own wall clock:
    // neither has a safe offset for an instant-typed change.
    if (base.master.allDay || (base.master.zone && !isKnownZone(base.master.zone)))
      throw seriesTimeRefusal();
    // A series that lives in a zone moves on that zone's wall clock whatever form the request came in: elapsed time
    // is an hour off across a daylight-saving change (Oct 28 10:00 PDT moved to Nov 1 10:00 PST). A series with no
    // zone has only elapsed time to go by.
    const tz = base.master.zone;
    if (tz) {
      const floating = (t: PortFields['start'] | undefined): PortFields['start'] | undefined =>
        t?.type === 'utc'
          ? {
              type: 'floating',
              local: new Date(toWall(t.utc, tz)).toISOString().slice(0, 19),
              timeZone: tz,
            }
          : t;
      if (start) fields.start = floating(start);
      if (end) fields.end = floating(end);
      // The pair also carries its ELAPSED measure: the owner's wall reading is tried first (an 18:00-02:00 evening stays
      // 18:00-02:00 across the fall-back night) and the elapsed one is used only when the wall reading collapses (01:30
      // happens twice), which would write a zero-length or end-before-start change.
      const span = start?.type === 'utc' && end?.type === 'utc' ? end.utc - start.utc : undefined;
      const endDelta = end?.type === 'utc' && !start ? end.utc - base.occEnd : undefined;
      return rebaseZoned(base, fields, {
        ...(span !== undefined ? { span } : {}),
        ...(endDelta !== undefined ? { endDelta } : {}),
      });
    }
    rebaseUtc(base.master, base.occStart, base.occEnd, fields);
  } else rebaseAllDay(base.master, base.occStart, base.occEnd, fields);
}

/**
 * Zoned wall-clock times (what the Calendar screen sends for a Google timed event). The shift is measured in the zone's
 * WALL CLOCK, not in elapsed time, so an occurrence moved across a daylight-saving change keeps the clock time the
 * owner picked: 10:00 stays 10:00 on the master's own day. Refused: a time with no zone, a zone Aplos does not know,
 * a start and an end in different zones, and a zone other than the master's (the series would be rewritten into it).
 */
function rebaseZoned(
  base: RebaseBase,
  fields: Partial<PortFields>,
  /** Measures of a request that arrived as utc instants: the span to apply, or the end's move — both elapsed time. */
  elapsed?: { span?: number; endDelta?: number },
): void {
  const start = fields.start?.type === 'floating' ? fields.start : undefined;
  const end = fields.end?.type === 'floating' ? fields.end : undefined;
  const tz = (start ?? end)?.timeZone;
  if (!tz || !isKnownZone(tz) || (start && end && start.timeZone !== end.timeZone))
    throw seriesTimeRefusal();
  const { master, occStart, occEnd } = base;
  // The series' own zone, or none: a series with no zone is not rewritten into one (it would quietly gain it).
  if (master.zone !== tz) throw seriesTimeRefusal();
  const wall = (local: string) => Date.parse(`${local}Z`);
  const local = (ms: number): PortFields['start'] => ({
    type: 'floating',
    local: new Date(ms).toISOString().slice(0, 19),
    timeZone: tz,
  });
  const masterStart = toWall(master.start_utc, tz);
  const masterEnd = toWall(master.end_utc, tz);
  const shift = start ? wall(start.local) - toWall(occStart, tz) : 0;
  const newStart = masterStart + shift;
  // A start move applies the owner's new span from the shifted start; an end-only resize shifts the master's end by
  // how far the occurrence's own end moved; an unchanged end rides the start shift. For a request carried as utc
  // instants the WALL measure is used too; the ELAPSED one (added on the timeline and read back onto the wall clock)
  // only when the wall reading is zero or negative.
  // Wall clock first; elapsed only when the wall reading is zero or negative (an end in the repeated hour).
  const wallEnd = !end
    ? masterEnd + shift
    : start
      ? newStart + (wall(end.local) - wall(start.local))
      : masterEnd + (wall(end.local) - toWall(occEnd, tz));
  const newEnd =
    !end || wallEnd > newStart
      ? wallEnd
      : elapsed?.span !== undefined
        ? toWall(fromWall(newStart, tz) + elapsed.span, tz)
        : elapsed?.endDelta !== undefined
          ? toWall(master.end_utc + elapsed.endDelta, tz)
          : wallEnd;
  fields.start = local(newStart);
  fields.end = local(newEnd);
}

/** The `utc` rebasing: whole milliseconds against the master and occurrence's stored epochs. */
function rebaseUtc(
  master: { start_utc: number; end_utc: number },
  occStart: number,
  occEnd: number,
  fields: Partial<PortFields>,
): void {
  const start = fields.start;
  const end = fields.end;
  const delta = start?.type === 'utc' ? start.utc - occStart : 0;
  const newStart = master.start_utc + delta;
  fields.start = { type: 'utc', utc: newStart };
  // A start move applies the user's new span from the shifted start; an end-only resize shifts the
  // master's end by the delta to the occurrence's own end; an unchanged end rides the start delta.
  fields.end =
    end?.type === 'utc'
      ? {
          type: 'utc',
          utc:
            start?.type === 'utc'
              ? newStart + (end.utc - start.utc)
              : master.end_utc + (end.utc - occEnd),
        }
      : { type: 'utc', utc: master.end_utc + delta };
}

/** The all-day `date` rebasing: whole days against the stored epoch midnights. */
function rebaseAllDay(
  master: { start_utc: number; end_utc: number },
  occStart: number,
  occEnd: number,
  fields: Partial<PortFields>,
): void {
  const start = fields.start;
  const end = fields.end;
  const day = 86_400_000;
  const dateMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const iso = (epoch: number) => new Date(epoch).toISOString().slice(0, 10);
  const deltaMs =
    start?.type === 'date' ? Math.round((dateMs(start.date) - occStart) / day) * day : 0;
  const newStartMs = master.start_utc + deltaMs;
  fields.start = { type: 'date', date: iso(newStartMs) };
  fields.end =
    end?.type === 'date'
      ? {
          type: 'date',
          date: iso(
            start?.type === 'date'
              ? newStartMs + (dateMs(end.date) - dateMs(start.date))
              : master.end_utc + Math.round((dateMs(end.date) - occEnd) / day) * day,
          ),
        }
      : { type: 'date', date: iso(master.end_utc + deltaMs) };
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
  const notify = args.notify ?? true;
  const call: HeldCall = {
    op: 'rsvp',
    account: ref.accountId,
    ref: {
      calendarRemoteId: ref.calRemote,
      remoteId: ref.remote,
      ...(ref.recurrenceId ? { recurrenceId: ref.recurrenceId } : {}),
      ...(etag ? { etag } : {}),
      scope: args.scope,
    },
    response: args.response,
    opts: { notify },
  };
  // An answer that tells the organizer is held briefly like any change that tells someone; `notify: false` goes at once.
  const held = await holdIfNotifying(
    ctx,
    { opId: args.opId, method: 'Event/rsvp', targets: [args.id], call },
    notify,
  );
  if (held) return held;
  const result = await runCall(ctx.services.calendar, call);
  if (result.kind === 'conflict') throw changedElsewhere();
  auditCall(ctx, 'Event/rsvp', args.opId);
  return receipt(ctx, args.opId);
}

const plansImpl = () => import('../ai/impl/plans');

export const handlers: AreaHandlers<'event'> = {
  'Calendar/get': getCalendars,
  'Calendar/set': setCalendar,
  'Event/get': getEvents,
  'Event/set': setEvent,
  'Event/hide': hideEvents,
  'Event/rsvp': rsvp,
  // The plan surface lazy-loads `ai/impl/plans` (the bundle budget's seam); the impl holds the gate, the
  // date-ish pre-filter and the model call. `Plan/*` writes stay local except `Plan/confirm`'s calendar put.
  'Event/extract': async (args, ctx) => (await plansImpl()).extract(args, ctx),
  'Plan/get': async (args, ctx) => (await plansImpl()).getPlans(args, ctx),
  'Plan/confirm': async (args, ctx) => (await plansImpl()).confirmPlan(args, ctx),
  'Plan/dismiss': async (args, ctx) => (await plansImpl()).dismissPlans(args, ctx),
};
