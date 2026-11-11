import type { Input, Output, QueueItem } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { auditWrites } from '../host/audit';
import { nonce, type AreaHandlers, type MethodContext } from './types';

/**
 * The `queue` area, owned by lane `eng-ai`: the content-free inspector over `ops`, `jobs` and `submissions`.
 * Ids are namespaced (`op:`, `job:`, `sub:`) so the three stores can never collide on Retry or Discard. Retry and
 * discard re-dispatch the owning method under a fresh opId, so a repeated action is never a commit replay.
 */

const notFound = () =>
  new ContractError({ type: 'notFound', message: 'This item is no longer in the queue.' });

function needScope(ctx: MethodContext, scope: string) {
  if (!ctx.caller.scopes.includes(scope as 'send'))
    throw new ContractError({ type: 'forbidden', message: `This needs the ${scope} permission.` });
}

const exists = (ctx: MethodContext, sql: string, id: string | number) =>
  ctx.services.store.read(q => q.get(sql, id) !== undefined);

/** The code for the row's current problem, content-free: a bare reason string, or JSON carrying `problem.reasonCode`. */
function problem(raw: string | null): QueueItem['problem'] {
  if (!raw) return undefined;
  try {
    const p = JSON.parse(raw) as {
      reasonCode?: unknown;
      code?: unknown;
      problem?: { reasonCode?: unknown };
    };
    for (const c of [p?.problem?.reasonCode, p?.reasonCode, p?.code])
      if (typeof c === 'string' && c.length <= 60) return { reasonCode: c };
  } catch {
    /* a bare reason string */
  }
  return { reasonCode: raw.length <= 60 ? raw : 'unknown' };
}

const targets = (raw: string) => {
  try {
    const t: unknown = JSON.parse(raw);
    if (Array.isArray(t)) return ` ${t.length}`;
  } catch {
    /* not a JSON list */
  }
  return '';
};

async function list(args: Input<'Queue/list'>, ctx: MethodContext): Promise<Output<'Queue/list'>> {
  const kinds = args.kinds as readonly string[] | undefined;
  const want = (kind: QueueItem['kind']) => !kinds || kinds.includes(kind);
  const items = ctx.services.store.read(q => {
    const out: QueueItem[] = [];
    if (want('op'))
      for (const r of q.all<{
        [k: string]: string | number | null;
        op_id: string;
        account_id: string;
        kind: string;
        target: string;
        state: string;
        attempts: number;
        next_at: number | null;
        last_error: string | null;
        scope: string;
        created_at: number | null;
      }>(
        `SELECT o.op_id, o.account_id, o.kind, o.target, o.state, o.attempts, o.next_at, o.last_error, o.scope,
                (SELECT MIN(c.at) FROM commits c WHERE c.seq = o.created_seq) AS created_at
         FROM ops o WHERE o.state IN ('queued','inflight','failed','conflict')
         ORDER BY o.created_seq, o.op_id LIMIT 500`,
      )) {
        const problem_ = problem(r.last_error);
        out.push({
          id: `op:${r.op_id}`,
          kind: 'op',
          label: (r.kind + targets(r.target)).slice(0, 200),
          accountId: r.account_id,
          state: r.state,
          attempts: r.attempts,
          ...(r.next_at !== null ? { nextAt: r.next_at } : {}),
          createdAt: r.created_at ?? 0,
          ...(problem_ ? { problem: problem_ } : {}),
          canRetry: r.state === 'failed' || r.state === 'conflict',
          canDiscard: true,
          scope: r.scope as QueueItem['scope'],
        });
      }
    if (want('job'))
      for (const r of q.all<{
        [k: string]: string | number | null;
        id: number;
        kind: string;
        state: string;
        attempts: number;
        next_at: number;
        last_error: string | null;
      }>(
        `SELECT id, kind, state, attempts, next_at, last_error FROM jobs
         WHERE state IN ('queued','running','failed','dead') ORDER BY next_at, id LIMIT 500`,
      )) {
        const problem_ = problem(r.last_error);
        out.push({
          id: `job:${r.id}`,
          kind: 'job',
          label: r.kind.slice(0, 200),
          state: r.state,
          attempts: r.attempts,
          nextAt: r.next_at,
          createdAt: 0,
          ...(problem_ ? { problem: problem_ } : {}),
          canRetry: r.state === 'failed' || r.state === 'dead',
          canDiscard: true,
          scope: 'ai',
        });
      }
    if (want('submission'))
      for (const r of q.all<{
        [k: string]: string | number | null;
        id: string;
        account_id: string;
        state: string;
        not_before: number;
        attempt_at: number | null;
        error: string | null;
      }>(
        `SELECT id, account_id, state, not_before, attempt_at, error FROM submissions
         WHERE state IN ('queued','scheduled','sending','uncertain','suspended','failed')
         ORDER BY not_before, id LIMIT 500`,
      )) {
        const problem_ = problem(r.error);
        out.push({
          id: `sub:${r.id}`,
          kind: 'submission',
          label: 'Send',
          accountId: r.account_id,
          state: r.state,
          attempts: r.attempt_at !== null ? 1 : 0,
          nextAt: r.not_before,
          createdAt: r.not_before,
          ...(problem_ ? { problem: problem_ } : {}),
          // `Submission/set` 'retry' accepts only a failed send; 'uncertain'/'suspended' need their own actions.
          canRetry: r.state === 'failed',
          canDiscard: r.state !== 'sending',
          scope: 'send',
        });
      }
    return out;
  });
  // Calendar changes held for guests (prov-cal): content-free, listed beside the other ops.
  const held = want('op') ? await ctx.services.calendarHolds?.list() : undefined;
  return { list: held?.length ? [...items, ...held] : items };
}

