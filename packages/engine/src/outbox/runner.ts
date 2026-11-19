import type { ClassifiedError } from '@aplos/contract';
import { OVERDUE_GRACE_MS } from '@aplos/contract/rules';
import { NotSentError, PausedError, ProviderError, type Admission } from '../ports/base';
import type { SendReceipt, SubmissionPayload } from '../ports/provider';
import type { DeadlineSource } from '../ports/time';
import { dueSubmissions, type DueSubmission, type StoreReader } from '../store';
import {
  AUTH_COPY,
  NO_BYTES_COPY,
  OFFLINE_COPY,
  OVERDUE_COPY,
  PAUSE_POLL_MS,
  transition,
  UNRETRYABLE,
  type OutboxCtx,
} from './context';
import { KP, killpoint } from './killpoints';
import { applyStartRule, checkSent, lostSending, pullInChecks } from './start';
import {
  extraOf,
  hadAttempt,
  readSubmission,
  SubmissionConflict,
  type SubmissionProblem,
  type SubmissionRow,
  type SubmissionState,
} from './store';

/**
 * The `outbox` deadline source and the sends it starts (ARCH 7.1-7.3). A fire recovers lost `sending` rows, suspends
 * overdue rows, then gives each account at most one job: a due `findSent` check first, else its earliest due send.
 * Jobs run detached, so a slow provider never holds the timer loop; when one ends it reports `changed('outbox')` and
 * the loop fires again.
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
      // A store failure mid-job leaves the row where the next fire finds it; a `sending` row becomes `uncertain`.
      // The log catalog has no generic error event, and the row's own state is what the owner sees.
    })
    .finally(() => {
      ctx.busy.delete(account);
      ctx.deadlines.changed('outbox');
    });
  ctx.busy.set(account, done);
}

// ---------------------------------------------------------------- next()

/** The end of the account's pause, or one poll from now when the refusal named no end. */
function pauseEnd(ctx: OutboxCtx, account: string, now: number) {
  const until = ctx.paused.get(account);
  return until !== undefined && until > now ? until : now + PAUSE_POLL_MS;
}

/**
 * When a waiting row of `account` next needs the timer. A paused account wakes at the end of its pause, but never
 * later than the moment the row turns overdue; a busy one only needs the timer for the overdue rule.
 */
function waitingDeadline(ctx: OutboxCtx, account: string, notBefore: number, now: number) {
  const suspendAt = notBefore + OVERDUE_GRACE_MS + 1;
  if (ctx.busy.has(account)) return suspendAt;
  if (!ctx.paused.has(account)) return notBefore;
  return Math.min(Math.max(notBefore, pauseEnd(ctx, account, now)), suspendAt);
}

function earliest(ctx: OutboxCtx, q: StoreReader, now: number): number | undefined {
  let best: number | undefined;
  const take = (at: number) => {
    if (best === undefined || at < best) best = at;
  };
  const open = q.all<{ id: string; account: string; state: SubmissionState; error: string | null }>(
    `SELECT id, account_id AS account, state, error FROM submissions WHERE state IN ('sending', 'uncertain')`,
  );
  for (const row of open) {
    if (row.state === 'sending') {
      if (!ctx.inflight.has(row.id)) take(now);
      continue;
    }
    const checkAt = extraOf(row as unknown as SubmissionRow).checkAt;
    if (checkAt !== undefined && !ctx.busy.has(row.account)) take(checkAt);
  }
  const waiting = q.all<{ account: string; at: number }>(
    `SELECT account_id AS account, min(not_before) AS at FROM submissions
     WHERE state IN ('queued', 'scheduled') GROUP BY account_id`,
  );
  for (const w of waiting) take(waitingDeadline(ctx, w.account, w.at, now));
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
  const own = UNRETRYABLE[error.class];
  if (own) return { ...own, at: now };
  if (error.class === 'auth') return { reasonCode: 'auth.expired', message: AUTH_COPY, at: now };
  return { reasonCode: 'net.offline', message: OFFLINE_COPY, at: now };
}

