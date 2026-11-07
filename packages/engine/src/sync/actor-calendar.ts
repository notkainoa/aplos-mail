import type { AdapterContext, PlannedStep, PlanTrigger, ScopeId, SyncState } from '../ports';
import { PausedError, ProviderError, NotSentError } from '../ports';
import type { ClassifiedError } from '@aplos/contract';
import type { ActorDeps } from './actor';
import {
  CAL_SYNC_MEMORY_KEY,
  calendarListWrites,
  calendarStepWrites,
  parseSyncSet,
} from './calendar-facts';
import { readFailures, readMemory } from './persist';

// The account actor's calendar steps (D12): `calendars` and `cal:<id>` run on the adapter's calendar half with their
// own result type, commit path and per-calendar state — never as the mail status. Kept out of actor.ts for its
// max-lines budget; `actor` is the narrow seam of the actor's internals this needs.

export interface CalendarActor {
  readonly deps: ActorDeps;
  readonly stopped: boolean;
  readonly log: ActorDeps['log'];
  readonly backoff: Map<ScopeId, { failures: number; until: number }>;
  forced: boolean;
  calendarScopeGap?: string[];
  context(): AdapterContext;
  tick(): AbortController;
  holdScope(step: PlannedStep, until: number | undefined): void;
  setTrigger(trigger: PlanTrigger): void;
  refreshMissingPermissions(): void;
  calendarScopeRefused(
    step: PlannedStep,
    classified: ClassifiedError | undefined,
    now: number,
  ): void;
  markCalendar(
    remoteId: string,
    entry: {
      state: 'ok' | 'paused' | 'error';
      until?: number;
      reason?: string;
      reasonCode?: import('@aplos/contract').ReasonCode;
    },
  ): void;
  calendarsOk(remoteIds: string[]): void;
}

function classifiedOf(error: unknown): ClassifiedError | undefined {
  if (error instanceof ProviderError || error instanceof NotSentError) return error.error;
  return undefined;
}

const STEP_BACKOFF_MS = 30_000;
const STEP_BACKOFF_MAX_MS = 900_000;

/** A `calendars` or `cal:<id>` step: list or one calendar's events page, committed with its resume token. */
export async function runCalendarStep(
  actor: CalendarActor,
  step: PlannedStep,
  state: SyncState,
): Promise<void> {
  const { store, clock, adapter } = actor.deps;
  const calendar = adapter.calendar;
  if (!calendar) return; // A plan cannot emit these without a calendar half.
  const fence = store.seq();
  const ctx = { ...actor.context(), generation: fence };
  actor.forced = false;
  const ticker = actor.tick();
  try {
    if (step.scope === 'calendars') {
      const result = await calendar.listCalendars(state.cursor ? state : undefined, ctx);
      ticker.abort();
      if (actor.stopped) return;
      actor.backoff.delete(step.scope);
      actor.calendarsOk(result.calendars.map(c => c.remoteId));
      store.commit({
        opId: actor.deps.newId(),
        origin: 'sync',
        step: step.origin,
        fenceSeq: fence,
        changes: 'fine',
        writes: [
          ...calendarListWrites(
            actor.deps.account.id,
            result,
            parseSyncSet(readMemory(store, actor.deps.account.id).get(CAL_SYNC_MEMORY_KEY)),
          ),
          // The list is in, even when it is empty: "No calendars" is now different from "Syncing…". First list wins.
          { kind: 'account', id: actor.deps.account.id, calendarListedAt: clock.now() },
        ],
      });
    } else {
      const calendarRemoteId = step.scope.slice(4);
      const result = await calendar.syncStep(calendarRemoteId, state, step.lane, ctx);
      ticker.abort();
      if (actor.stopped) return;
      const now = clock.now();
      const failures = readFailures(
        store,
        actor.deps.account.id,
        (result.quarantine ?? []).map(q => q.item),
      );
      actor.backoff.delete(step.scope);
      actor.markCalendar(calendarRemoteId, { state: 'ok' });
      store.commit({
        opId: actor.deps.newId(),
        origin: 'sync',
        step: step.origin,
        fenceSeq: fence,
        changes: step.origin === 'backfill' ? 'coarse' : 'fine',
        writes: calendarStepWrites(result, {
          account: actor.deps.account,
          calendarRemoteId,
          now,
          failures,
        }),
      });
      if (result.reset) {
        // Logged, not triggered: a calendar resync must not schedule a mail poll (D12). The
        // calendar's own cadence already schedules its next step.
        actor.log.event('sync.gcal.cursor_reset', { reset: result.reset });
      }
    }
  } catch (error) {
    ticker.abort();
    if (!actor.stopped) calendarStepFailed(actor, step, error);
  }
}

/** The classes whose step is held (the governor's pause or the classified retry window), not backed off. */
const HOLDABLE = new Set(['throttle', 'daily', 'auth', 'config', 'anti_abuse']);

/** A calendar step's failure: pauses and errors mark only this calendar; `permission` records the scope gap. */
function calendarStepFailed(actor: CalendarActor, step: PlannedStep, error: unknown): void {
  const remoteId = step.scope === 'calendars' ? undefined : step.scope.slice(4);
  if (error instanceof PausedError) {
    actor.holdScope(step, error.until);
    if (remoteId) actor.markCalendar(remoteId, { state: 'paused', until: error.until });
    return;
  }
  const classified = classifiedOf(error);
  const cls = classified?.class;
  if (cls === 'cancelled') return;
  if (cls === 'permission') {
    // One path for every permission refusal (actor.ts): named scopes record the gap for Settings and
    // the scope backs off — never an account halt. A scope-less error — say, one shared calendar lost
    // access — records no gap but still marks the calendar below.
    actor.calendarScopeRefused(step, classified, actor.deps.clock.now());
    if (remoteId)
      actor.markCalendar(remoteId, { state: 'error', reasonCode: 'permission.calendar' });
    return;
  }
  if (cls && HOLDABLE.has(cls)) {
    const retryAt = classified?.retryAfterMs
      ? actor.deps.clock.now() + classified.retryAfterMs
      : undefined;
    actor.holdScope(step, retryAt);
    if (remoteId)
      actor.markCalendar(remoteId, {
        state: 'paused',
        ...(retryAt !== undefined ? { until: retryAt } : {}),
        ...(cls === 'anti_abuse' ? { reasonCode: 'quota.calendarAbuse' } : {}),
      });
    return;
  }
  backoffCalendar(actor, step, classified, remoteId);
}

/** Transient, permanent and unknown failures back this scope off with jitter; the calendar shows error. */
function backoffCalendar(
  actor: CalendarActor,
  step: PlannedStep,
  classified: ClassifiedError | undefined,
  remoteId: string | undefined,
): void {
  const prior = actor.backoff.get(step.scope)?.failures ?? 0;
  const failures = prior + 1;
  const base = Math.min(STEP_BACKOFF_MAX_MS, STEP_BACKOFF_MS * 2 ** (failures - 1));
  const delay = Math.max(
    Math.round(base * (1 + 0.25 * actor.deps.random())),
    classified?.retryAfterMs ?? 0,
  );
  actor.backoff.set(step.scope, { failures, until: actor.deps.clock.now() + delay });
  if (remoteId)
    actor.markCalendar(remoteId, {
      state: 'error',
      ...(classified?.reason ? { reason: classified.reason } : {}),
    });
}
