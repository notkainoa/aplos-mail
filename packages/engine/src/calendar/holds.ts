import type { ErrorBody, Input, Operation, Receipt } from '@aplos/contract';
import { requireOriginating } from '@aplos/contract/access';
import { ContractError } from '@aplos/contract/contract-error';
import type { Caller } from '../methods/types';
import type { Clock, Logger, StorePort } from '../ports';
import { parseStored, withDefaults } from '../runtime/settings';
import type { EngineServices } from '../runtime/services';
import { runCall } from './holds-call';
import type { HoldRecord, HoldSpec } from './holds-types';

/**
 * The working half of the calendar holds (lazy, loaded on the first held write or the first due hold). A hold is a
 * calendar write that tells guests: it waits its undo window as data in `meta`, then is sent through the
 * `CalendarPort` like any write. Undo cancels it while it waits (the provider never hears of it); once sent there is
 * no inverse, so undo answers `conflict` instead of claiming to restore. Nothing is a delayed commit.
 */

export const HOLD_PREFIX = 'calendar.hold.';
/** Finished records stay readable for `Operation/get` this long. */
const KEEP_MS = 24 * 60 * 60 * 1000;

const keyOf = (opId: string) => `${HOLD_PREFIX}${opId}`;

export function readRecord(store: StorePort, opId: string): HoldRecord | undefined {
  const row = store.read(q =>
    q.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', keyOf(opId)),
  );
  return row ? (JSON.parse(row.value) as HoldRecord) : undefined;
}

export function readAll(store: StorePort): HoldRecord[] {
  return store
    .read(q =>
      q.all<{ value: string }>('SELECT value FROM meta WHERE key LIKE ?', `${HOLD_PREFIX}%`),
    )
    .map(r => JSON.parse(r.value) as HoldRecord);
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
  deps.store.commit({
    opId: `calendar-hold:${record.opId}:${record.state}:${deps.store.seq()}`,
    origin: 'local',
    writes: [{ kind: 'meta', key: keyOf(record.opId), value: JSON.stringify(record) }],
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
  inflight.add(record.opId);
  try {
    await sendNow(deps, record);
  } finally {
    inflight.delete(record.opId);
  }
}

async function sendNow(deps: Deps, record: HoldRecord): Promise<void> {
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

export function createHolds(deps: Deps) {
  // Sends in this process: a `syncing` record NOT in here is one a previous run never finished.
  const inflight = new Set<string>();
  return {
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
      if (readRecord(deps.store, spec.opId)) throw conflict('This change was already made.');
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
      await send(deps, r, inflight);
      return { opId: args.opId, appliedState: stateOf(deps.store), undoable: false };
    },

    /** Sends every hold whose window has ended (also after a restart: a window that ran out while the app was closed). */
    async runDue(now: number): Promise<void> {
      for (const r of readAll(deps.store)) {
        // Re-read: an undo that landed while an earlier hold was sending must stop this one.
        const fresh = r.state === 'queued' ? readRecord(deps.store, r.opId) : r;
        if (fresh?.state === 'queued' && fresh.undoUntil <= now) await send(deps, fresh, inflight);
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
        else if (r.state !== 'queued' && r.createdAt < now - KEEP_MS)
          deps.store.commit({
            opId: `calendar-hold:${r.opId}:purge`,
            origin: 'local',
            writes: [{ kind: 'meta', key: keyOf(r.opId), value: null }],
          });
      }
    },
  };
}
