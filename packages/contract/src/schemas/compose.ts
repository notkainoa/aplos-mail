import * as z from 'zod/mini';
import { Address, bool, choice, Count, EpochMs, Id, line, openEnum, Problem, text } from './common';

const mode = ['new', 'reply', 'replyAll', 'forward'] as const;

/**
 * An attachment on a draft: bytes uploaded with `Blob/put`, or a part of an existing message (forward). Never base64.
 * While the draft has a live submission its `blobId` is kept until the submission settles (freeze FR-7): `Blob/release`
 * answers `stateMismatch` and no disconnect drops it, so the bytes that leave are the ones attached at `send`.
 */
export const DraftAttachment = z.object({
  id: Id,
  name: line(500),
  mime: line(200),
  size: Count,
  inline: z.optional(z.boolean()),
  contentId: z.optional(line(200)),
  blobId: z.optional(Id),
  /** Forwarded from a message the account already has. */
  source: z.optional(z.object({ messageId: Id, attachmentId: Id })),
});

/** The fields a client writes (`Draft/set`). Today's 30-file, 25 MB rule is the engine's, with today's sentences. */
export const DraftFields = z.object({
  accountId: Id,
  mode: choice(mode),
  threadId: z.optional(Id),
  /** The message replied to or forwarded. */
  replyToMessageId: z.optional(Id),
  /** A send-as identity of the account; absent uses the account address. */
  from: z.optional(Address),
  to: z.array(Address).check(z.maxLength(500)),
  cc: z.array(Address).check(z.maxLength(500)),
  bcc: z.array(Address).check(z.maxLength(500)),
  subject: text(2_000),
  html: text(1_000_000),
  attachments: z.array(DraftAttachment).check(z.maxLength(30, 'Attach at most 30 files.')),
  signature: bool(),
  signatureSource: z.optional(choice(['custom', 'account'])),
});
export type DraftFields = z.infer<typeof DraftFields>;

/**
 * The local draft is the source of truth; `revision` makes saves compare-and-set (ARCH 7.4). Drafts from other devices
 * (`origin: 'remote'`) show in Drafts, never inside threads (D9).
 */
export const Draft = z.object({
  ...DraftFields.shape,
  mode: openEnum(mode),
  signatureSource: z.optional(openEnum(['custom', 'account'])),
  id: Id,
  rev: Count,
  revision: Count,
  updatedAt: EpochMs,
  origin: openEnum(['local', 'remote']),
  sync: openEnum(['localOnly', 'pending', 'synced', 'failed']),
  /**
   * True for a draft written on another device whose text this device cannot read yet (providers deliver a snippet,
   * not the body; `html` then holds only that fragment). `Submission/set` answers `unavailable` for it, and
   * `Draft/set` saves an edit as a NEW local draft (the reply's `draft.id` is the new id; use it and its `revision`
   * for later saves) instead of overwriting the other device's draft. Absent or false means the full text is here.
   */
  incomplete: z.optional(z.boolean()),
  /** Set when another device changed the draft: "keep mine, take theirs, or keep both" (`Draft/resolve`). */
  conflict: z.optional(
    z.object({ theirsRevision: Count, at: EpochMs, device: z.optional(line(200)) }),
  ),
  /**
   * The live submission while one is queued, scheduled, sending, uncertain, failed or suspended. The draft is locked
   * meanwhile (freeze FR-7): `Draft/set` and `Draft/resolve` answer `stateMismatch` ("undo" or "cancel" the send to edit
   * it), or `conflict` while sending, so the bytes that leave are the revision the owner sent.
   */
  submissionId: z.optional(Id),
});
export type Draft = z.infer<typeof Draft>;

/**
 * The send state machine (ARCH 7.1-7.3): `queued` inside the undo window, `scheduled` for send later (one `notBefore`
 * mechanism, ADR-16), `sending` once the attempt marker is committed, then `sent`, `uncertain` (never replayed; the
 * engine checks Sent), `failed` (provably not sent, Retry offered), `cancelled` (undone or cancelled) or `suspended`
 * (missed its time while the Mac was off).
 *
 * The overdue rule (ARCH 7.3, freeze FR-2) covers every row waiting on `notBefore` (`WAITING_SUBMISSION_STATES` in
 * `@aplos/contract/rules`: `queued` and `scheduled` alike): one found at launch or wake more than `OVERDUE_GRACE_MS`
 * (5 minutes) past `notBefore` becomes `suspended` ("Send now or Reschedule") and is never sent late on its own. A
 * `sending` row is never suspended; it becomes `uncertain`. Both are defined once there, for the engine and the stand-in.
 */
export const SubmissionState = openEnum([
  'queued',
  'scheduled',
  'sending',
  'sent',
  'uncertain',
  'failed',
  'cancelled',
  'suspended',
]);

export const Submission = z.object({
  id: Id,
  rev: Count,
  draftId: Id,
  accountId: Id,
  threadId: z.optional(Id),
  /** The stable Message-ID, generated once and never regenerated. */
  internetId: line(1_000),
  /** The draft revision this submission sends, exactly: recorded at `send`, never moved by a later edit (FR-7). */
  revision: Count,
  state: SubmissionState,
  /** When the send was queued; with `notBefore` it gives the undo tray's drain bar its length, whatever the undo setting says now. */
  queuedAt: EpochMs,
  notBefore: EpochMs,
  attemptAt: z.optional(EpochMs),
  sentAt: z.optional(EpochMs),
  /** Recipient display names for "Sending to Jordan in 8 s". */
  toNames: z.array(line(200)),
  subject: text(2_000),
  /** Why it failed or is uncertain or suspended; `until` for the daily send limit ("Couldn't send until 2:14 PM"). */
  problem: z.optional(z.object({ ...Problem.shape, until: z.optional(EpochMs) })),
});
export type Submission = z.infer<typeof Submission>;

/**
 * One `Submission/set` command per user intent. Input: closed. `revision` on `sendNow`, `sendAnyway` and `retry`, when
 * given, must equal `Submission.revision` (else `stateMismatch`): the confirmation names the bytes the owner saw.
 */
export const SubmissionAction = z.discriminatedUnion('type', [
  /**
   * Send the draft's current revision after the undo window, or at `notBefore` (send later). The receipt is
   * `undoable` until `notBefore`: `Operation/undo` on its `opId` is the same as `undo` (freeze FR-14).
   */
  z.object({
    type: z.literal('send'),
    draftId: Id,
    revision: Count,
    notBefore: z.optional(EpochMs),
    alsoDone: z.optional(bool()),
  }),
  /** Cancel a `queued` or `scheduled` send before `notBefore`; the draft comes back unlocked. */
  z.object({ type: z.literal('undo'), submissionId: Id }),
  z.object({ type: z.literal('sendNow'), submissionId: Id, revision: z.optional(Count) }),
  z.object({ type: z.literal('reschedule'), submissionId: Id, notBefore: EpochMs }),
  /** After "We could not confirm this was sent": the user chose Send anyway. */
  z.object({ type: z.literal('sendAnyway'), submissionId: Id, revision: z.optional(Count) }),
  /** After a provably-not-sent failure. */
  z.object({ type: z.literal('retry'), submissionId: Id, revision: z.optional(Count) }),
  /**
   * "Don't send it" for a `failed`, `uncertain` or `suspended` send (freeze FR-13): it becomes `cancelled` and the draft
   * comes back unlocked. An `uncertain` one may still have left; the UI says so.
   */
  z.object({ type: z.literal('cancel'), submissionId: Id }),
]);
export type SubmissionAction = z.infer<typeof SubmissionAction>;
