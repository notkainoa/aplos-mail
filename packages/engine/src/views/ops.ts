import type { ErrorBody, Operation, Receipt, State } from '@aplos/contract';
import type { FrameBus } from '../runtime/frames';
import type { AccountActorHost, Clock, OpChange, StorePort } from '../ports';
import type { OpEffect, OpWrite, SqlRow, StoreReader, StoreWrite, WorkflowFields } from '../store';
import { opPayload } from '../sync/ops';

/*
 * Operations (views-3, ARCH 4.3). A `Thread/act` is one commit that edits the workflow row and enqueues one `ops` row per
 * message edit (the provider lane drains them one message and one change at a time, `sync/ops.ts`). A `Step` is such an
 * edit and everything its inverse needs, so `Operation/undo` can cancel it while queued or enqueue the inverse after it
 * left. The journal remembers what an operation did for as long as the session lives; the `ops` rows are the durable part.
 */

/** One message edit: a folder move, a flag change, or a trash and untrash. `add` and `remove` are folder remote ids. */
export interface Step {
  remoteId: string;
  change: OpChange;
  add: string[];
  remove: string[];
  /** Flag changes: the values before the edit, for the inverse. */
  was?: FlagChange;
}

type FlagChange = { seen?: boolean; flagged?: boolean };

export const foldersStep = (remoteId: string, add: string[], remove: string[]): Step => ({
  remoteId,
  change: { kind: 'folders', add, remove },
  add,
  remove,
});

export const flagsStep = (remoteId: string, change: FlagChange, was: FlagChange): Step => ({
  remoteId,
  change: { kind: 'flags', ...change },
  add: [],
  remove: [],
  was,
});

/** Moves to Trash; `removed` are the folders it left, which the inverse puts back. */
export const trashStep = (remoteId: string, trash: string, removed: string[]): Step => ({
  remoteId,
  change: { kind: 'trash' },
  add: [trash],
  remove: removed,
});

export const untrashStep = (remoteId: string, trash: string): Step => ({
  remoteId,
  change: { kind: 'untrash' },
  add: [],
  remove: [trash],
});

/** What undoes `step`, in the order to run it. */
export function invertStep(step: Step): Step[] {
  const { remoteId } = step;
  switch (step.change.kind) {
    case 'flags':
      return [flagsStep(remoteId, step.was ?? {}, flagsOf(step.change))];
    case 'trash':
      return [
        untrashStep(remoteId, step.add[0]),
        ...(step.remove.length ? [foldersStep(remoteId, step.remove, [])] : []),
      ];
    case 'untrash':
      return [trashStep(remoteId, step.remove[0], step.add)];
    default:
      return [foldersStep(remoteId, step.remove, step.add)];
  }
}

/** What undoes a whole list of steps: each one's inverse, last step first. */
export const invertSteps = (steps: readonly Step[]): Step[] =>
  [...steps].reverse().flatMap(invertStep);

function flagsOf(change: OpChange): FlagChange {
  const out: FlagChange = {};
  if (change.kind !== 'flags') return out;
  if (change.seen !== undefined) out.seen = change.seen;
  if (change.flagged !== undefined) out.flagged = change.flagged;
  return out;
}

/** The local edit an op carries, replayed over sync until the provider has it (ARCH 4.3). */
export function effectOf(step: Step): OpEffect {
  const target = { remoteId: step.remoteId };
  if (step.change.kind === 'flags') return { kind: 'flags', target, ...flagsOf(step.change) };
  return {
    kind: 'placements',
    target,
    add: step.add.map(folder => ({ folder })),
    remove: step.remove,
  };
}

/** An op's local edit as a plain write, for an op that never left, a failed one given up, or one retried. */
export function writeOfEffect(accountId: string, e: OpEffect): StoreWrite {
  return e.kind === 'flags'
    ? { kind: 'flags', accountId, target: e.target, seen: e.seen, flagged: e.flagged }
    : { kind: 'placements', accountId, target: e.target, add: e.add, remove: e.remove };
}

