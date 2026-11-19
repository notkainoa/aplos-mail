import type { Input, Receipt } from '@aplos/contract';
import { requireOriginating } from '@aplos/contract/access';
import { ContractError } from '@aplos/contract/contract-error';
import type { Caller } from '../methods/types';
import type { StoreReader, StoreWrite } from '../store';
import {
  deadlinesChanged,
  invertStep,
  localWrite,
  opsChanged,
  opWrite,
  priorReceipt,
  readOperation,
  rowId,
  rowsOf,
  writeOfEffect,
  type CommandDeps,
  type OpRecord,
  type OpRow,
  type RecordedStep,
} from './ops';

/*
 * `Operation/undo` and `Operation/retry` (views-3, DESIGN section 5 rule 11). Undo is the inverse operation: a message
 * edit still waiting in the queue is cancelled together with its local effect, so the provider never hears of it; one
 * that left (sent, in flight, or of unknown outcome) gets an inverse op appended to the queue. Nothing is ever a
 * delayed commit, and an undo that cannot be done says so (`conflict`) instead of claiming to restore.
 */

const conflict = (message: string) => new ContractError({ type: 'conflict', message });

const given = (row: OpRow) => row.state === 'failed' || row.state === 'conflict';

/** Never tried: the provider cannot have it, so the edit can be cancelled and the provider never hears of it. */
const unsent = (row: OpRow) => row.state === 'queued' && row.attempts === 0;

/** A failed or conflicted edit is given up; a queued one that was tried before is not (the provider may have it). */
const cancellable = (row: OpRow | undefined): row is OpRow => !!row && (unsent(row) || given(row));

/** The provider may have applied the edit: it was tried more than once, or is not waiting to be tried. */
const mayHaveLanded = (row: OpRow | undefined) =>
  !row || !cancellable(row) || (given(row) && row.attempts > 1);

interface UndoPlan {
  writes: StoreWrite[];
  fresh: RecordedStep[];
}

function undoStep(
  rs: RecordedStep,
  row: OpRow | undefined,
  rec: OpRecord,
  undoOpId: string,
  plan: UndoPlan,
): void {
  const send = mayHaveLanded(row);
  for (const step of invertStep(rs.step)) {
    if (!send) {
      plan.writes.push(localWrite(rs.accountId, step));
      continue;
    }
    const id = rowId(undoOpId, plan.fresh.length);
    const fresh = { rowId: id, accountId: rs.accountId, threadId: rs.threadId, step };
    plan.fresh.push(fresh);
    plan.writes.push(opWrite({ ...fresh, method: 'Operation/undo', scope: rec.scope }));
  }
  if (cancellable(row))
    plan.writes.unshift({ kind: 'opSettle', opId: rs.rowId, state: 'cancelled' });
}

const threadStored = (q: StoreReader, accountId: string, remoteId: string) =>
  !!q.get('SELECT 1 FROM threads WHERE account_id = ? AND remote_id = ?', accountId, remoteId);

function planUndo(q: StoreReader, rec: OpRecord, rows: OpRow[], undoOpId: string): UndoPlan {
  const byId = new Map(rows.map(r => [r.op_id, r]));
  const plan: UndoPlan = { writes: [], fresh: [] };
  for (const rs of rec.steps) undoStep(rs, byId.get(rs.rowId), rec, undoOpId, plan);
  for (const t of rec.threads)
    if (threadStored(q, t.accountId, t.remoteThreadId))
      plan.writes.push({
        kind: 'workflow',
        accountId: t.accountId,
        remoteThreadId: t.remoteThreadId,
        patch: t.before,
      });
  plan.writes.push(...(rec.restore ?? []));
  return plan;
}

/** The caller needs the scope the journal recorded and every scope an op row of the operation carries. */
function requireScopesOf(caller: Caller, rec: OpRecord | undefined, rows: readonly OpRow[]): void {
  const method = rec?.method ?? 'Thread/act';
  const scopes = new Set([rec?.scope, ...rows.map(r => r.scope)].filter(Boolean));
  if (!scopes.size) requireOriginating(caller, { method });
  for (const scope of scopes) requireOriginating(caller, { scope, method });
}

