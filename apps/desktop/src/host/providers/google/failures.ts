import type { AdapterContext } from '@aplos/engine/ports';
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

function readCounts(memory: ReadonlyMap<string, string>): Map<string, number> {
  try {
    const parsed = JSON.parse(memory.get(FAILURES_KEY) ?? '{}') as Record<string, number>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function countWrites(
  counts: Map<string, number>,
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
): Record<string, string | null> {
  const counts = readCounts(ctx.memory);
  const pending = new Set(outcome.pending);
  for (const entry of attempted) {
    if (!pending.has(entry)) counts.delete(entry);
  }
  const given = new Set<string>();
  for (const { entry, item, error } of outcome.failed) {
    const attempts = (counts.get(entry) ?? 0) + 1;
    counts.delete(entry);
    if (attempts < MAX_ATTEMPTS) {
      counts.set(entry, attempts);
      continue;
    }
    given.add(entry);
    outcome.quarantine.push({ item, error });
    ctx.log.event('sync.gmail.request_refused', { error, attempt: attempts });
  }
  if (given.size) outcome.pending = outcome.pending.filter(entry => !given.has(entry));
  return countWrites(counts, ctx.memory);
}
