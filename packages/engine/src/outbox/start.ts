import type { FindSentResult } from '../ports/provider';
import {
  MAX_CHECKS,
  RECHECK_MS,
  transition,
  UNCERTAIN_COPY,
  type MoveWrite,
  type OutboxCtx,
} from './context';
import { LIVE_STATES, readSubmission, SubmissionConflict, type SubmissionState } from './store';

/**
 * The start rule (frozen `SendPort` rule, ARCH 7.3): a `sending` row this instance is not awaiting is a send whose
 * outcome was lost (the app died after the marker). It becomes `uncertain` at once, with a `findSent` check due now,
 * which the timer runs before any other send of that account. It is never suspended, re-queued or re-sent.
 */
export function applyStartRule(ctx: OutboxCtx): number {
  const now = ctx.clock.now();
  const rows = ctx.store.read(q =>
    q.all<{ id: string; attempt_at: number | null }>(
      "SELECT id, attempt_at FROM submissions WHERE state = 'sending' ORDER BY id",
    ),
  );
  let moved = 0;
  for (const row of rows) {
    if (ctx.inflight.has(row.id)) continue;
    const move: MoveWrite = {
      id: row.id,
      from: ['sending'],
      to: 'uncertain',
      set: { checkCount: 0, checkAt: now },
    };
    if (row.attempt_at !== null) move.ifAttemptAt = row.attempt_at;
    try {
      transition(ctx, move, { was: 'sending', why: 'startRule' });
      moved++;
    } catch (error) {
      if (!(error instanceof SubmissionConflict)) throw error;
    }
  }
  ctx.startRulePending = false;
  return moved;
}

/** Everything still holding the draft except `sending`, whose own attempt settles it. */
const SETTLES_AS_SENT: readonly SubmissionState[] = LIVE_STATES.filter(s => s !== 'sending');

async function findSent(
  ctx: OutboxCtx,
  account: string,
  internetId: string,
  since: number,
): Promise<FindSentResult | undefined> {
  try {
    return await ctx.send.findSent(account, internetId, since);
  } catch {
    // Offline, paused or a provider error: it counts as a check that found nothing, so the owner is never left waiting.
    return undefined;
  }
}

/**
 * One `findSent` for an `uncertain` row (ARCH 7.1): found settles `sent`; not found re-checks once after 60 s, then
 * leaves the row `uncertain` with the prompt ("Check Sent, or Send anyway"). Never sends anything.
 */
export async function checkSent(ctx: OutboxCtx, id: string): Promise<void> {
  const row = ctx.store.read(q => readSubmission(q, id));
  if (!row || row.state !== 'uncertain') return;
  const result = await findSent(
    ctx,
    row.account_id,
    row.internet_id,
    row.attempt_at ?? row.queued_at,
  );
  const now = ctx.clock.now();
  const guard = row.attempt_at !== null ? { ifAttemptAt: row.attempt_at } : {};
  try {
    if (result?.kind === 'found') {
      const current = ctx.store.read(q => readSubmission(q, id))?.state ?? 'uncertain';
      transition(
        ctx,
        {
          id,
          from: SETTLES_AS_SENT,
          to: 'sent',
          set: {
            sentAt: now,
            remoteMessageId: result.remoteMessageId,
            remoteThreadId: result.remoteThreadId ?? null,
            problem: null,
            checkAt: null,
            dropMime: true,
          },
        },
        { was: current, why: 'findSent' },
      );
    } else {
      const checks = row.check_count + 1;
      const last = checks >= MAX_CHECKS;
      transition(
        ctx,
        {
          id,
          from: ['uncertain'],
          to: 'uncertain',
          ...guard,
          set: {
            checkCount: checks,
            checkAt: last ? null : now + RECHECK_MS,
            ...(last
              ? { problem: { reasonCode: 'send.uncertain', message: UNCERTAIN_COPY, at: now } }
              : {}),
          },
        },
        { was: 'uncertain', why: 'findSent' },
      );
    }
  } catch (error) {
    // The owner or another engine moved it first (Send anyway, Cancel): nothing to settle.
    if (!(error instanceof SubmissionConflict)) throw error;
    return;
  }
  ctx.log.event('send.reconciled', {
    submission: id,
    found: result?.kind === 'found',
    method: 'findSent',
  });
}
