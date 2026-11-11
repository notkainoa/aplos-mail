import type { ErrorBody, Input, Operation, Receipt } from '@aplos/contract';
import { requireOriginating } from '@aplos/contract/access';
import { ContractError } from '@aplos/contract/contract-error';
import type { Caller } from '../methods/types';
import { instant, recurrenceIdToTime } from './project';
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
  const start = startOf(store, call);
  return start !== undefined && start <= now;
}

function startOf(store: StorePort, call: HeldCall): number | undefined {
  if (call.op === 'put' && call.change.fields.start)
    return instant(call.change.fields.start, 'UTC');
  const ref = call.op === 'put' ? call.change : call.ref;
  const remoteId = ref.remoteId;
  if (!remoteId) return undefined;
  // One occurrence: its own original start; otherwise the stored start of the event.
  if (ref.recurrenceId) return instant(recurrenceIdToTime(ref.recurrenceId), 'UTC');
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

/** What a hold changes: the same event (or occurrence) twice at once would make the second meet the first's new version. */
function targetOf(call: HeldCall | undefined): string | undefined {
  if (!call) return undefined;
  const ref = call.op === 'put' ? call.change : call.ref;
  if (!ref.remoteId) return undefined; // a create has no event yet
  return [call.account, ref.calendarRemoteId, ref.remoteId, ref.recurrenceId ?? ''].join('|');
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
  changed(): void;
}

function save(deps: Deps, record: HoldRecord): void {
  // Finished for good (sent or undone): the guests' addresses leave storage with the call.
  const kept =
    record.state === 'synced' || record.state === 'cancelled'
      ? (({ call: _call, ...rest }) => rest)(record)
      : record;
  deps.store.commit({
    // A meta-only commit does not move `seq`, so the id carries its own uniqueness: a repeated id is skipped as already
    // applied, which once dropped a second save of the same state.
    opId: `calendar-hold:${record.opId}:${record.state}:${globalThis.crypto.randomUUID()}`,
    origin: 'local',
    writes: [{ kind: 'meta', key: keyOf(record.opId), value: JSON.stringify(kept) }],
  });
  deps.changed();
}

function operationOf(r: HoldRecord): Operation {
  return {
    opId: r.opId,
    kind: r.method,
    targets: r.targets,
    state: r.state,
    appliedState: r.appliedState,
    ...(r.error ? { error: r.error } : {}),
    undoable: r.state === 'queued',
    ...(r.state === 'queued' ? { undoUntil: r.undoUntil } : {}),
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
  try {
    const result = await runCall(deps.calendar, record.call);
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
  } catch (error) {
    deps.log.event('rpc.failed', { method: record.method, reason: 'calendarHoldFailed' });
    save(deps, { ...syncing, state: 'failed', error: bodyOf(error) });
  }
}

const conflict = (message: string) => new ContractError({ type: 'conflict', message });

/** The earliest moment a hold needs the loop: a window's end, an unfinished send (now), or a finished hold's purge. */
function nextDue(values: readonly string[]): number | undefined {
  let next: number | undefined;
  const soonest = (at: number) => (next = next === undefined ? at : Math.min(next, at));
  for (const value of values) {
    const r = parse(value);
    if (!r)
      soonest(0); // an unreadable row is purged by the next run
    else if (r.state === 'queued') soonest(r.undoUntil);
    else if (r.state === 'syncing') soonest(0);
    else soonest(r.createdAt + HOLD_KEEP_MS);
  }
  return next;
}

export function createHolds(deps: Deps) {
  // Sends in this process: a `syncing` record NOT in here is one a previous run never finished.
  const inflight = new Set<string>();
  return {
    nextDue,
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
          r => (r.state === 'queued' || r.state === 'syncing') && targetOf(r.call) === target,
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
        return r ? [operationOf(r)] : [];
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
        if (fresh.state === 'queued' && fresh.undoUntil <= now) {
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
        else if (r.state !== 'queued' && r.state !== 'syncing' && r.createdAt < now - HOLD_KEEP_MS)
          deps.store.commit({
            opId: `calendar-hold:${r.opId}:purge:${globalThis.crypto.randomUUID()}`,
            origin: 'local',
            writes: [{ kind: 'meta', key: keyOf(r.opId), value: null }],
          });
      }
    },
  };
}