export const localWrite = (accountId: string, step: Step): StoreWrite =>
  writeOfEffect(accountId, effectOf(step));

// ------------------------------------------------------------ op rows

/**
 * The `ops.op_id` of an operation's n-th message edit. Length-prefixed so no client opId, whatever it holds, can make
 * its rows look like another operation's.
 */
export const rowId = (opId: string, n: number) => `${opId.length}:${opId}#${n}`;

export function opWrite(a: {
  rowId: string;
  method: Operation['kind'];
  scope: string;
  accountId: string;
  threadId: string;
  step: Step;
}): OpWrite {
  return {
    kind: 'op',
    opId: a.rowId,
    accountId: a.accountId,
    opKind: a.method,
    targets: [a.threadId],
    payload: opPayload(a.step.remoteId, a.step.change),
    base: JSON.stringify(a.step),
    effect: [effectOf(a.step)],
    scope: a.scope,
  };
}

export interface OpRow extends SqlRow {
  op_id: string;
  account_id: string;
  kind: string;
  target: string;
  state: string;
  attempts: number;
  last_error: string | null;
  created_seq: number;
  scope: string;
  effect: string | null;
}

const OP_COLS =
  'op_id, account_id, kind, target, state, attempts, last_error, created_seq, scope, effect';

/** The open `ops` rows of an operation, in queue order: its n-th edits, or a row an outside lane enqueued under `opId`. */
export function rowsOf(q: StoreReader, opId: string): OpRow[] {
  const from = `${opId.length}:${opId}#`;
  const edits = q.all<OpRow>(
    `SELECT ${OP_COLS} FROM ops WHERE op_id >= ? AND op_id < ? ORDER BY seq`,
    from,
    `${opId.length}:${opId}$`,
  );
  const own = q.get<OpRow>(`SELECT ${OP_COLS} FROM ops WHERE op_id = ?`, opId);
  return own ? [own, ...edits] : edits;
}

/** The store clock's time of a commit, and its seq, by the opId it was committed under. */
export function commitOf(q: StoreReader, opId: string): { seq: number; at: number } | undefined {
  return q.get<{ seq: number; at: number }>('SELECT seq, at FROM commits WHERE op_id = ?', opId);
}

// ------------------------------------------------------------ the journal

export interface RecordedStep {
  rowId: string;
  accountId: string;
  threadId: string;
  step: Step;
}
export interface RecordedThread {
  accountId: string;
  remoteThreadId: string;
  /** The workflow fields the operation changed, as they were. */
  before: Partial<WorkflowFields>;
}
export interface OpRecord {
  opId: string;
  method: 'Thread/act' | 'Operation/undo';
  scope: string;
  targets: string[];
  seq: number;
  createdAt: number;
  threads: RecordedThread[];
  steps: RecordedStep[];
  /** False for an undo: undoing an undo is a new `Thread/act`. */
  undoable: boolean;
  /** The `undoOpId` that undid it. */
  undone?: string;
}

/** What the journal keeps at most: threads plus steps over all operations. */
const JOURNAL_WEIGHT = 150_000;
const JOURNAL_ENTRIES = 500;

export interface Journal {
  get(opId: string): OpRecord | undefined;
  add(record: OpRecord): void;
}

const weightOf = (r: OpRecord) => 1 + r.threads.length + r.steps.length;

/** A bounded memory of recent operations, oldest dropped first. An operation too big to keep cannot be undone. */
export function createJournal(): Journal {
  const records = new Map<string, OpRecord>();
  let weight = 0;
  const drop = (id: string) => {
    const r = records.get(id);
    if (!r) return;
    weight -= weightOf(r);
    records.delete(id);
  };
  return {
    get: opId => records.get(opId),
    add(record) {
      drop(record.opId);
      if (weightOf(record) > JOURNAL_WEIGHT) return;
      records.set(record.opId, record);
      weight += weightOf(record);
      while (weight > JOURNAL_WEIGHT || records.size > JOURNAL_ENTRIES)
        drop(records.keys().next().value as string);
    },
  };
}

