/**
 * Frozen send rules shared by the contract, the engine's ports and store, and the stand-in engine (freeze FR-2),
 * defined once here so they cannot drift. No zod, so the neutral engine may import it.
 */

/** Submission states waiting on `notBefore`. The overdue rule applies to these, never to `sending`. */
export const WAITING_SUBMISSION_STATES = ['queued', 'scheduled'] as const;
export type WaitingSubmissionState = (typeof WAITING_SUBMISSION_STATES)[number];

/** A waiting submission that would leave more than this past `notBefore` becomes `suspended` instead (ARCH 7.3). */
export const OVERDUE_GRACE_MS = 5 * 60_000;
