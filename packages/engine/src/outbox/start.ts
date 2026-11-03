import type { FindSentResult } from '../ports/provider';
import {
  CLOCK_SKEW_MARGIN_MS,
  MAX_CHECKS,
  RECHECK_MS,
  transition,
  UNCERTAIN_COPY,
  type OutboxCtx,
} from './context';
import {
  extraOf,
  LIVE_STATES,
  readSubmission,
  SubmissionConflict,
  type SubmissionRow,
  type SubmissionState,
} from './store';

/**
 * The start rule (frozen `SendPort` rule, ARCH 7.3): a `sending` row this instance is not awaiting is a send whose
 * outcome was lost (the app died after the marker, or a settle commit failed). It becomes `uncertain` at once, with a
 * `findSent` check due now, which runs before any other send of that account. It is never suspended, re-queued or
 * re-sent. The runner applies it on every fire, not only at launch, so a host wake needs no separate signal.
 */
export function lostSending(ctx: OutboxCtx): { id: string; attempt_at: number | null }[] {
  const rows = ctx.store.read(q =>
    q.all<{ id: string; attempt_at: number | null }>(
      "SELECT id, attempt_at FROM submissions WHERE state = 'sending' ORDER BY id",
    ),
  );
  return rows.filter(row => !ctx.inflight.has(row.id));
}

/** `now` is the fire's own, so a check due "now" is due in the same pass (a second clock read could be later). */
export function applyStartRule(ctx: OutboxCtx, now = ctx.clock.now()): number {
  let moved = 0;
  for (const row of lostSending(ctx)) {
    try {
      transition(
        ctx,
        {
          id: row.id,
          from: ['sending'],
          to: 'uncertain',
          // The attempt marker is the guard: a row that was re-marked by a newer attempt is not this one.
          ...(row.attempt_at !== null ? { ifAttemptAt: row.attempt_at } : {}),
          set: { checkCount: 0, checkAt: now },
        },
        { was: 'sending', why: 'startRule' },
      );
      moved++;
    } catch (error) {
      if (!(error instanceof SubmissionConflict)) throw error;
    }
  }
  return moved;
}

/**
 * At launch, an `uncertain` row that already showed its prompt gets one more round of checks: the search index or the
 * Sent sync may have caught up while Aplos was quit. Rows with a check already due are left alone, except that a due
 * time more than one recheck away is pulled in (`pullInChecks`).
 */
export function recheckUncertain(ctx: OutboxCtx): void {
  const now = ctx.clock.now();
  const rows = ctx.store.read(q =>
    q.all<SubmissionRow>("SELECT * FROM submissions WHERE state = 'uncertain'"),
  );
  for (const row of rows) {
    if (extraOf(row).checkAt !== undefined) continue;
    try {
      transition(
        ctx,
        { id: row.id, from: ['uncertain'], to: 'uncertain', set: { checkCount: 0, checkAt: now } },
        { was: 'uncertain', why: 'startRule' },
      );
    } catch (error) {
      if (!(error instanceof SubmissionConflict)) throw error;
    }
  }
  pullInChecks(ctx, now);
}

/**
 * A pending check is never due more than one recheck (60 s) from now. A due time further away was set against a wall
 * clock that has since moved back (a manual change, a bad NTP step, a restored VM): left alone, the second `findSent` of
 * a send would wait out the difference, and the owner would not be asked for hours while the message may be lost. A due
 * time in the past (the clock moved forward) is already prompt and is left alone. Only the due time moves; the count of
 * checks done is kept, so the owner is still asked after the one remaining check. Runs at launch, on a wake and on every
 * fire; a legitimate due time is at most `RECHECK_MS` ahead, so it never touches one.
 */
export function pullInChecks(ctx: OutboxCtx, now = ctx.clock.now()): void {
  const rows = ctx.store.read(q =>
    q.all<SubmissionRow>("SELECT * FROM submissions WHERE state = 'uncertain'"),
  );
  for (const row of rows) {
    const checkAt = extraOf(row).checkAt;
    if (checkAt === undefined || checkAt <= now + RECHECK_MS) continue;
    try {
      transition(
        ctx,
        { id: row.id, from: ['uncertain'], to: 'uncertain', set: { checkAt: now + RECHECK_MS } },
        { was: 'uncertain', why: 'clockMoved' },
      );
    } catch (error) {
      if (!(error instanceof SubmissionConflict)) throw error;
    }
  }
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
  const extra = extraOf(row);
  // A wall clock set back after the marker must not push `since` past the message it is looking for.
  const attempt = Math.min(row.attempt_at ?? extra.queuedAt, ctx.clock.now());
  const since = attempt - CLOCK_SKEW_MARGIN_MS;
  const result = await findSent(ctx, row.account_id, row.internet_id, since);
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
      const checks = extra.checkCount + 1;
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
