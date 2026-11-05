import type { Input, Output, QueueItem } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { auditWrites } from '../host/audit';
import type { AreaHandlers, MethodContext } from './types';

/**
 * The `queue` area, owned by lane `eng-ai`: the content-free inspector over `ops`, `jobs` and `submissions`.
 * Ids are namespaced (`op:`, `job:`, `sub:`) so the three stores can never collide on Retry or Discard.
 */

const OPEN_OPS = ['queued', 'inflight', 'failed', 'conflict'];
const OPEN_SUBS = ['queued', 'scheduled', 'sending', 'uncertain', 'suspended', 'failed'];
const OPEN_JOBS = ['queued', 'running', 'failed', 'dead'];

interface OpRow {
  [key: string]: string | number | null | Uint8Array;
  op_id: string;
  account_id: string;
  kind: string;
  target: string;
  state: string;
  attempts: number;
  next_at: number | null;
  last_error: string | null;
  created_seq: number;
  scope: string;
}
interface SubRow {
  [key: string]: string | number | null | Uint8Array;
  id: string;
  account_id: string;
  state: string;
  not_before: number;
  attempt_at: number | null;
  error: string | null;
}
interface JobRow {
  [key: string]: string | number | null | Uint8Array;
  id: number;
  kind: string;
  state: string;
  attempts: number;
  next_at: number;
  last_error: string | null;
}

function problem(raw: string | null): QueueItem['problem'] {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const p = parsed as { reasonCode?: unknown; code?: unknown };
      const reasonCode = typeof p.reasonCode === 'string' ? p.reasonCode : p.code;
      if (typeof reasonCode === 'string' && reasonCode.length <= 60) return { reasonCode };
    }
  } catch {
    /* not JSON */
  }
  return { reasonCode: 'unknown' };
}

function label(kind: string, target: string): string {
  try {
    const targets: unknown = JSON.parse(target);
    if (Array.isArray(targets)) return `${kind} ${targets.length}`.slice(0, 200);
  } catch {
    /* target is not a JSON list */
  }
  return kind.slice(0, 200);
}

function list(args: Input<'Queue/list'>, ctx: MethodContext): Output<'Queue/list'> {
  const kinds = args.kinds as readonly string[] | undefined;
  const want = (kind: QueueItem['kind']) => !kinds || kinds.includes(kind);
  const items: QueueItem[] = ctx.services.store.read(q => {
    const created = new Map<number, number>();
    if (want('op'))
      for (const r of q.all<{ seq: number; at: number }>('SELECT seq, at FROM commits'))
        created.set(r.seq, r.at);
    const out: QueueItem[] = [];
    if (want('op'))
      for (const r of q.all<OpRow>(
        `SELECT op_id, account_id, kind, target, state, attempts, next_at, last_error, created_seq, scope
         FROM ops WHERE state IN (${OPEN_OPS.map(() => '?').join(',')})`,
        ...OPEN_OPS,
      ))
        out.push({
          id: `op:${r.op_id}`,
          kind: 'op',
          label: label(r.kind, r.target),
          accountId: r.account_id,
          state: r.state,
          attempts: r.attempts,
          ...(r.next_at !== null ? { nextAt: r.next_at } : {}),
          createdAt: created.get(r.created_seq) ?? 0,
          ...(problem(r.last_error) ? { problem: problem(r.last_error) } : {}),
          canRetry: r.state === 'failed' || r.state === 'conflict',
          canDiscard: true,
          scope: r.scope as QueueItem['scope'],
        });
    if (want('job'))
      for (const r of q.all<JobRow>(
        `SELECT id, kind, state, attempts, next_at, last_error FROM jobs WHERE state IN (${OPEN_JOBS.map(
          () => '?',
        ).join(',')})`,
        ...OPEN_JOBS,
      ))
        out.push({
          id: `job:${r.id}`,
          kind: 'job',
          label: r.kind.slice(0, 200),
          state: r.state,
          attempts: r.attempts,
          nextAt: r.next_at,
          createdAt: 0,
          ...(problem(r.last_error) ? { problem: problem(r.last_error) } : {}),
          canRetry: r.state === 'failed' || r.state === 'dead',
          canDiscard: true,
          scope: 'ai',
        });
    if (want('submission'))
      for (const r of q.all<SubRow>(
        `SELECT id, account_id, state, not_before, attempt_at, error FROM submissions WHERE state IN (${OPEN_SUBS.map(
          () => '?',
        ).join(',')})`,
        ...OPEN_SUBS,
      ))
        out.push({
          id: `sub:${r.id}`,
          kind: 'submission',
          label: 'Send',
          accountId: r.account_id,
          state: r.state,
          attempts: r.attempt_at !== null ? 1 : 0,
          nextAt: r.not_before,
          createdAt: r.not_before,
          ...(problem(r.error) ? { problem: problem(r.error) } : {}),
          canRetry: r.state === 'failed' || r.state === 'uncertain' || r.state === 'suspended',
          canDiscard: true,
          scope: 'send',
        });
    return out;
  });
  return { list: items };
}

