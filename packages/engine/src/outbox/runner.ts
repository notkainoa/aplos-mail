import type { ClassifiedError } from '@aplos/contract';
import { OVERDUE_GRACE_MS } from '@aplos/contract/rules';
import { NotSentError, PausedError, ProviderError } from '../ports/base';
import type { SendReceipt, SubmissionPayload } from '../ports/provider';
import type { DeadlineSource } from '../ports/time';
import { dueSubmissions, type DueSubmission, type StoreReader } from '../store';
import { OVERDUE_COPY, PAUSE_POLL_MS, transition, type OutboxCtx } from './context';
import { applyStartRule, checkSent } from './start';
import {
  parseMeta,
  readSubmission,
  SubmissionConflict,
  type SubmissionProblem,
  type SubmissionRow,
} from './store';

/**
 * The `outbox` deadline source and the sends it starts (ARCH 7.1-7.3). A fire suspends overdue rows, then gives each
 * account at most one job: a due `findSent` check first, else its earliest due send. Jobs run detached, so a slow
 * provider never holds the timer loop; when one ends it reports `changed('outbox')` and the loop fires again.
 */

const isConflict = (error: unknown) => error instanceof SubmissionConflict;

function ignoreConflict(fn: () => void) {
  try {
    fn();
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
}

/** Runs `job` as the account's one job; the account is busy from now until it settles. */
function runJob(ctx: OutboxCtx, account: string, job: () => Promise<void>) {
  const done = Promise.resolve()
    .then(job)
    .catch(() => {
      // A store failure mid-job leaves the row where the start rule or the next fire finds it.
    })
    .finally(() => {
      ctx.busy.delete(account);
      ctx.deadlines.changed('outbox');
    });
  ctx.busy.set(account, done);
}

// ---------------------------------------------------------------- next()

/** When a waiting row of `account` next needs the timer, given its pause (still under the overdue rule). */
function waitingDeadline(ctx: OutboxCtx, account: string, notBefore: number, now: number) {
  if (!ctx.paused.has(account)) return notBefore;
  const until = ctx.paused.get(account) ?? now + PAUSE_POLL_MS;
  return Math.min(Math.max(notBefore, until), notBefore + OVERDUE_GRACE_MS + 1);
}

function earliest(ctx: OutboxCtx, q: StoreReader, now: number): number | undefined {
  let best: number | undefined;
  const take = (at: number) => {
    if (best === undefined || at < best) best = at;
  };
  if (ctx.startRulePending && q.get("SELECT 1 FROM submissions WHERE state = 'sending' LIMIT 1"))
    take(now);
  const checks = q.all<{ account: string; at: number }>(
    `SELECT account_id AS account, min(check_at) AS at FROM submissions
     WHERE state = 'uncertain' AND check_at IS NOT NULL GROUP BY account_id`,
  );
  for (const c of checks) if (!ctx.busy.has(c.account)) take(c.at);
  const waiting = q.all<{ account: string; at: number }>(
    `SELECT account_id AS account, min(not_before) AS at FROM submissions
     WHERE state IN ('queued', 'scheduled') GROUP BY account_id`,
  );
  for (const w of waiting)
    if (!ctx.busy.has(w.account)) take(waitingDeadline(ctx, w.account, w.at, now));
  return best;
}

export function nextDeadline(ctx: OutboxCtx): number | undefined {
  const now = ctx.clock.now();
  return ctx.store.read(q => earliest(ctx, q, now));
}

// ---------------------------------------------------------------- the send

function problemOf(error: ClassifiedError, now: number): SubmissionProblem {
  if (error.class === 'send_limit')
    return {
      reasonCode: 'quota.sendLimit',
      message: 'The daily sending limit is reached for this account. Try again later.',
      at: now,
      ...(error.resumeAt !== undefined ? { until: error.resumeAt } : {}),
    };
  return {
    reasonCode: error.class === 'auth' ? 'auth.expired' : 'net.offline',
    message: 'Your message was not sent. Check your connection, then try again.',
    at: now,
  };
}

/** The payload: the pinned MIME, plus the remote draft only when its synced copy is provably this revision (FR-7). */
function payloadOf(ctx: OutboxCtx, row: SubmissionRow, mime: Uint8Array): SubmissionPayload {
  const meta = parseMeta(row);
  const payload: SubmissionPayload = {
    submissionId: row.id,
    internetId: row.internet_id,
    mime,
    envelope: meta.envelope,
  };
  if (meta.remoteThreadId) payload.remoteThreadId = meta.remoteThreadId;
  const draft = ctx.store.read(q =>
    q.get<{
      remote_draft_id: string | null;
      remote_message_id: string | null;
      synced_revision: number | null;
      provider: string;
    }>(
      `SELECT d.remote_draft_id, d.remote_message_id, d.synced_revision, a.provider
       FROM drafts d JOIN accounts a ON a.id = d.account_id WHERE d.id = ?`,
      row.draft_id,
    ),
  );
  if (!draft?.remote_draft_id) return payload;
  payload.remoteDraftId = draft.remote_draft_id;
  // DECISION (time-2): Graph (`microsoft`) keeps a message's id across edits and the store has no change-key column,
  // so the id alone cannot prove the remote copy is the pinned revision. For those accounts the outbox never sets
  // baseRemoteMessageId or baseChangeKey: they always send the pinned MIME. A later change-key column can lift this.
  if (
    draft.provider !== 'microsoft' &&
    draft.synced_revision === row.revision &&
    draft.remote_message_id
  )
    payload.baseRemoteMessageId = draft.remote_message_id;
  return payload;
}

type Outcome = { ok: true; receipt: SendReceipt } | { ok: false; error: unknown };

async function deliver(
  ctx: OutboxCtx,
  row: SubmissionRow,
  payload: SubmissionPayload,
): Promise<Outcome> {
  try {
    return { ok: true, receipt: await ctx.send.send(row.account_id, payload) };
  } catch (error) {
    return { ok: false, error };
  }
}

function settleSent(
  ctx: OutboxCtx,
  row: SubmissionRow,
  attemptAt: number,
  receipt: SendReceipt,
  started: number,
) {
  const meta = parseMeta(row);
  ignoreConflict(() =>
    transition(
      ctx,
      {
        id: row.id,
        from: ['sending', 'uncertain'],
        to: 'sent',
        ifAttemptAt: attemptAt,
        set: {
          sentAt: receipt.acceptedAt,
          remoteMessageId: receipt.remoteMessageId ?? null,
          remoteThreadId: receipt.remoteThreadId ?? meta.remoteThreadId ?? null,
          problem: null,
          checkAt: null,
          dropMime: true,
        },
      },
      { was: 'sending', why: 'sent' },
    ),
  );
  ctx.log.event('send.sent', {
    submission: row.id,
    durationMs: Math.max(0, ctx.clock.now() - started),
    recipients: meta.envelope.rcpt.length,
    attachments: meta.attachments,
    bytes: row.mime?.length ?? 0,
  });
}

function settleFailed(
  ctx: OutboxCtx,
  row: SubmissionRow,
  attemptAt: number,
  error: ClassifiedError,
) {
  const now = ctx.clock.now();
  ignoreConflict(() =>
    transition(
      ctx,
      {
        id: row.id,
        from: ['sending', 'uncertain'],
        to: 'failed',
        ifAttemptAt: attemptAt,
        set: { problem: problemOf(error, now), checkAt: null },
      },
      { was: 'sending', why: 'notSent' },
    ),
  );
  ctx.log.event('send.failed', { submission: row.id, error });
}

/** Anything `send` threw that proves nothing: `uncertain`, then `findSent` at once (never replayed). */
async function settleUncertain(
  ctx: OutboxCtx,
  row: SubmissionRow,
  attemptAt: number,
  error: unknown,
  started: number,
) {
  const now = ctx.clock.now();
  let moved = true;
  try {
    transition(
      ctx,
      {
        id: row.id,
        from: ['sending'],
        to: 'uncertain',
        ifAttemptAt: attemptAt,
        set: { checkCount: 0, checkAt: now },
      },
      { was: 'sending', why: 'uncertain' },
    );
  } catch (e) {
    if (!isConflict(e)) throw e;
    moved = false;
  }
  ctx.log.event('send.uncertain', {
    submission: row.id,
    method: 'send',
    durationMs: Math.max(0, now - started),
    ...(error instanceof ProviderError ? { error: error.error } : {}),
  });
  if (moved) await checkSent(ctx, row.id);
}

function settlePaused(ctx: OutboxCtx, row: SubmissionRow, attemptAt: number, error: PausedError) {
  if (error.cls === 'send_limit')
    return settleFailed(ctx, row, attemptAt, {
      class: 'send_limit',
      provider: error.budget,
      method: 'send',
      reason: error.reason,
      ...(error.until !== undefined ? { resumeAt: error.until } : {}),
    });
  // Provably not sent and only paused: waiting again on the same notBefore, retried at `until`, under the overdue rule.
  ctx.paused.set(row.account_id, error.until);
  ignoreConflict(() =>
    transition(
      ctx,
      {
        id: row.id,
        from: ['sending'],
        to: 'queued',
        ifAttemptAt: attemptAt,
        set: { attemptAt: null },
      },
      { was: 'sending', why: 'paused' },
    ),
  );
}

async function settle(
  ctx: OutboxCtx,
  row: SubmissionRow,
  attemptAt: number,
  outcome: Outcome,
  started: number,
) {
  if (outcome.ok) return settleSent(ctx, row, attemptAt, outcome.receipt, started);
  const { error } = outcome;
  if (error instanceof NotSentError) return settleFailed(ctx, row, attemptAt, error.error);
  if (error instanceof PausedError) return settlePaused(ctx, row, attemptAt, error);
  return settleUncertain(ctx, row, attemptAt, error, started);
}

/**
 * One send: the `sending` marker (state and `attempt_at`) is committed, compare-and-set on the waiting row the timer
 * saw, before `SendPort.send` is called; a lost compare-and-set (undo, another engine) sends nothing.
 */
async function sendOne(ctx: OutboxCtx, due: DueSubmission) {
  const row = ctx.store.read(q => readSubmission(q, due.id));
  if (!row || row.state !== due.state || row.not_before !== due.notBefore || !row.mime) return;
  const attemptAt = ctx.clock.now();
  if (attemptAt - row.not_before > OVERDUE_GRACE_MS) return suspend(ctx, due, attemptAt);
  try {
    transition(
      ctx,
      {
        id: row.id,
        from: [row.state],
        to: 'sending',
        ifNotBefore: row.not_before,
        set: { attemptAt, problem: null },
      },
      { was: row.state, why: 'due' },
    );
  } catch (error) {
    if (isConflict(error)) return;
    throw error;
  }
  ctx.inflight.add(row.id);
  try {
    const payload = payloadOf(ctx, row, row.mime);
    const started = ctx.clock.now();
    const outcome = await deliver(ctx, row, payload);
    await settle(ctx, { ...row, state: 'sending' }, attemptAt, outcome, started);
  } finally {
    ctx.inflight.delete(row.id);
  }
}

/** The overdue rule (ARCH 7.3, FR-2): a waiting row more than the grace late is suspended, never sent late. */
function suspend(ctx: OutboxCtx, due: DueSubmission, now: number) {
  ignoreConflict(() => {
    transition(
      ctx,
      {
        id: due.id,
        from: [due.state],
        to: 'suspended',
        ifNotBefore: due.notBefore,
        set: { problem: { reasonCode: 'send.overdue', message: OVERDUE_COPY, at: now } },
      },
      { was: due.state, why: 'overdue' },
    );
    ctx.log.event('outbox.suspended', { submission: due.id, lateMs: now - due.notBefore });
  });
}

/** May this account send now? Records a refusal so `next()` waits for its end. */
function admitted(ctx: OutboxCtx, account: string, now: number) {
  const until = ctx.paused.get(account);
  if (ctx.paused.has(account) && until !== undefined && until > now) return false;
  const admission = ctx.send.admission(account);
  if (admission.ok) {
    ctx.paused.delete(account);
    return true;
  }
  ctx.paused.set(account, admission.until);
  return false;
}

/** The deadline source's `fire`. */
export async function fireOutbox(ctx: OutboxCtx, now: number): Promise<void> {
  if (ctx.startRulePending) applyStartRule(ctx);
  const { due, overdue } = ctx.store.read(q => dueSubmissions(q, now));
  for (const row of overdue) suspend(ctx, row, now);
  const checks = ctx.store.read(q =>
    q.all<{ id: string; account: string }>(
      `SELECT id, account_id AS account FROM submissions
       WHERE state = 'uncertain' AND check_at IS NOT NULL AND check_at <= ? ORDER BY check_at, id`,
      now,
    ),
  );
  for (const c of checks)
    if (!ctx.busy.has(c.account)) runJob(ctx, c.account, () => checkSent(ctx, c.id));
  for (const row of due) {
    if (ctx.busy.has(row.accountId) || !admitted(ctx, row.accountId, now)) continue;
    runJob(ctx, row.accountId, () => sendOne(ctx, row));
  }
}

export function outboxSource(ctx: OutboxCtx): DeadlineSource {
  return {
    id: 'outbox',
    next: async () => nextDeadline(ctx),
    fire: now => fireOutbox(ctx, now),
  };
}