function opScope(ctx: MethodContext, opId: string) {
  const row = ctx.services.store.read(q =>
    q.get<{ scope: string }>('SELECT scope FROM ops WHERE op_id = ?', opId),
  );
  if (!row) throw notFound();
  needScope(ctx, row.scope);
}

const audit = (ctx: MethodContext, method: 'Queue/retry' | 'Queue/discard', id: string) =>
  ctx.services.store.commit({
    opId: `${method === 'Queue/retry' ? 'queue-retry' : 'queue-discard'}-${nonce(ctx)}`,
    origin: 'local',
    writes: auditWrites(ctx.caller, method, id),
  });

async function retry(
  args: Input<'Queue/retry'>,
  ctx: MethodContext,
): Promise<Output<'Queue/retry'>> {
  const id = args.id;
  if (id.startsWith('cal:')) {
    needScope(ctx, 'send');
    if (!ctx.services.calendarHolds?.has(id.slice(4))) throw notFound();
    await ctx.redispatch('Operation/retry', { opId: id.slice(4) });
  } else if (id.startsWith('op:')) {
    opScope(ctx, id.slice(3));
    // The action first: a refused retry leaves no audit row and burns no idempotency key.
    await ctx.redispatch('Operation/retry', { opId: id.slice(3) });
  } else if (id.startsWith('sub:')) {
    const subId = id.slice(4);
    if (!exists(ctx, 'SELECT 1 AS one FROM submissions WHERE id = ?', subId)) throw notFound();
    needScope(ctx, 'send');
    await ctx.redispatch('Submission/set', {
      opId: `queue-retry-${nonce(ctx)}`,
      action: { type: 'retry', submissionId: subId },
    });
  } else if (id.startsWith('job:')) {
    needScope(ctx, 'ai');
    const jobId = Number(id.slice(4));
    const jobState = ctx.services.store.read(
      q => q.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state,
    );
    if (!Number.isInteger(jobId) || !jobState) throw notFound();
    if (jobState !== 'failed' && jobState !== 'dead')
      throw new ContractError({ type: 'conflict', message: 'That job is not waiting to retry.' });
    ctx.services.store.commit({
      opId: `queue-retry-${nonce(ctx)}`,
      origin: 'local',
      writes: [
        { kind: 'job', id: jobId, action: 'requeue', nextAt: ctx.services.clock.now() },
        ...auditWrites(ctx.caller, 'Queue/retry', id),
      ],
    });
    return { ok: true };
  } else throw notFound();
  audit(ctx, 'Queue/retry', id);
  return { ok: true };
}

async function discard(
  args: Input<'Queue/discard'>,
  ctx: MethodContext,
): Promise<Output<'Queue/discard'>> {
  const id = args.id;
  if (id.startsWith('cal:')) {
    const holds = ctx.services.calendarHolds;
    if (!holds?.has(id.slice(4))) throw notFound();
    needScope(ctx, 'send');
    await holds.dismiss(id.slice(4), ctx.caller);
    audit(ctx, 'Queue/discard', id);
    return { ok: true };
  }
  if (id.startsWith('op:')) {
    opScope(ctx, id.slice(3));
    const opState = ctx.services.store.read(
      q => q.get<{ state: string }>('SELECT state FROM ops WHERE op_id = ?', id.slice(3))?.state,
    );
    if (!opState) throw notFound();
    if (opState === 'inflight')
      throw new ContractError({
        type: 'conflict',
        message: 'That change is already on its way to the server.',
      });
    ctx.services.store.commit({
      opId: `queue-discard-${nonce(ctx)}`,
      origin: 'local',
      writes: [
        { kind: 'opSettle', opId: id.slice(3), state: 'cancelled' },
        ...auditWrites(ctx.caller, 'Queue/discard', id),
      ],
    });
    return { ok: true };
  }
  if (id.startsWith('sub:')) {
    const subId = id.slice(4);
    const state = ctx.services.store.read(
      q => q.get<{ state: string }>('SELECT state FROM submissions WHERE id = ?', subId)?.state,
    );
    if (!state || state === 'sent' || state === 'cancelled' || state === 'sending')
      throw notFound();
    needScope(ctx, 'send');
    await ctx.redispatch('Submission/set', {
      opId: `queue-discard-${nonce(ctx)}`,
      action: {
        type: state === 'queued' || state === 'scheduled' ? 'undo' : 'cancel',
        submissionId: subId,
      },
    });
  } else if (id.startsWith('job:')) {
    needScope(ctx, 'ai');
    const jobId = Number(id.slice(4));
    const jobState = ctx.services.store.read(
      q => q.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state,
    );
    if (!Number.isInteger(jobId) || !jobState) throw notFound();
    if (jobState === 'running')
      throw new ContractError({ type: 'conflict', message: 'That job is already running.' });
    ctx.services.store.commit({
      opId: `queue-discard-${nonce(ctx)}`,
      origin: 'local',
      writes: [
        { kind: 'job', id: jobId, action: 'delete' },
        ...auditWrites(ctx.caller, 'Queue/discard', id),
      ],
    });
    return { ok: true };
  } else throw notFound();
  audit(ctx, 'Queue/discard', id);
  return { ok: true };
}

export const handlers: AreaHandlers<'queue'> = {
  'Queue/list': list,
  'Queue/retry': retry,
  'Queue/discard': discard,
};
