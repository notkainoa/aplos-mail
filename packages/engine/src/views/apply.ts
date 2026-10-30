import type { Receipt } from '@aplos/contract';
import type { StoreReader, StoreWrite } from '../store';
import { beforeOf, idOf, mailActions, planThread, type ActEnv, type ThreadFacts } from './act';
import {
  deadlinesChanged,
  opsChanged,
  opWrite,
  rowId,
  type CommandDeps,
  type OpRecord,
  type RecordedStep,
  type RecordedThread,
} from './ops';
import { viewEnv } from './page';
import { localDay } from './sections';

/*
 * What `Thread/act` and the sender rules share (views-3, views-4): one commit that carries a list of thread plans, their
 * provider ops and the journal record that makes the receipt undoable. Rules reuse it so a rule applied to existing
 * threads behaves exactly like an act: one commit, one receipt, ops rows, undo.
 */

/** The scope of every command here; the operation records it and `Operation/undo` and `retry` require it again (FR-3). */
export const ACT_SCOPE = 'triage';

type Plan = NonNullable<ReturnType<typeof planThread>>;

/** The kinds of operation the journal can hold besides an undo. */
export type CommandMethod = Exclude<OpRecord['method'], 'Operation/undo'>;

export interface Built {
  writes: StoreWrite[];
  threads: RecordedThread[];
  steps: RecordedStep[];
  targets: string[];
  /** Writes that put back what the command changed outside the threads (a sender rule), run by `Operation/undo`. */
  restore: StoreWrite[];
}

export const emptyBuilt = (): Built => ({
  writes: [],
  threads: [],
  steps: [],
  targets: [],
  restore: [],
});

export function readEnv(deps: CommandDeps, q: StoreReader): ActEnv {
  const now = deps.clock.now();
  return {
    now,
    today: localDay(now, deps.zone),
    followUpDays: viewEnv(q, now, deps.zone).followUpDays,
    ...mailActions(q),
  };
}

/** Adds one thread's workflow patch and message edits to the commit. */
export function addThread(
  out: Built,
  facts: ThreadFacts,
  plan: Plan,
  opId: string,
  method: CommandMethod,
): void {
  const accountId = facts.row.account_id;
  const threadId = idOf(facts);
  out.targets.push(threadId);
  out.threads.push({
    accountId,
    remoteThreadId: facts.row.remote_id,
    before: beforeOf(facts.row, plan.patch),
  });
  out.writes.push({
    kind: 'workflow',
    accountId,
    remoteThreadId: facts.row.remote_id,
    patch: plan.patch,
  });
  for (const step of plan.steps) {
    const id = rowId(opId, out.steps.length);
    out.steps.push({ rowId: id, accountId, threadId, step });
    out.writes.push(opWrite({ rowId: id, method, scope: ACT_SCOPE, accountId, threadId, step }));
  }
}

/** Commits what was built as one commit, journals it for undo and wakes the account actors. */
export function commitBuilt(
  deps: CommandDeps,
  opId: string,
  method: CommandMethod,
  built: Built,
): Receipt {
  const result = deps.store.commit({ opId, origin: 'local', writes: built.writes });
  const receipt: Receipt = {
    opId,
    appliedState: { dbEpoch: result.dbEpoch, seq: result.seq },
    undoable: false,
  };
  if (result.replayed) return { ...receipt, undoable: !!deps.journal.get(opId)?.undoable };
  receipt.undoable = deps.journal.add({
    opId,
    method,
    scope: ACT_SCOPE,
    targets: built.targets,
    seq: result.seq,
    createdAt: deps.clock.now(),
    threads: built.threads,
    steps: built.steps,
    restore: built.restore,
    undoable: true,
  });
  deadlinesChanged(deps, built.writes);
  opsChanged(
    deps,
    built.steps.map(s => s.accountId),
  );
  return receipt;
}