/**
 * The payload: the pinned MIME, plus the remote draft only when this is the FIRST attempt and its synced copy is
 * provably this revision (FR-7). `row` is read before the `sending` marker, so `hadAttempt(row)` is true only for an
 * earlier attempt (Send anyway, Retry, a requeue): that one may have consumed the remote draft (`drafts.send` moves it
 * to Sent), so a later attempt never names it and sends the pinned MIME under the same Message-ID.
 */
function payloadOf(ctx: OutboxCtx, row: SubmissionRow, mime: Uint8Array): SubmissionPayload {
  const meta = extraOf(row);
  const payload: SubmissionPayload = {
    submissionId: row.id,
    internetId: row.internet_id,
    mime,
    envelope: meta.envelope,
  };
  if (meta.remoteThreadId) payload.remoteThreadId = meta.remoteThreadId;
  if (hadAttempt(row)) return payload;
  const draft = ctx.store.read(q =>
    q.get<{
      remote_draft_id: string | null;
      remote_message_id: string | null;
      remote_internet_id: string | null;
      synced_revision: number | null;
      provider: string;
    }>(
      `SELECT d.remote_draft_id, d.remote_message_id, d.remote_internet_id, d.synced_revision, a.provider
       FROM drafts d JOIN accounts a ON a.id = d.account_id WHERE d.id = ?`,
      row.draft_id,
    ),
  );
  // The remote copy leaves only under its own Message-ID, which `prepareSend` reused for this row when the copy was
  // synced at this revision. Any other draft would send under an id `findSent` could never find (a second copy).
  if (!draft?.remote_draft_id || draft.remote_internet_id !== row.internet_id) return payload;
  // DECISION (time-2): Graph (`microsoft`) keeps a message's id across edits and the store has no change-key column
  // for the submission, so neither the id nor the revision proves the remote copy is the pinned one. For those accounts
  // the outbox never names the remote draft (nor baseRemoteMessageId / baseChangeKey): they always send the pinned MIME.
  if (draft.provider === 'microsoft') return payload;
  payload.remoteDraftId = draft.remote_draft_id;
  if (draft.synced_revision === row.revision && draft.remote_message_id)
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

/** What a settle needs besides the outcome: the waiting state the row left, and its attempt marker. */
interface Attempt {
  row: SubmissionRow;
  waiting: SubmissionState;
  attemptAt: number;
  started: number;
}

function settleSent(ctx: OutboxCtx, a: Attempt, receipt: SendReceipt | undefined) {
  const meta = extraOf(a.row);
  const acceptedAt = receipt?.acceptedAt ?? ctx.clock.now();
  ignoreConflict(() =>
    transition(
      ctx,
      {
        id: a.row.id,
        from: ['sending', 'uncertain'],
        to: 'sent',
        ifAttemptAt: a.attemptAt,
        set: {
          sentAt: acceptedAt,
          remoteMessageId: receipt?.remoteMessageId ?? null,
          remoteThreadId: receipt?.remoteThreadId ?? meta.remoteThreadId ?? null,
          problem: null,
          checkAt: null,
          dropMime: true,
          ...(receipt?.draftConsumed ? { draftConsumed: true as const } : {}),
        },
      },
      { was: 'sending', why: 'sent' },
    ),
  );
  ctx.log.event('send.sent', {
    submission: a.row.id,
    durationMs: Math.max(0, ctx.clock.now() - a.started),
    recipients: meta.envelope.rcpt.length,
    attachments: meta.attachments,
    bytes: a.row.mime?.length ?? 0,
  });
  // The row is already `sent`; a wake that throws must never read as a failed send.
  try {
    ctx.afterSend?.(a.row.account_id);
  } catch {
    // The next poll catches the message.
  }
}

function settleFailed(ctx: OutboxCtx, a: Attempt, error: ClassifiedError) {
  const now = ctx.clock.now();
  ignoreConflict(() =>
    transition(
      ctx,
      {
        id: a.row.id,
        from: ['sending', 'uncertain'],
        to: 'failed',
        ifAttemptAt: a.attemptAt,
        set: { problem: problemOf(error, now), checkAt: null },
      },
      { was: 'sending', why: 'notSent' },
    ),
  );
  ctx.log.event('send.failed', { submission: a.row.id, error });
}

/** Anything `send` threw that proves nothing: `uncertain`, then `findSent` at once (never replayed). */
async function settleUncertain(ctx: OutboxCtx, a: Attempt, error: unknown) {
  const now = ctx.clock.now();
  let moved = true;
  try {
    transition(
      ctx,
      {
        id: a.row.id,
        from: ['sending'],
        to: 'uncertain',
        ifAttemptAt: a.attemptAt,
        set: { checkCount: 0, checkAt: now },
      },
      { was: 'sending', why: 'uncertain' },
    );
  } catch (e) {
    if (!isConflict(e)) throw e;
    moved = false;
  }
  ctx.log.event('send.uncertain', {
    submission: a.row.id,
    method: 'send',
    durationMs: Math.max(0, now - a.started),
    ...(error instanceof ProviderError ? { error: error.error } : {}),
  });
  if (moved) await checkSent(ctx, a.row.id);
}

function settlePaused(ctx: OutboxCtx, a: Attempt, error: PausedError) {
  if (error.cls === 'send_limit')
    return settleFailed(ctx, a, {
      class: 'send_limit',
      provider: error.budget,
      method: 'send',
      reason: error.reason,
      ...(error.until !== undefined ? { resumeAt: error.until } : {}),
    });
  // Provably not sent and only paused: waiting again on the same notBefore, retried at `until`, under the overdue rule.
  ctx.paused.set(a.row.account_id, error.until);
  ignoreConflict(() =>
    transition(
      ctx,
      {
        id: a.row.id,
        from: ['sending'],
        to: a.waiting,
        ifAttemptAt: a.attemptAt,
        // Back to the marker the row had before this attempt: an earlier attempt's bytes may be out there.
        set: { attemptAt: a.row.attempt_at, attempted: extraOf(a.row).attempted === true },
      },
      { was: 'sending', why: 'paused' },
    ),
  );
}

async function settle(ctx: OutboxCtx, a: Attempt, outcome: Outcome) {
  if (outcome.ok) return settleSent(ctx, a, outcome.receipt);
  const { error } = outcome;
  if (error instanceof NotSentError) return settleFailed(ctx, a, error.error);
  if (error instanceof PausedError) return settlePaused(ctx, a, error);
  return settleUncertain(ctx, a, error);
}

/** The marker: false when the row moved first (an undo, another engine) and nothing may be sent. */
function commitMarker(ctx: OutboxCtx, row: SubmissionRow, attemptAt: number): boolean {
  try {
    transition(
      ctx,
      {
        id: row.id,
        from: [row.state],
        to: 'sending',
        ifNotBefore: row.not_before,
        set: { attemptAt, attempted: true, problem: null },
      },
      { was: row.state, why: 'due' },
    );
    return true;
  } catch (error) {
    if (isConflict(error)) return false;
    throw error;
  }
}

/**
 * One send: the `sending` marker (state and `attempt_at`) is committed, compare-and-set on the waiting row the timer
 * saw, before `SendPort.send` is called; a lost compare-and-set (undo, another engine) sends nothing. Everything that
 * can fail without the bytes leaving (the payload, the checks) happens before the marker.
 */
async function sendOne(ctx: OutboxCtx, due: DueSubmission) {
  const row = ctx.store.read(q => readSubmission(q, due.id));
  if (!row || row.state !== due.state || row.not_before !== due.notBefore) return;
  const attemptAt = ctx.clock.now();
  if (attemptAt - row.not_before > OVERDUE_GRACE_MS) return suspend(ctx, due, attemptAt);
  if (!row.mime) return failWithoutBytes(ctx, due, attemptAt);
  const payload = payloadOf(ctx, row, row.mime);
  ctx.inflight.add(row.id);
  try {
    if (typeof __APLOS_TEST_MODE__ === 'undefined' || __APLOS_TEST_MODE__)
      killpoint(KP.BEFORE_MARKER);
    if (!commitMarker(ctx, row, attemptAt)) return;
    if (typeof __APLOS_TEST_MODE__ === 'undefined' || __APLOS_TEST_MODE__)
      killpoint(KP.AFTER_MARKER);
    const a: Attempt = { row, waiting: due.state, attemptAt, started: ctx.clock.now() };
    const outcome = await deliver(ctx, row, payload);
    if ((typeof __APLOS_TEST_MODE__ === 'undefined' || __APLOS_TEST_MODE__) && outcome.ok)
      killpoint(KP.AFTER_ACCEPT);
    await settle(ctx, a, outcome);
  } finally {
    ctx.inflight.delete(row.id);
  }
}

/** A waiting row with no kept bytes cannot be sent; it must say so instead of waiting forever. */
function failWithoutBytes(ctx: OutboxCtx, due: DueSubmission, now: number) {
  ignoreConflict(() =>
    transition(
      ctx,
      {
        id: due.id,
        from: [due.state],
        to: 'failed',
        ifNotBefore: due.notBefore,
        set: {
          problem: {
            reasonCode: 'send.noBytes',
            message: NO_BYTES_COPY,
            at: now,
          },
        },
      },
      { was: due.state, why: 'noBytes' },
    ),
  );
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

/** The daily send limit is a failure with Retry, not a wait: it is never retried on its own (D7). */
function failForSendLimit(
  ctx: OutboxCtx,
  due: DueSubmission,
  refusal: Extract<Admission, { ok: false }>,
  now: number,
) {
  const error: ClassifiedError = {
    class: 'send_limit',
    provider: 'gmail',
    method: 'send',
    reason: refusal.reason,
    ...(refusal.until !== undefined ? { resumeAt: refusal.until } : {}),
  };
  ignoreConflict(() => {
    transition(
      ctx,
      {
        id: due.id,
        from: [due.state],
        to: 'failed',
        ifNotBefore: due.notBefore,
        set: { problem: problemOf(error, now) },
      },
      { was: due.state, why: 'sendLimit' },
    );
    ctx.log.event('send.failed', { submission: due.id, error });
  });
}

/** May this account send now? Remembers a refusal so `next()` waits for its end. */
function admission(ctx: OutboxCtx, account: string, now: number): Admission {
  const until = ctx.paused.get(account);
  if (until !== undefined && until > now)
    return { ok: false, cls: 'throttle', reason: 'paused', until };
  const answer = ctx.send.admission(account);
  // A send-limit refusal fails the row instead of waiting (D7), so there is no pause to remember.
  if (answer.ok || answer.cls === 'send_limit') ctx.paused.delete(account);
  else ctx.paused.set(account, answer.until);
  return answer;
}

function startChecks(ctx: OutboxCtx, now: number) {
  const checks = ctx.store.read(q =>
    q.all<{ id: string; account: string; error: string | null }>(
      "SELECT id, account_id AS account, error FROM submissions WHERE state = 'uncertain' ORDER BY id",
    ),
  );
  const due = checks
    .map(c => ({ ...c, at: extraOf(c as unknown as SubmissionRow).checkAt }))
    .filter(c => c.at !== undefined && c.at <= now)
    .sort((a, b) => a.at! - b.at! || (a.id < b.id ? -1 : 1));
  for (const c of due)
    if (!ctx.busy.has(c.account)) runJob(ctx, c.account, () => checkSent(ctx, c.id));
}

function startSends(ctx: OutboxCtx, due: DueSubmission[], now: number) {
  for (const row of due) {
    if (ctx.busy.has(row.accountId)) continue;
    const answer = admission(ctx, row.accountId, now);
    if (answer.ok) runJob(ctx, row.accountId, () => sendOne(ctx, row));
    else if (answer.cls === 'send_limit') failForSendLimit(ctx, row, answer, now);
  }
}

/** The deadline source's `fire`. */
export async function fireOutbox(ctx: OutboxCtx, now: number): Promise<void> {
  if (lostSending(ctx).length) applyStartRule(ctx, now);
  pullInChecks(ctx, now);
  const { due, overdue } = ctx.store.read(q => dueSubmissions(q, now));
  for (const row of overdue) suspend(ctx, row, now);
  startChecks(ctx, now);
  startSends(ctx, due, now);
}

export function outboxSource(ctx: OutboxCtx): DeadlineSource {
  return {
    id: 'outbox',
    next: async () => nextDeadline(ctx),
    fire: now => fireOutbox(ctx, now),
  };
}
