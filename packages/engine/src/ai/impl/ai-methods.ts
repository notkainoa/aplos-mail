import type { Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { MethodContext } from '../../methods/types';
import { splitId } from '../../views/compile';
import { AiCallError } from '../host';
import { providerRow } from '../providers';
import { auditWrites } from '../../host/audit';
import { hexId } from '../../sync/connect-sessions';
import { accountAllowed } from './gate';
import { enqueue, inputHashOf, jobOf, jobRow, priorityOf, type JobRow } from './jobs';
import { callMessage } from './runtime';
import './ai-writes';

/**
 * The `ai` area's working half (lazy-loaded by `methods/ai.ts`): enqueue (`Ai/request`), the queue read
 * (`Ai/jobs`), interactive cancellation, keys and the live checks. Every mail-carrying call goes through the gate
 * in `gate.ts` first.
 */

function request(args: Input<'Ai/request'>, ctx: MethodContext): Output<'Ai/request'> {
  const { store, clock } = ctx.services;
  const parts = store.read(q => splitId(q, args.threadId));
  if (!parts)
    throw new ContractError({ type: 'notFound', message: 'That thread is not in Aplos.' });
  accountAllowed(ctx.services, parts.accountId);
  const info = store.read(q => priorityOf(q, parts.accountId, parts.remoteId));
  if (!info) throw new ContractError({ type: 'notFound', message: 'That thread is not in Aplos.' });
  const { hash, messageCount } = store.read(q => inputHashOf(q, info.threadRowId));
  if (!messageCount)
    throw new ContractError({ type: 'notFound', message: 'That thread has no mail yet.' });
  // The singleton key is per kind — `classify` shares the summary pipeline and its key; `plan` and
  // `suggestAction` run alongside a summary job, not inside it. Look the existing row up by this kind's key.
  const key =
    args.kind === 'summary' || args.kind === 'classify'
      ? `summary:${parts.accountId}:${parts.remoteId}:${hash}`
      : `${args.kind}:${parts.accountId}:${parts.remoteId}:${hash}`;
  const existing = store.read(q =>
    q.get<JobRow>(
      'SELECT id, kind, key, priority, payload, state, attempts, next_at, last_error FROM jobs WHERE key = ?',
      key,
    ),
  );
  if (existing && !args.force) {
    return {
      job: jobOf(existing),
      receipt: { opId: args.opId, appliedState: { dbEpoch: store.dbEpoch, seq: store.seq() } },
    };
  }
  // A forced refresh re-runs the job under its key instead of enqueuing a duplicate: a fresh attempt
  // budget, `queued` again. A `running` row is left alone — it is already doing the work.
  if (existing && args.force) {
    if (existing.state !== 'running')
      store.commit({
        opId: `${args.opId}-force`,
        origin: 'local',
        writes: [{ kind: 'job', action: 'requeue', id: existing.id, nextAt: clock.now() }],
      });
    ctx.services.deadlines.changed('jobs');
    const row = store.read(q => jobRow(q, existing.id))!;
    return {
      job: jobOf(row),
      receipt: { opId: args.opId, appliedState: { dbEpoch: store.dbEpoch, seq: store.seq() } },
    };
  }
  // A summarized thread needs no job either, unless the caller forced a refresh. `classify` shares the
  // summary pipeline (its outputs live on the summary row), so it takes the same shortcut and key.
  if (!args.force && (args.kind === 'summary' || args.kind === 'classify')) {
    const have = store.read(q =>
      q.get(
        'SELECT 1 AS one FROM summaries s JOIN threads t ON t.id = s.thread_id WHERE t.account_id = ? AND t.remote_id = ? AND s.input_hash = ?',
        parts.accountId,
        parts.remoteId,
        hash,
      ),
    );
    if (have)
      return {
        job: jobOf(
          existing ?? {
            id: 0,
            kind: 'summary',
            key,
            priority: info.priority,
            payload: '{}',
            state: 'done',
            attempts: 0,
            next_at: 0,
            last_error: null,
          },
        ),
        receipt: { opId: args.opId, appliedState: { dbEpoch: store.dbEpoch, seq: store.seq() } },
      };
  }
  const row = enqueue(ctx.services, args.opId, {
    kind: args.kind,
    key,
    priority: info.priority,
    nextAt: clock.now(),
    payload: {
      threadId: args.threadId,
      accountId: parts.accountId,
      remoteThreadId: parts.remoteId,
      inputHash: hash,
      force: !!args.force,
    },
  });
  return {
    job: jobOf(row),
    receipt: { opId: args.opId, appliedState: { dbEpoch: store.dbEpoch, seq: store.seq() } },
  };
}

function jobs(args: Input<'Ai/jobs'>, ctx: MethodContext): Output<'Ai/jobs'> {
  const rows = ctx.services.store.read(q => {
    const states = args.states?.length ? args.states : ['queued', 'running', 'failed', 'dead'];
    const list = q.all<JobRow>(
      `SELECT id, kind, key, priority, payload, state, attempts, next_at, last_error FROM jobs
       WHERE kind != 'wake' AND state IN (${states.map(() => '?').join(',')}) ORDER BY priority, next_at, id LIMIT 500`,
      ...states,
    );
    return list;
  });
  let out = rows.map(jobOf);
  if (args.threadIds?.length) {
    const wanted = new Set(args.threadIds);
    out = out.filter(j => j.threadId !== undefined && wanted.has(j.threadId));
  }
  return { list: out };
}

function cancel(args: Input<'Ai/cancel'>, ctx: MethodContext): Output<'Ai/cancel'> {
  return { cancelled: ctx.services.ai.cancel(args.requestId) };
}

async function setKey(args: Input<'Ai/setKey'>, ctx: MethodContext): Promise<Output<'Ai/setKey'>> {
  if (!providerRow(args.provider))
    throw new ContractError({ type: 'invalid', message: 'Unknown AI provider.' });
  const keySource = await ctx.services.ai.transport().setKey(args.provider, args.key);
  // The method declares `audit: true`: the key event is logged (the key's characters never are).
  ctx.services.store.commit({
    opId: hexId(ctx.services.randomBytes, 'ai-key'),
    origin: 'local',
    writes: auditWrites(ctx.caller, 'Ai/setKey', args.provider),
  });
  return { keySource };
}

async function removeKey(
  args: Input<'Ai/removeKey'>,
  ctx: MethodContext,
): Promise<Output<'Ai/removeKey'>> {
  if (!providerRow(args.provider))
    throw new ContractError({ type: 'invalid', message: 'Unknown AI provider.' });
  const keySource = await ctx.services.ai.transport().removeKey(args.provider);
  ctx.services.store.commit({
    opId: hexId(ctx.services.randomBytes, 'ai-key'),
    origin: 'local',
    writes: auditWrites(ctx.caller, 'Ai/removeKey', args.provider),
  });
  return { keySource };
}

async function testKey(
  args: Input<'Ai/testKey'>,
  ctx: MethodContext,
): Promise<Output<'Ai/testKey'>> {
  if (!providerRow(args.provider))
    throw new ContractError({ type: 'invalid', message: 'Unknown AI provider.' });
  const start = ctx.services.clock.now();
  try {
    await ctx.services.ai.transport().check(args.provider);
    return { ok: true, ms: ctx.services.clock.now() - start };
  } catch (error) {
    const { reasonCode, message } = callMessage(error);
    return { ok: false, ms: ctx.services.clock.now() - start, reasonCode, message };
  }
}

async function test(args: Input<'Ai/test'>, ctx: MethodContext): Promise<Output<'Ai/test'>> {
  if (!providerRow(args.model.provider))
    throw new ContractError({ type: 'invalid', message: 'Unknown AI provider.' });
  const start = ctx.services.clock.now();
  try {
    const turn = await ctx.services.ai.transport().chat({
      model: args.model,
      messages: [
        {
          role: 'user',
          content: 'Call the tool `ping` with argument {"ok": true} and nothing else.',
        },
      ],
      tools: [
        {
          name: 'ping',
          description: 'Acknowledge the call.',
          parameters: { type: 'object', properties: { ok: { type: 'boolean' } } },
        },
      ],
      toolChoice: 'auto',
      maxTokens: 64,
      signal: ctx.signal,
    });
    return { ms: ctx.services.clock.now() - start, tools: turn.toolCalls.length > 0 };
  } catch (error) {
    const { message } = callMessage(error);
    if (error instanceof AiCallError && error.code === 'unreachable')
      throw new ContractError({ type: 'unavailable', message });
    throw new ContractError({ type: 'invalid', message });
  }
}

export { request, jobs, cancel, setKey, removeKey, testKey, test };
export const impl = { request, jobs, cancel, setKey, removeKey, testKey, test };

export { dismissFollowup, draft, followup, polish, transcribe } from './write';
