import { createHash } from 'node:crypto';
import type { CommitInput, WorkflowFields, WorkflowWrite } from '@aplos/engine/store';
import {
  canonical,
  compareStamp,
  THREAD_PREFIX,
  type JsonValue,
  type Stamp,
  type WorkflowRecord,
} from './workflow-merge';

/**
 * Workflow facts for the engine: the channel's winning `thread:<id>` records as store `WorkflowWrite`s (`thread_workflow`
 * patches carrying `edited_at`, `edit_device` and `edit_gen`), committed with an op id derived from their content, so a
 * replayed round commits once (the store treats a known op id as a no-op). Only what M29 syncs travels: status, Later,
 * due date, reminder and whether it fired, reply status, todo and hidden-from-Home. Ranking, lanes, bookmarks and the
 * due source stay per device.
 *
 * A record is a whole snapshot of the synced fields: a field it does not carry is cleared (New, nothing else set), so a
 * replica that applies only the latest record ends exactly where one that applied every record in turn does.
 */

export { THREAD_PREFIX };

export type SyncedFields = Pick<
  WorkflowFields,
  | 'status'
  | 'laterUntil'
  | 'dueDate'
  | 'reminderAt'
  | 'reminderFiredAt'
  | 'replyStatus'
  | 'todo'
  | 'hiddenFromHome'
>;

/** What a synced field is when a record does not carry it. */
const CLEARED: SyncedFields = {
  status: 'new',
  laterUntil: null,
  dueDate: null,
  reminderAt: null,
  reminderFiredAt: null,
  replyStatus: null,
  todo: null,
  hiddenFromHome: null,
};

const STATUSES: ReadonlySet<string> = new Set(['new', 'done', 'later']);
const MAX_TEXT = 4_000;

type Check = (v: unknown) => boolean;
const time: Check = v => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
const text: Check = v => v === null || (typeof v === 'string' && v.length <= MAX_TEXT);
const flag: Check = v => v === null || typeof v === 'boolean';

const CHECKS: Record<keyof SyncedFields, Check> = {
  status: v => typeof v === 'string' && STATUSES.has(v),
  laterUntil: time,
  dueDate: text,
  reminderAt: time,
  reminderFiredAt: time,
  replyStatus: text,
  todo: text,
  hiddenFromHome: flag,
};

export const threadKey = (remoteThreadId: string) => `${THREAD_PREFIX}${remoteThreadId}`;

/** The record value for a thread's synced fields (what a local edit publishes). */
export function threadValue(fields: Partial<SyncedFields>): JsonValue {
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(CHECKS) as (keyof SyncedFields)[])
    if (fields[key] !== undefined) out[key] = fields[key] as JsonValue;
  return out;
}

/**
 * The synced fields of a record value, or undefined when any field is unknown or ill-typed: the store fails a whole
 * commit on a bad value, so one hostile or newer-format record must never reach it.
 */
export function parseThreadValue(value: JsonValue): Partial<SyncedFields> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    // Own keys only: `toString`, `__proto__` and the like are field names a foreign writer can send, not checks.
    if (!Object.hasOwn(CHECKS, key)) return undefined;
    const check = CHECKS[key as keyof SyncedFields];
    if (!check(v)) return undefined;
    out[key] = v;
  }
  return Object.keys(out).length ? (out as Partial<SyncedFields>) : undefined;
}

export interface FactsInput {
  accountId: string;
  /** Winning records (the channel's view, or a round's `changed`). Non-thread keys are ignored. */
  records: readonly WorkflowRecord[];
  /** Remote thread ids the store has: a write for an unknown thread would fail the whole commit. */
  known: ReadonlySet<string>;
  /** The stored edit stamp per remote thread id (`edited_at`, `edit_gen`, `edit_device`), absent when never edited. */
  local: ReadonlyMap<string, Stamp>;
}

export interface WorkflowFacts {
  writes: WorkflowWrite[];
  /** Records skipped because their thread is not stored yet; they apply on a later round once it is. */
  deferred: number;
  /** Records whose value was refused. */
  invalid: number;
}

function factFor(
  input: FactsInput,
  record: WorkflowRecord,
): WorkflowWrite | 'deferred' | 'invalid' | undefined {
  const remoteThreadId = record.key.slice(THREAD_PREFIX.length);
  if (!remoteThreadId) return 'invalid';
  const patch = parseThreadValue(record.value);
  if (!patch) return 'invalid';
  if (!input.known.has(remoteThreadId)) return 'deferred';
  const local = input.local.get(remoteThreadId);
  if (local && compareStamp(record.stamp, local) <= 0) return undefined;
  return {
    kind: 'workflow',
    accountId: input.accountId,
    remoteThreadId,
    patch: {
      ...CLEARED,
      ...patch,
      // The due source is per device, but a cleared due date has none.
      ...(patch.dueDate == null ? { dueSource: null } : {}),
      editedAt: record.stamp.at,
      editGen: record.stamp.gen,
      editDevice: record.stamp.device,
    },
  };
}

/** The writes a set of winning records implies: newer than the stored edit, for stored threads, valid values only. */
export function workflowFacts(input: FactsInput): WorkflowFacts {
  const out: WorkflowFacts = { writes: [], deferred: 0, invalid: 0 };
  for (const record of input.records) {
    if (!record.key.startsWith(THREAD_PREFIX)) continue;
    const fact = factFor(input, record);
    if (fact === 'deferred') out.deferred++;
    else if (fact === 'invalid') out.invalid++;
    else if (fact) out.writes.push(fact);
  }
  out.writes.sort((a, b) => (a.remoteThreadId < b.remoteThreadId ? -1 : 1));
  return out;
}

/** The op id of a set of writes: the same facts always map to the same id, whatever round produced them. */
export function workflowOpId(accountId: string, writes: readonly WorkflowWrite[]): string {
  const hash = createHash('sha256').update(accountId);
  for (const w of writes)
    hash.update('\n').update(canonical({ t: w.remoteThreadId, p: w.patch as JsonValue }));
  return `workflow:${hash.digest('base64url').slice(0, 32)}`;
}

/** One store commit for the facts, or undefined when there is nothing to write. */
export function workflowCommit(accountId: string, facts: WorkflowFacts): CommitInput | undefined {
  if (!facts.writes.length) return undefined;
  return {
    opId: workflowOpId(accountId, facts.writes),
    origin: 'sync',
    step: 'workflow',
    writes: facts.writes,
  };
}