const forbidden = (scope: string) =>
  new ContractError({
    type: 'forbidden',
    message: `This needs the ${scope} permission.`,
  });

function needScope(ctx: MethodContext, scope: string) {
  if (!ctx.caller.scopes.includes(scope as 'send')) throw forbidden(scope);
}

async function retry(
  args: Input<'Queue/retry'>,
  ctx: MethodContext,
): Promise<Output<'Queue/retry'>> {
  const id = args.id;
  if (id.startsWith('op:')) {
    const opId = id.slice(3);
    const scope = ctx.services.store.read(
      q => q.get<{ scope: string }>('SELECT scope FROM ops WHERE op_id = ?', opId)?.scope,
    );
    if (scope === undefined)
      throw new ContractError({
        type: 'notFound',
        message: 'This item is no longer in the queue.',
      });
    needScope(ctx, scope);
    ctx.services.store.commit({
      opId: `queue-retry-${opId}`,
      origin: 'local',
      writes: auditWrites(ctx.caller, 'Queue/retry', id),
    });
    await ctx.redispatch('Operation/retry', { opId });
    return { ok: true };
  }
  if (id.startsWith('sub:')) {
    const subId = id.slice(4);
    const known = ctx.services.store.read(
      q => q.get('SELECT 1 AS one FROM submissions WHERE id = ?', subId) !== undefined,
    );
    if (!known)
      throw new ContractError({
        type: 'notFound',
        message: 'This item is no longer in the queue.',
      });
    needScope(ctx, 'send');
    ctx.services.store.commit({
      opId: `queue-retry-${subId}`,
      origin: 'local',
      writes: auditWrites(ctx.caller, 'Queue/retry', id),
    });
    await ctx.redispatch('Submission/set', {
      opId: `queue-retry-${subId}`,
      action: { type: 'retry', submissionId: subId },
    });
    return { ok: true };
  }
  if (id.startsWith('job:')) {
    needScope(ctx, 'ai');
    const jobId = Number(id.slice(4));
    const known = ctx.services.store.read(
      q => q.get('SELECT 1 AS one FROM jobs WHERE id = ?', jobId) !== undefined,
    );
    if (!known)
      throw new ContractError({
        type: 'notFound',
        message: 'This item is no longer in the queue.',
      });
    ctx.services.store.commit({
      opId: `queue-retry-${jobId}`,
      origin: 'local',
      writes: [
        { kind: 'job', id: jobId, action: 'requeue', nextAt: ctx.services.clock.now() },
        ...auditWrites(ctx.caller, 'Queue/retry', id),
      ],
    });
    return { ok: true };
  }
  throw new ContractError({ type: 'notFound', message: 'This item is no longer in the queue.' });
}

async function discard(
  args: Input<'Queue/discard'>,
  ctx: MethodContext,
): Promise<Output<'Queue/discard'>> {
  const id = args.id;
  if (id.startsWith('op:')) {
    const opId = id.slice(3);
    const scope = ctx.services.store.read(
      q => q.get<{ scope: string }>('SELECT scope FROM ops WHERE op_id = ?', opId)?.scope,
    );
    if (scope === undefined)
      throw new ContractError({
        type: 'notFound',
        message: 'This item is no longer in the queue.',
      });
    needScope(ctx, scope);
    ctx.services.store.commit({
      opId: `queue-discard-${opId}`,
      origin: 'local',
      writes: [
        { kind: 'opSettle', opId, state: 'cancelled' },
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
    if (state === undefined || state === 'sent' || state === 'cancelled')
      throw new ContractError({
        type: 'notFound',
        message: 'This item is no longer in the queue.',
      });
    needScope(ctx, 'send');
    ctx.services.store.commit({
      opId: `queue-discard-${subId}`,
      origin: 'local',
      writes: auditWrites(ctx.caller, 'Queue/discard', id),
    });
    const type = state === 'queued' || state === 'scheduled' ? 'undo' : 'cancel';
    await ctx.redispatch('Submission/set', {
      opId: `queue-discard-${subId}`,
      action: { type, submissionId: subId },
    });
    return { ok: true };
  }
  if (id.startsWith('job:')) {
    needScope(ctx, 'ai');
    const jobId = Number(id.slice(4));
    const known = ctx.services.store.read(
      q => q.get('SELECT 1 AS one FROM jobs WHERE id = ?', jobId) !== undefined,
    );
    if (!known)
      throw new ContractError({
        type: 'notFound',
        message: 'This item is no longer in the queue.',
      });
    ctx.services.store.commit({
      opId: `queue-discard-${jobId}`,
      origin: 'local',
      writes: [
        { kind: 'job', id: jobId, action: 'delete' },
        ...auditWrites(ctx.caller, 'Queue/discard', id),
      ],
    });
    return { ok: true };
  }
  throw new ContractError({ type: 'notFound', message: 'This item is no longer in the queue.' });
}

export const handlers: AreaHandlers<'queue'> = {
  'Queue/list': list,
  'Queue/retry': retry,
  'Queue/discard': discard,
};
