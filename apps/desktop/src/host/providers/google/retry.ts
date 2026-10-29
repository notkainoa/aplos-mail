import type {
  AdapterContext,
  PlannedStep,
  Quarantine,
  StepResult,
  SyncState,
} from '@aplos/engine/ports';
import { GmailClient } from './client';
import {
  MAX_RETRIES,
  RETRY_SCOPE,
  dueRetries,
  exhaust,
  readSchedule,
  retryBackoff,
  scheduleWrite,
  type RetrySchedule,
} from './failures';
import { entryThread, fetchMetadata, type FetchOutcome, type SyncRuntime } from './sync';

/**
 * The retry of quarantined messages (G-A). A message that failed `MAX_ATTEMPTS` times is quarantined so it cannot hold
 * a cursor or a round, but the engine only records it; this step is what tries it again. It is a quiet `backfill` step
 * (never a notification), planned only when an entry is due by sync passes (`failures.ts`), takes at most `RETRY_BATCH`
 * entries, makes one attempt each and backs off further (2, 4, 8 passes) on every failure, then gives up after
 * `MAX_RETRIES`. A pause or refusal costs the entry nothing: it is due again one pass later.
 */
/** The schedule after one answered attempt: done entries leave it, failed ones back off or are given up on. */
function settle(schedule: RetrySchedule, fetched: FetchOutcome, log: AdapterContext['log']): void {
  const failed = new Map(fetched.failed.map(f => [f.entry, f.error]));
  const answered = [...fetched.byEntry.keys(), ...fetched.missing];
  const permanent = fetched.quarantine.map(q => q.item);
  for (const entry of Object.keys(schedule.items)) {
    const item = entryThread(entry) ?? entry;
    if (answered.includes(entry) || permanent.includes(item)) delete schedule.items[entry];
    else if (failed.has(entry)) backOff(schedule, entry, failed.get(entry)!, log);
    else if (fetched.pending.includes(entry)) schedule.items[entry].due = schedule.pass + 1;
  }
}

function backOff(
  schedule: RetrySchedule,
  entry: string,
  error: Quarantine['error'],
  log: AdapterContext['log'],
): void {
  const tries = schedule.items[entry].tries + 1;
  if (tries >= MAX_RETRIES) {
    exhaust(schedule, entry);
    log.event('sync.gmail.request_refused', { error, attempt: tries });
    return;
  }
  schedule.items[entry] = { tries, due: schedule.pass + retryBackoff(tries) };
}

export async function retryStep(
  rt: SyncRuntime,
  _step: PlannedStep,
  state: SyncState,
  ctx: AdapterContext,
): Promise<StepResult> {
  const schedule = readSchedule(ctx.memory);
  const entries = dueRetries(schedule).filter(entry => entry in schedule.items);
  const next: SyncState = {
    ...state,
    scope: RETRY_SCOPE,
    generation: ctx.generation,
    updatedAt: ctx.clock.now(),
  };
  if (!entries.length) return { nextStates: [next], done: true, costUnits: 0 };
  const client = new GmailClient(rt.deps, ctx);
  const fetched = await fetchMetadata(client, entries, {
    lane: 'backfill',
    self: ctx.account.address,
    now: ctx.clock.now(),
  });
  settle(schedule, fetched, ctx.log);
  // A retry that succeeds should also clear the engine's `sync_failures` row (a store write with `failure: null`), but
  // `StepResult` has no field for that yet (a port change for eng-contract and prov-gov), so the row keeps its count.
  const again: Quarantine[] = fetched.failed.map(({ item, error }) => ({ item, error }));
  const quarantine = [...fetched.quarantine, ...again];
  return {
    ...(fetched.facts.length ? { upserts: fetched.facts } : {}),
    ...(quarantine.length ? { quarantine } : {}),
    nextStates: [next],
    memory: scheduleWrite(schedule),
    done: !fetched.stopped,
    costUnits: client.spent,
  };
}
