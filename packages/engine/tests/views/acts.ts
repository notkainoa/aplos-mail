import type { ThreadRow } from '@aplos/contract';
import { parseOpPayload } from '../../src/sync/ops';
import type { StorePort } from '../../src/store';
import type { TestEngine } from './harness';

/*
 * Helpers for the command tests (views-3): the open `ops` rows of an operation, a thread's facts as the UI reads them,
 * and a way to play the provider (settle a row as synced, failed or in flight).
 */

export interface OpRowView {
  opId: string;
  accountId: string;
  state: string;
  scope: string;
  payload: ReturnType<typeof parseOpPayload>;
  lastError: string | null;
}

/** Every open `ops` row, in queue order. */
export function openOps(store: StorePort): OpRowView[] {
  return store
    .read(q =>
      q.all<{
        op_id: string;
        account_id: string;
        state: string;
        scope: string;
        payload: string;
        last_error: string | null;
      }>('SELECT op_id, account_id, state, scope, payload, last_error FROM ops ORDER BY seq'),
    )
    .map(r => ({
      opId: r.op_id,
      accountId: r.account_id,
      state: r.state,
      scope: r.scope,
      payload: parseOpPayload(r.payload),
      lastError: r.last_error,
    }));
}

/** The provider's side: settles every open row (or those of `ids`) as the drain would. */
export function settle(
  t: TestEngine,
  state: 'synced' | 'queued' | 'inflight' | 'failed' | 'conflict' | 'cancelled',
  ids: readonly string[] = openOps(t.store).map(r => r.opId),
  lastError?: string,
) {
  t.commit(
    ids.map(opId => ({ kind: 'opSettle', opId, state, ...(lastError ? { lastError } : {}) })),
    'sync',
  );
}

/** Ids of the Inbox window, newest first. */
export async function inboxIds(t: TestEngine, accountId?: string): Promise<string[]> {
  const r = await t.call('View/query', {
    spec: { kind: 'mailbox', role: 'inbox', ...(accountId ? { accountId } : {}) },
    limit: 200,
  });
  return r.ids;
}

export async function rowOf(t: TestEngine, id: string): Promise<ThreadRow> {
  const r = await t.call('Thread/get', { ids: [id] });
  if (!r.list[0]) throw new Error(`no such thread ${id}`);
  return r.list[0];
}

/** What a thread shows, without the fields that move with every edit (`rev`, `editedAt`). */
export function facts(row: ThreadRow) {
  return {
    workflow: { ...row.workflow, editedAt: undefined },
    labels: [...row.labels].sort(),
    rank: row.rank,
    unread: row.unread,
    unreadCount: row.unreadCount,
    flagged: row.flagged,
  };
}

let counter = 0;
export const nextOp = (name = 'op') => `${name}-${++counter}`;
