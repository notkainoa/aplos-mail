import type { AdapterContext, ScopeId } from '@aplos/engine/ports';
import type { FetchOutcome } from './sync';

/**
 * provider_memory: fetch entry -> failed attempts, as JSON. Only failures of the entry's own part count (a transient
 * part error or `invalidResponse`); a pause or refusal stops the step and says nothing about the entry. Shared by
 * history and the list scopes, so an entry failing in both counts once per attempt.
 */
export const FAILURES_KEY = 'fetch.failures';
/** Failed attempts after which an entry is quarantined instead of holding back its cursor or round. */
export const MAX_ATTEMPTS = 3;
/** Entries remembered at most; the oldest are forgotten first. */
const KEEP = 500;
/** One failure counts per entry per interval, so a short 5xx spell cannot quarantine a healthy message. */
export const COUNT_INTERVAL_MS = 5 * 60_000;
/** A count with no new failure for this long is forgotten (the entry left the page or round, or got better). */
const FORGET_MS = 6 * 60 * 60_000;

/**
 * provider_memory: the retry schedule of quarantined entries, as JSON. Nothing else retries a quarantined message (the
 * engine only records it), so the adapter does: an entry that hit `MAX_ATTEMPTS` is tried again after a back-off counted
 * in sync passes (history polls), never in time, so an idle or paused account spends nothing and no loop can spin.
 */
export const RETRY_KEY = 'quarantine.retry';
/** The step that does the retrying: a provider-private scope, quiet like backfill. */
export const RETRY_SCOPE: ScopeId = 'provider:quarantine';
/** A quarantined entry is tried again at most this many times, then left to the engine's record (and a manual sync). */
export const MAX_RETRIES = MAX_ATTEMPTS;
/** Entries tried per retry step. */
export const RETRY_BATCH = 2;
/** Passes before the first retry; it doubles with every failed retry (2, 4, 8). */
const BACKOFF_PASSES = 2;
const RETRY_KEEP = 200;

export interface RetryEntry {
  tries: number;
  /** The pass number at which the entry is next due. */
  due: number;
}

export interface RetrySchedule {
  pass: number;
  items: Record<string, RetryEntry>;
}

export const retryBackoff = (tries: number): number => BACKOFF_PASSES * 2 ** tries;

/** The schedule as of this step: a write already made in this step (`pending`) wins over the committed value. */
export function readSchedule(
  memory: ReadonlyMap<string, string>,
  pending: Record<string, string | null> = {},
): RetrySchedule {
  const raw = RETRY_KEY in pending ? pending[RETRY_KEY] : memory.get(RETRY_KEY);
  try {
    const parsed = JSON.parse(raw ?? '') as RetrySchedule;
    return { pass: Number(parsed.pass) || 0, items: parsed.items ?? {} };
  } catch {
    return { pass: 0, items: {} };
  }
}

export function scheduleWrite(schedule: RetrySchedule): Record<string, string | null> {
  const keys = Object.keys(schedule.items);
  for (const key of keys.slice(0, Math.max(0, keys.length - RETRY_KEEP)))
    delete schedule.items[key];
  return { [RETRY_KEY]: Object.keys(schedule.items).length ? JSON.stringify(schedule) : null };
}

/** Entries due now, oldest first, at most one batch. */
export function dueRetries(schedule: RetrySchedule): string[] {
  return Object.entries(schedule.items)
    .filter(([, e]) => e.due <= schedule.pass)
    .sort(([, a], [, b]) => a.due - b.due)
    .slice(0, RETRY_BATCH)
    .map(([entry]) => entry);
}

/** One history pass went by: counts toward every entry's back-off. A no-op while nothing is quarantined. */
export function passWrites(
  memory: ReadonlyMap<string, string>,
  pending: Record<string, string | null>,
): Record<string, string | null> {
  const schedule = readSchedule(memory, pending);
  if (!Object.keys(schedule.items).length) return {};
  schedule.pass++;
  return scheduleWrite(schedule);
}

interface Count {
  n: number;
  at: number;
}

function readCounts(memory: ReadonlyMap<string, string>, now: number): Map<string, Count> {
  try {
    const parsed = JSON.parse(memory.get(FAILURES_KEY) ?? '{}') as Record<string, Count>;
    const live = Object.entries(parsed).filter(([, c]) => c && now - c.at < FORGET_MS);
    return new Map(live);
  } catch {
    return new Map();
  }
}

function countWrites(
  counts: Map<string, Count>,
  memory: ReadonlyMap<string, string>,
): Record<string, string | null> {
  while (counts.size > KEEP) counts.delete(counts.keys().next().value!);
  const json = counts.size ? JSON.stringify(Object.fromEntries(counts)) : null;
  return json === (memory.get(FAILURES_KEY) ?? null) ? {} : { [FAILURES_KEY]: json };
}

/**
 * Counts this fetch's own failures and forgets the entries of `attempted` that settled. An entry that has now failed
 * `MAX_ATTEMPTS` times leaves `pending` for `quarantine` (the engine records it and backs off), so one message that
 * always fails never holds the history cursor or an Inbox round in place. Updates `outcome` in place and returns the
 * provider_memory writes. The log line carries the classified error and the attempt count only, never content.
 */
export function settleFailures(
  ctx: AdapterContext,
  outcome: FetchOutcome,
  attempted: readonly string[],
  pending: Record<string, string | null> = {},
): Record<string, string | null> {
  const now = ctx.clock.now();
  const counts = readCounts(ctx.memory, now);
  const waiting = new Set(outcome.pending);
  for (const entry of attempted) {
    if (!waiting.has(entry)) counts.delete(entry);
  }
  const given = new Set<string>();
  const schedule = readSchedule(ctx.memory, pending);
  for (const { entry, item, error } of outcome.failed) {
    const prior = counts.get(entry);
    const attempts = prior && now - prior.at < COUNT_INTERVAL_MS ? prior.n : (prior?.n ?? 0) + 1;
    counts.delete(entry);
    if (attempts < MAX_ATTEMPTS) {
      counts.set(entry, { n: attempts, at: prior && attempts === prior.n ? prior.at : now });
      continue;
    }
    given.add(entry);
    schedule.items[entry] = { tries: 0, due: schedule.pass + retryBackoff(0) };
    outcome.quarantine.push({ item, error });
    ctx.log.event('sync.gmail.request_refused', { error, attempt: attempts });
  }
  if (given.size) outcome.pending = outcome.pending.filter(entry => !given.has(entry));
  return { ...countWrites(counts, ctx.memory), ...(given.size ? scheduleWrite(schedule) : {}) };
}
