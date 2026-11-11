import type { ErrorBody, Input, Operation, Receipt } from '@aplos/contract';
import { NotSentError } from '../ports/base';
import { requireOriginating } from '@aplos/contract/access';
import { ContractError } from '@aplos/contract/contract-error';
import type { Caller } from '../methods/types';
import { instant, recurrenceIdToTime } from './project';
import { expand } from './recurrence/expand';
import type { EventTime as EngineTime } from './recurrence/types';
import type { Clock, Logger, StorePort } from '../ports';
import { parseStored, withDefaults } from '../runtime/settings';
import type { EngineServices } from '../runtime/services';
import { runCall } from './holds-call';
import {
  HOLD_KEEP_MS,
  HOLD_LATE_MS,
  type HeldCall,
  type HoldRecord,
  type HoldSpec,
} from './holds-types';

/**
 * The working half of the calendar holds (lazy, loaded on the first held write or the first due hold). A hold is a
 * calendar write that tells guests: it waits its undo window as data in `meta`, then is sent through the
 * `CalendarPort` like any write. Undo cancels it while it waits (the provider never hears of it); once sent there is
 * no inverse, so undo answers `conflict` instead of claiming to restore. Nothing is a delayed commit.
 */

export const HOLD_PREFIX = 'calendar.hold.';
/** A hold whose account is not started yet is looked at again after this long. */
const RETRY_AFTER_MS = 30_000;

const keyOf = (opId: string) => `${HOLD_PREFIX}${opId}`;