/** Who may undo: the caller needs the scope the operation was made with, and the operation has to be one we can invert. */
function undoableRecord(
  deps: CommandDeps,
  args: Input<'Operation/undo'>,
  caller: Caller,
): { rec: OpRecord; rows: OpRow[] } {
  const rec = deps.journal.get(args.opId);
  const rows = deps.store.read(q => rowsOf(q, args.opId));
  if (!rec && !rows.length)
    throw new ContractError({
      type: 'notFound',
      message: 'This change can no longer be undone.',
    });
  requireScopesOf(caller, rec, rows);
  if (!rec || !rec.undoable) throw conflict('This change cannot be undone.');
  if (rec.undone) throw conflict('This change was already undone.');
  return { rec, rows };
}

export function undoOperation(
  deps: CommandDeps,
  args: Input<'Operation/undo'>,
  caller: Caller,
): Receipt {
  if (args.undoOpId === args.opId)
    throw new ContractError({
      type: 'validation',
      message: 'An undo needs an id of its own.',
    });
  const replay = priorReceipt(deps, args.undoOpId, 'Operation/undo');
  if (replay) return replay;
  const { rec, rows } = undoableRecord(deps, args, caller);
  const plan = deps.store.read(q => planUndo(q, rec, rows, args.undoOpId));
  const result = deps.store.commit({
    opId: args.undoOpId,
    origin: 'local',
    writes: plan.writes,
  });
  const receipt: Receipt = {
    opId: args.undoOpId,
    appliedState: { dbEpoch: result.dbEpoch, seq: result.seq },
    undoable: false,
  };
  if (result.replayed) return receipt;
  rec.undone = args.undoOpId;
  deps.journal.add({
    ...rec,
    opId: args.undoOpId,
    method: 'Operation/undo',
    seq: result.seq,
    createdAt: deps.clock.now(),
    threads: [],
    steps: plan.fresh,
    restore: undefined,
    undoable: false,
    undone: undefined,
  });
  const operation = deps.store.read(q => readOperation(q, rec.opId, rec, deps.store.dbEpoch));
  if (operation) deps.frames.emit({ frame: 'operation', operation });
  deadlinesChanged(deps, plan.writes);
  opsChanged(
    deps,
    plan.fresh.map(s => s.accountId),
  );
  return receipt;
}

/** A failed edit goes back in the queue, and its local effect comes back with it (the row had returned to its place). */
function retryWrites(rows: OpRow[]): StoreWrite[] {
  const writes: StoreWrite[] = [];
  for (const row of rows) {
    for (const e of JSON.parse(row.effect ?? '[]') as Parameters<typeof writeOfEffect>[1][])
      writes.push(writeOfEffect(row.account_id, e));
    writes.push({
      kind: 'opSettle',
      opId: row.op_id,
      state: 'queued',
      attempts: 0,
      nextAt: null,
      lastError: null,
    });
  }
  return writes;
}

export function retryOperation(
  deps: CommandDeps,
  args: Input<'Operation/retry'>,
  caller: Caller,
): Receipt {
  const rows = deps.store.read(q => rowsOf(q, args.opId));
  if (!rows.length)
    throw new ContractError({
      type: 'notFound',
      message: 'This change is no longer in the queue.',
    });
  const rec = deps.journal.get(args.opId);
  requireScopesOf(caller, rec, rows);
  if (rec?.undone) throw conflict('This change was undone, so it cannot be retried.');
  const failed = rows.filter(r => r.state === 'failed' || r.state === 'conflict');
  if (!failed.length) throw conflict('Only a failed change can be retried.');
  const result = deps.store.commit({
    opId: `retry:${args.opId}:${deps.store.seq()}`,
    origin: 'local',
    writes: retryWrites(failed),
  });
  opsChanged(
    deps,
    failed.map(r => r.account_id),
  );
  return {
    opId: args.opId,
    appliedState: { dbEpoch: result.dbEpoch, seq: result.seq },
    undoable: !!rec && rec.undoable && !rec.undone,
  };
}