// ------------------------------------------------------------ Operation

const STATE_ORDER = ['failed', 'conflict', 'inflight', 'queued'] as const;
const STATE_NAMES: Record<(typeof STATE_ORDER)[number], Operation['state']> = {
  failed: 'failed',
  conflict: 'conflict',
  inflight: 'syncing',
  queued: 'queued',
};

/** The strongest state among an operation's open rows: one failure shows as failed, one still queued as queued. */
function rowsState(rows: readonly OpRow[]): Operation['state'] | undefined {
  for (const s of STATE_ORDER) if (rows.some(r => r.state === s)) return STATE_NAMES[s];
  return undefined;
}

function stateOf(rec: OpRecord | undefined, rows: readonly OpRow[]): Operation['state'] {
  if (rec?.undone) return 'cancelled';
  const open = rowsState(rows);
  if (open) return open;
  return rec && rec.steps.length === 0 ? 'applied' : 'synced';
}

function errorOf(rows: readonly OpRow[]): ErrorBody | undefined {
  const bad = rows.find(r => r.state === 'failed' || r.state === 'conflict');
  if (!bad) return undefined;
  return {
    type: bad.state === 'conflict' ? 'conflict' : 'providerError',
    message:
      bad.state === 'conflict'
        ? 'This changed somewhere else too. Try again.'
        : 'This change did not reach your mail account. Try again.',
    ...(bad.last_error ? { reasonCode: bad.last_error } : {}),
  };
}

function targetsOf(rec: OpRecord | undefined, rows: readonly OpRow[]): string[] {
  if (rec) return rec.targets;
  const out = new Set<string>();
  for (const r of rows) for (const t of JSON.parse(r.target) as string[]) out.add(t);
  return [...out];
}

/** The contract `Operation` for an id, or undefined when neither the journal nor the queue knows it. */
export function readOperation(
  q: StoreReader,
  opId: string,
  rec: OpRecord | undefined,
  dbEpoch: string,
): Operation | undefined {
  const rows = rowsOf(q, opId);
  if (!rec && !rows.length) return undefined;
  const first = rows[0];
  const created = commitOf(q, opId);
  const seq = rec?.seq ?? created?.seq ?? Math.min(...rows.map(r => r.created_seq));
  const appliedState: State = { dbEpoch, seq };
  const error = errorOf(rows);
  return {
    opId,
    kind: rec?.method ?? first.kind,
    targets: targetsOf(rec, rows),
    state: stateOf(rec, rows),
    appliedState,
    ...(error ? { error } : {}),
    undoable: !!rec && rec.undoable && !rec.undone,
    createdAt: rec?.createdAt ?? created?.at ?? 0,
    scope: rec?.scope ?? first.scope,
  };
}

// ------------------------------------------------------------ shared by the commands

export interface CommandDeps {
  store: StorePort;
  clock: Clock;
  frames: FrameBus;
  /** The account actors, read when needed: the host may inject them after the engine was built. */
  accounts(): AccountActorHost;
  journal: Journal;
  zone: string;
}

/** The receipt of a commit already applied under `opId`, so a replay answers the same and applies nothing. */
export function priorReceipt(
  deps: CommandDeps,
  opId: string,
  undoable: boolean,
): Receipt | undefined {
  const prior = deps.store.read(q => commitOf(q, opId));
  if (!prior) return undefined;
  return { opId, appliedState: { dbEpoch: deps.store.dbEpoch, seq: prior.seq }, undoable };
}

/** Tells the account actors there is something to drain; an actor that is not running yet drains it when it starts. */
export function opsChanged(deps: CommandDeps, accountIds: Iterable<string>): void {
  for (const id of new Set(accountIds)) {
    try {
      deps.accounts().opsChanged(id);
    } catch {
      // An actor that is not running yet (or a host with none) drains the queue when it starts.
    }
  }
}