function parse(value: string): HoldRecord | undefined {
  try {
    const r = JSON.parse(value) as Partial<HoldRecord>;
    return typeof r?.opId === 'string' && typeof r.state === 'string'
      ? (r as HoldRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

export function readRecord(store: StorePort, opId: string): HoldRecord | undefined {
  const row = store.read(q =>
    q.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', keyOf(opId)),
  );
  return row ? parse(row.value) : undefined;
}

/** Every readable hold, and the keys of rows that are not (those are purged, never allowed to stall the loop). */
export function readAll(store: StorePort): { records: HoldRecord[]; unreadable: string[] } {
  const rows = store.read(q =>
    q.all<{ key: string; value: string }>(
      'SELECT key, value FROM meta WHERE key LIKE ?',
      `${HOLD_PREFIX}%`,
    ),
  );
  const records: HoldRecord[] = [];
  const unreadable: string[] = [];
  for (const row of rows) {
    const r = parse(row.value);
    if (r) records.push(r);
    else unreadable.push(row.key);
  }
  return { records, unreadable };
}

/** True when the event this hold is about has already started: invitations for something under way are not sent unasked. */
function startedBy(store: StorePort, call: HeldCall | undefined, now: number): boolean {
  if (!call) return false;
  const start = startOf(store, call, now);
  return start !== undefined && start < now;
}

/** The calendar's own time zone (UTC when it has none). */
function calendarZone(store: StorePort, accountId: string, calRemote: string): string {
  return (
    store.read(q =>
      q.get<{ time_zone: string | null }>(
        'SELECT time_zone FROM calendars WHERE account_id = ? AND remote_id = ?',
        accountId,
        calRemote,
      ),
    )?.time_zone ?? 'UTC'
  );
}

function startOf(store: StorePort, call: HeldCall, now: number): number | undefined {
  const ref = call.op === 'put' ? call.change : call.ref;
  // A whole-series write matters while the series still has an occurrence to come: the master's stored slot is the
  // FIRST occurrence, long past on an ongoing series, so the check is against the next one instead.
  if (ref.scope === 'series' && ref.remoteId)
    return nextOccurrence(store, call.account, ref.calendarRemoteId, ref.remoteId, now);
  // A wall-clock time with no zone of its own is read in the calendar's zone, the way the engine reads it everywhere.
  const zone = calendarZone(store, call.account, ref.calendarRemoteId);
  if (call.op === 'put' && call.change.fields.start) return instant(call.change.fields.start, zone);
  const remoteId = ref.remoteId;
  if (!remoteId) return undefined;
  // One occurrence, or the first of a 'following' change: its own original start.
  if (ref.recurrenceId) return instant(recurrenceIdToTime(ref.recurrenceId), zone);
  const row = store.read(q =>
    q.get<{ start_utc: number | null; recurrence: string | null }>(
      `SELECT e.start_utc, e.recurrence FROM events e JOIN calendars c ON c.id = e.calendar_id
       WHERE c.account_id = ? AND c.remote_id = ? AND e.remote_id = ? AND e.recurrence_id = ''`,
      call.account,
      ref.calendarRemoteId,
      remoteId,
    ),
  );
  // A recurring series starts in the past by definition (its master holds the FIRST occurrence): an edit of the whole
  // series is never "already started", or every held edit of a weekly meeting would wait for a manual Retry.
  if (row?.recurrence) return undefined;
  return row?.start_utc ?? undefined;
}

/** How far ahead "next occurrence" looks: covers a yearly series. */
const SERIES_AHEAD_MS = 732 * 86_400_000;

/**
 * Whether a series has anything left to change: `undefined` while an occurrence is under way or still to come (the
 * write matters, send it), and the master's stored slot once nothing remains — a finished series reads as past, so
 * "already started" still holds for it.
 */
function nextOccurrence(
  store: StorePort,
  accountId: string,
  calRemote: string,
  remoteId: string,
  now: number,
): number | undefined {
  const row = store.read(q =>
    q.get<{
      start_utc: number | null;
      end_utc: number | null;
      all_day: number | null;
      recurrence: string | null;
      data: string;
      time_zone: string | null;
    }>(
      `SELECT e.start_utc, e.end_utc, e.all_day, e.recurrence, e.data, c.time_zone
       FROM events e JOIN calendars c ON c.id = e.calendar_id
       WHERE c.account_id = ? AND c.remote_id = ? AND e.remote_id = ? AND e.recurrence_id = ''`,
      accountId,
      calRemote,
      remoteId,
    ),
  );
  if (!row || row.start_utc === null) return row?.start_utc ?? undefined;
  if (!row.recurrence) return row.start_utc;
  let g: { start?: { dateTime?: string; timeZone?: string }; end?: { dateTime?: string } };
  let rec: { rrule?: string[]; rdate?: string[]; exdate?: string[] };
  try {
    g = JSON.parse(row.data) as typeof g;
    rec = JSON.parse(row.recurrence) as typeof rec;
  } catch {
    return row.start_utc;
  }
  const zone = g.start?.timeZone ?? row.time_zone ?? 'UTC';
  const iso = (epoch: number) => new Date(epoch).toISOString().slice(0, 10);
  const time = (
    v: { dateTime?: string; timeZone?: string } | undefined,
    stored: number | null,
  ): EngineTime =>
    row.all_day === 1
      ? { date: iso(stored ?? row.start_utc!) }
      : v?.timeZone && v.dateTime
        ? { local: v.dateTime.slice(0, 19), tzid: v.timeZone }
        : { utc: stored ?? row.start_utc! };
  const out = expand({
    start: time(g.start, row.start_utc),
    end: time(g.end, row.end_utc),
    allDay: row.all_day === 1,
    ...(g.start?.timeZone ? { tzid: g.start.timeZone } : {}),
    rrule: rec.rrule,
    rdate: rec.rdate,
    exdate: rec.exdate,
    range: { from: now, to: now + SERIES_AHEAD_MS },
    floatingZone: zone,
    limit: 4,
  });
  if (!out.ok || !out.occurrences.length) return row.start_utc;
  return undefined;
}

/** What a hold changes: the same event (or occurrence) twice at once would make the second meet the first's new version. */
function targetOf(call: HeldCall | undefined): { event: string; occurrence: string } | undefined {
  if (!call) return undefined;
  const ref = call.op === 'put' ? call.change : call.ref;
  if (!ref.remoteId) return undefined; // a create has no event yet
  return {
    event: [call.account, ref.calendarRemoteId, ref.remoteId].join('|'),
    // A whole-series change (no recurrence id, or scope 'series') reaches every occurrence.
    occurrence: ref.scope === 'series' ? '' : (ref.recurrenceId ?? ''),
  };
}

/** Two holds clash when they change the same event, and either is a whole-series change or both name one occurrence. */
function clash(a: ReturnType<typeof targetOf>, b: ReturnType<typeof targetOf>): boolean {
  return (
    !!a &&
    !!b &&
    a.event === b.event &&
    (a.occurrence === '' || b.occurrence === '' || a.occurrence === b.occurrence)
  );
}

/** The owner's undo window (the same one mail sends use). */
const undoSeconds = (store: StorePort) =>
  withDefaults(
    parseStored(
      store.read(q => q.get<{ data: string }>('SELECT data FROM settings WHERE id = 1'))?.data,
    ),
  ).mail.undoSendSeconds;

const stateOf = (store: StorePort) => ({ dbEpoch: store.dbEpoch, seq: store.seq() });

interface Deps {
  store: StorePort;
  clock: Clock;
  log: Logger;
  calendar: EngineServices['calendar'];
  frames: EngineServices['frames'];
  changed(): void;
}

function save(deps: Deps, record: HoldRecord): void {
  // A finished transition is stamped: sent and undone holds purge `HOLD_KEEP_MS` after it, while a failed hold keeps
  // its call (and guests' addresses) until the owner retries or dismisses it.
  const stamped =
    record.state === 'synced' || record.state === 'failed' || record.state === 'cancelled'
      ? { ...record, finishedAt: deps.clock.now() }
      : record;
  const kept =
    stamped.state === 'synced' || stamped.state === 'cancelled'
      ? (({ call: _call, ...rest }) => rest)(stamped)
      : stamped;
  deps.store.commit({
    // A meta-only commit does not move `seq`, so the id carries its own uniqueness: a repeated id is skipped as already
    // applied, which once dropped a second save of the same state.
    opId: `calendar-hold:${record.opId}:${record.state}:${globalThis.crypto.randomUUID()}`,
    origin: 'local',
    writes: [{ kind: 'meta', key: keyOf(record.opId), value: JSON.stringify(kept) }],
  });
  deps.changed();
  // Tell every window the operation moved (the same object `Operation/get` answers), best effort.
  try {
    deps.frames.emit({ frame: 'operation', operation: operationOf(kept, deps.clock.now()) });
  } catch {
    // A frame is a convenience; the record is already saved.
  }
}

function operationOf(r: HoldRecord, now: number): Operation {
  return {
    opId: r.opId,
    kind: r.method,
    targets: r.targets,
    state: r.state,
    appliedState: r.appliedState,
    ...(r.error ? { error: r.error } : {}),
    // Undoable while its window is open; a hold waiting for its account to start is past its window (it is still only
    // queued, so undo still cancels it, but the Undo toast has long gone).
    undoable: r.state === 'queued' && r.undoUntil > now,
    ...(r.state === 'queued' && r.undoUntil > now ? { undoUntil: r.undoUntil } : {}),
    createdAt: r.createdAt,
    scope: r.scope,
  };
}

/** What a failed send tells the Retry surface: the port already turned it into a plain `ContractError` body. */
function bodyOf(error: unknown): ErrorBody {
  if (error instanceof ContractError) return structuredClone(error.body) as ErrorBody;
  return { type: 'internal', message: 'Aplos could not send that change. Try again.' };
}

/** Sends one hold now. Never throws: the outcome is the record's state. */
async function send(deps: Deps, record: HoldRecord, inflight: Set<string>): Promise<void> {
  if (!record.call) return;
  inflight.add(record.opId);
  try {
    await sendNow(deps, { ...record, call: record.call });
  } finally {
    inflight.delete(record.opId);
  }
}

async function sendNow(deps: Deps, record: HoldRecord & { call: HeldCall }): Promise<void> {
  const syncing = { ...record, state: 'syncing' as const };
  delete syncing.error;
  save(deps, syncing);
  let result: Awaited<ReturnType<typeof runCall>>;
  try {
    result = await runCall(deps.calendar, record.call);
  } catch (error) {
    // The account is not started yet (a hold came due at launch): nothing was sent, so wait a moment and try again
    // instead of reporting a failure. The 15-minute limit still ends a hold that never gets its account.
    if (error instanceof NotSentError && error.error.reason === 'accountNotStarted') {
      save(deps, { ...syncing, state: 'queued', notBefore: deps.clock.now() + RETRY_AFTER_MS });
      return;
    }
    deps.log.event('rpc.failed', { method: record.method, reason: 'calendarHoldFailed' });
    save(deps, { ...syncing, state: 'failed', error: bodyOf(error) });
    return;
  }
  try {
    if (result.kind === 'conflict') {
      save(deps, {
        ...syncing,
        state: 'failed',
        error: {
          type: 'conflict',
          message:
            'This event changed elsewhere. The newer version is shown; make your change again.',
          reasonCode: 'calendar.conflict',
        },
      });
      return;
    }
    save(deps, { ...syncing, state: 'synced', appliedState: stateOf(deps.store) });
  } catch {
    // Google ACCEPTED the change but this device could not record it: never "try again" (a second send would tell the
    // guests twice), say it may have gone through.
    deps.log.event('rpc.failed', { method: record.method, reason: 'calendarHoldRecord' });
    try {
      save(deps, {
        ...syncing,
        state: 'failed',
        error: {
          type: 'unavailable',
          message:
            'Google Calendar answered, but Aplos could not record it, so it cannot tell whether the change was saved. Check the calendar before trying again.',
          reasonCode: 'calendar.uncertain',
        },
      });
    } catch {
      // The store is unwritable: the next sweep finds the record still `syncing` and reports it uncertain.
    }
  }
}

const conflict = (message: string) => new ContractError({ type: 'conflict', message });

/** The earliest moment a hold needs the loop: a window's end, an unfinished send (now), or a finished hold's purge. */
function nextDue(values: readonly string[], sending: ReadonlySet<string>): number | undefined {
  let next: number | undefined;
  const soonest = (at: number) => (next = next === undefined ? at : Math.min(next, at));
  for (const value of values) {
    const r = parse(value);
    if (!r)
      soonest(0); // an unreadable row is purged by the next run
    else if (r.state === 'queued') soonest(Math.max(r.undoUntil, r.notBefore ?? 0));
    // A send under way in this process needs no wake-up (its own finish moves the record on); one a dead run left does.
    else if (r.state === 'syncing') {
      if (!sending.has(r.opId)) soonest(0);
    }
    // A failed hold stays until it is retried or dismissed — it is never purged.
    else if (r.state !== 'failed') soonest((r.finishedAt ?? r.createdAt) + HOLD_KEEP_MS);
  }
  return next;
}

export function createHolds(deps: Deps) {
  // Sends in this process: a `syncing` record NOT in here is one a previous run never finished.
  const inflight = new Set<string>();
  return {
    nextDue: (values: readonly string[]) => nextDue(values, inflight),
    async hold(spec: HoldSpec): Promise<Receipt> {
      const now = deps.clock.now();
      const record: HoldRecord = {
        opId: spec.opId,
        method: spec.method,
        scope: 'send',
        targets: spec.targets,
        call: spec.call,
        state: 'queued',
        createdAt: now,
        undoUntil: now + (spec.windowMs ?? undoSeconds(deps.store) * 1000),
        appliedState: stateOf(deps.store),
      };
      const same = readRecord(deps.store, spec.opId);
      // The same op id again is the same change (a replay): answer its receipt, never a second hold.
      if (same)
        return {
          opId: same.opId,
          appliedState: same.appliedState,
          undoable: same.state === 'queued',
          ...(same.state === 'queued' ? { undoUntil: same.undoUntil } : {}),
        };
      const target = targetOf(spec.call);
      if (
        target &&
        readAll(deps.store).records.some(
          r => (r.state === 'queued' || r.state === 'syncing') && clash(targetOf(r.call), target),
        )
      )
        throw new ContractError({
          type: 'conflict',
          message:
            'Your earlier change to this event has not been sent yet. Undo it, or wait a moment and try again.',
          reasonCode: 'calendar.holdPending',
        });
      save(deps, record);
      return {
        opId: spec.opId,
        appliedState: stateOf(deps.store),
        undoable: true,
        undoUntil: record.undoUntil,
      };
    },

    get(opIds: readonly string[]): Operation[] {
      return opIds.flatMap(id => {
        const r = readRecord(deps.store, id);
        return r ? [operationOf(r, deps.clock.now())] : [];
      });
    },

    undo(args: Input<'Operation/undo'>, caller: Caller): Receipt {
      const r = readRecord(deps.store, args.opId);
      if (!r)
        throw new ContractError({
          type: 'notFound',
          message: 'This change can no longer be undone.',
        });
      // FR-3: undoing needs the scope of the method that made it, not only the cheap one `Operation/undo` itself needs.
      requireOriginating(caller, { scope: r.scope, method: r.method });
      if (r.state === 'cancelled') throw conflict('This change was already undone.');
      if (r.state === 'syncing' || r.state === 'synced')
        throw conflict('This change has been sent, so it cannot be undone.');
      // Its answer was lost: the change may already be at Google, so "undone" would be a claim nobody can keep.
      if (r.state === 'failed' && r.error?.reasonCode === 'calendar.uncertain')
        throw conflict(
          'This change may already have been sent, so it cannot be undone. Check the calendar.',
        );
      save(deps, { ...r, state: 'cancelled' });
      return { opId: args.undoOpId, appliedState: stateOf(deps.store), undoable: false };
    },

    async retry(args: Input<'Operation/retry'>, caller: Caller): Promise<Receipt> {
      const r = readRecord(deps.store, args.opId);
      if (!r)
        throw new ContractError({
          type: 'notFound',
          message: 'This change is no longer in the queue.',
        });
      requireOriginating(caller, { scope: r.scope, method: r.method });
      if (r.state === 'cancelled')
        throw conflict('This change was undone, so it cannot be retried.');
      if (r.state !== 'failed') throw conflict('Only a failed change can be retried.');
      // An uncertain change may already be at Google (and its guests told): a second send could tell them twice. The
      // owner checks the calendar and makes the change again if it is missing.
      if (r.error?.reasonCode === 'calendar.uncertain')
        throw new ContractError({
          type: 'conflict',
          message:
            'Check your calendar: this change may already have gone through. Make it again if it is missing.',
          reasonCode: 'calendar.checkFirst',
        });
      // Never beside a send already under way in this process (a second press while the first is out).
      if (inflight.has(r.opId)) throw conflict('That change is being sent.');
      await send(deps, r, inflight);
      return { opId: args.opId, appliedState: stateOf(deps.store), undoable: false };
    },

    /** Sends every hold whose window has ended (also after a restart), fails the stale and the unfinished, purges the old. */
    async runDue(now: number): Promise<void> {
      const { records, unreadable } = readAll(deps.store);
      for (const key of unreadable)
        deps.store.commit({
          opId: `calendar-hold:purge:${globalThis.crypto.randomUUID()}`,
          origin: 'local',
          writes: [{ kind: 'meta', key, value: null }],
        });
      for (const listed of records) {
        // Re-read EVERY record before acting: an undo, or a Retry that finished, while an earlier hold was sending
        // changes this one, and the snapshot above would put a sent change back as failed (and its call back in meta).
        const r = readRecord(deps.store, listed.opId);
        if (!r) continue;
        const fresh = r;
        if (fresh.state === 'queued' && fresh.undoUntil <= now && (fresh.notBefore ?? 0) <= now) {
          if (now - fresh.undoUntil > HOLD_LATE_MS || startedBy(deps.store, fresh.call, now))
            save(deps, {
              ...fresh,
              state: 'failed',
              error: {
                type: 'unavailable',
                message:
                  'This change was not sent in time (Aplos was closed, or the event has already started). Check the event, then press Retry to send it now.',
                reasonCode: 'calendar.late',
              },
            });
          else await send(deps, fresh, inflight);
        }
        // A send the previous run never finished may or may not have reached Google: never sent twice.
        else if (r.state === 'syncing' && !inflight.has(r.opId))
          save(deps, {
            ...r,
            state: 'failed',
            error: {
              type: 'unavailable',
              message:
                'Google Calendar did not answer, so Aplos cannot tell whether the change was saved. Check the calendar before trying again.',
              reasonCode: 'calendar.uncertain',
            },
          });
        else if (
          (r.state === 'synced' || r.state === 'cancelled') &&
          (r.finishedAt ?? r.createdAt) < now - HOLD_KEEP_MS
        )
          deps.store.commit({
            opId: `calendar-hold:${r.opId}:purge:${globalThis.crypto.randomUUID()}`,
            origin: 'local',
            writes: [{ kind: 'meta', key: keyOf(r.opId), value: null }],
          });
      }
    },
  };
}
