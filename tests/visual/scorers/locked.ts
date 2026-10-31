import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Deleting a state from states.ts, or an id from taste.sample.json, would shrink what a scorer
// looks at. locked-states.json lists every state id that must stay (`states`, sorted) and the ids
// the taste sample must keep (`lockedSample`). New states and sample ids may be added freely;
// growing the lists is an owner / ui-core change.

export const LOCKED_FILE = join(import.meta.dirname, 'locked-states.json');

export interface Locked {
  states: string[];
  lockedSample: string[];
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string'))
    throw new Error(`locked-states.json "${name}" must be a list of strings`);
  return value as string[];
}

export function loadLocked(file = LOCKED_FILE): Locked {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  return {
    states: stringList(parsed.states, 'states'),
    lockedSample: stringList(parsed.lockedSample, 'lockedSample'),
  };
}

/** The locked ids that are not in `present`, in locked order. Pure. */
export function missingLocked(locked: readonly string[], present: Iterable<string>): string[] {
  const have = new Set(present);
  return locked.filter(id => !have.has(id));
}

/** Throws (so the scorer exits 1 with no score line) when a locked state is gone from states.ts. */
export function assertStatesLocked(ids: Iterable<string>, locked = loadLocked()): void {
  const missing = missingLocked(locked.states, ids);
  if (missing.length > 0)
    throw new Error(`locked states missing from states.ts: ${missing.join(', ')}`);
}

/** Throws when a locked sample id is gone from taste.sample.json. */
export function assertSampleLocked(sample: Iterable<string>, locked = loadLocked()): void {
  const missing = missingLocked(locked.lockedSample, sample);
  if (missing.length > 0)
    throw new Error(`locked ids missing from taste.sample.json: ${missing.join(', ')}`);
}
