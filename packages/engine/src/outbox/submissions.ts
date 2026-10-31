import type { DraftFields, Receipt, Submission, SubmissionAction } from '@aplos/contract';
import type { StoreReader } from '../store';
import {
  DEFAULT_UNDO_SEND_SECONDS,
  fail,
  hex,
  NO_BYTES_COPY,
  NO_RETRY_COPY,
  transition,
  UNRETRYABLE_CODES,
  type OutboxCtx,
} from './context';
import { DraftConflict, INCOMPLETE_SENTENCE, parseData } from './draft-state';
import { hasSend, sendPins } from './draft-proof';
import {
  buildEnvelope,
  buildMime,
  checkAddress,
  isMessageId,
  MimeError,
  newMessageId,
  withDate,
  type MimeAttachment,
} from './mime';
import {
  extraOf,
  hadAttempt,
  liveSubmissionOf,
  problemOf,
  readSubmission,
  SubmissionConflict,
  toSubmission,
  type NewSubmission,
  type SubmissionMeta,
  type SubmissionRow,
  type SubmissionState,
} from './store';

/**
 * `Submission/set`: the owner's commands on the send state machine (ARCH 7.1-7.3). `send` pins the draft's revision
 * and its exact MIME (one Message-ID, generated here, never again); undo and send later are one `not_before`. Every
 * other action is a compare-and-set on the state it was allowed from, so it cannot race the timer's `sending` commit.
 */

export interface SetResult {
  submission: Submission;
  receipt: Receipt;
}

type RowAction = Exclude<SubmissionAction, { type: 'send' }>;

/** Which states each action may start from (`cancel`: FR-13). */
const ALLOWED: Record<RowAction['type'], readonly SubmissionState[]> = {
  undo: ['queued', 'scheduled'],
  sendNow: ['queued', 'scheduled', 'suspended'],
  reschedule: ['queued', 'scheduled', 'suspended'],
  sendAnyway: ['uncertain'],
  retry: ['failed'],
  cancel: ['failed', 'uncertain', 'suspended'],
};

const DRAFT_CHANGED = 'This draft changed in another window. Reopen it before sending.';
const ON_ITS_WAY = 'This message is already on its way.';
const UNRESOLVED =
  'This draft has a version from another device waiting for your choice. Choose one before sending.';
const ALREADY_SENT = 'This message was already sent. Change it to send another.';
const PAST_TIME = 'Pick a time in the future.';
const NOT_IN_OUTBOX = 'This message is no longer in the outbox.';
const REVISION_CHANGED = 'This message changed. Open it again before sending.';
const STILL_CHECKING = 'We are still checking whether this was sent. Try again in a moment.';
const STILL_CHECKING_CANCEL = 'We are still checking whether this message went out.';

function wrongState(state: SubmissionState): never {
  const sentence: Partial<Record<SubmissionState, string>> = {
    sent: 'This message has already been sent.',
    sending: 'This message is sending now.',
    cancelled: 'This message was cancelled.',
  };
  return fail('stateMismatch', sentence[state] ?? 'This message cannot do that now.');
}

function receipt(ctx: OutboxCtx, opId: string, seq: number, row: SubmissionRow): Receipt {
  const held = row.state === 'queued' || row.state === 'scheduled';
  const out: Receipt = {
    opId,
    appliedState: { dbEpoch: ctx.store.dbEpoch, seq },
    undoable: held,
  };
  if (held) out.undoUntil = row.not_before;
  return out;
}

function answer(ctx: OutboxCtx, opId: string, seq: number, id: string): SetResult {
  const row = ctx.store.read(q => readSubmission(q, id));
  if (!row) return fail('notFound', NOT_IN_OUTBOX);
  return { submission: toSubmission(row), receipt: receipt(ctx, opId, seq, row) };
}

/** A replayed opId answers with what it did the first time and changes nothing. */
function replayed(ctx: OutboxCtx, opId: string, action: SubmissionAction): SetResult | undefined {
  const prior = ctx.store.read(q =>
    q.get<{ seq: number }>('SELECT seq FROM commits WHERE op_id = ?', opId),
  );
  if (!prior) return undefined;
  const id =
    action.type === 'send'
      ? ctx.store.read(q =>
          q.get<{ id: string }>(
            "SELECT id FROM submissions WHERE json_extract(error, '$.opId') = ?",
            opId,
          ),
        )?.id
      : action.submissionId;
  if (id === undefined) return fail('notFound', NOT_IN_OUTBOX);
  return answer(ctx, opId, prior.seq, id);
}

// ---------------------------------------------------------------- send

interface DraftRow {
  id: string;
  account_id: string;
  thread_id: number | null;
  revision: number;
  data: string;
  address: string;
  display_name: string | null;
  remote_internet_id: string | null;
  synced_revision: number | null;
  origin: string;
  remote_draft_id: string | null;
  provider: string;
  [k: string]: string | number | null;
}

function readDraft(q: StoreReader, id: string) {
  return q.get<DraftRow>(
    `SELECT d.id, d.account_id, d.thread_id, d.revision, d.data, d.remote_internet_id, d.synced_revision,
            d.origin, d.remote_draft_id, a.address, a.display_name, a.provider
     FROM drafts d JOIN accounts a ON a.id = d.account_id
     WHERE d.id = ? AND json_extract(d.data, '$._sync.removing') IS NULL`,
    id,
  );
}

export function parseFields(row: { data: string }): DraftFields {
  try {
    return JSON.parse(row.data) as DraftFields;
  } catch {
    return fail('validation', 'This draft could not be read. Open it again before sending.');
  }
}

/** The contract id of `accountId:remoteId`, or undefined when it names another account. */
function remotePart(accountId: string, contractId: string | undefined) {
  const prefix = `${accountId}:`;
  return contractId?.startsWith(prefix) ? contractId.slice(prefix.length) : undefined;
}

export function threadOf(
  q: StoreReader,
  draft: Pick<DraftRow, 'account_id' | 'thread_id'>,
  fields: DraftFields,
) {
  const remote =
    draft.thread_id !== null
      ? q.get<{ remote_id: string }>('SELECT remote_id FROM threads WHERE id = ?', draft.thread_id)
          ?.remote_id
      : remotePart(draft.account_id, fields.threadId);
  return remote === undefined
    ? {}
    : { threadId: `${draft.account_id}:${remote}`, remoteThreadId: remote };
}

/** In-Reply-To and References from the replied message's stored headers; omitted when the store lacks them. */
export function replyHeaders(
  q: StoreReader,
  draft: Pick<DraftRow, 'account_id'>,
  fields: DraftFields,
) {
  if (fields.mode !== 'reply' && fields.mode !== 'replyAll') return {};
  const remoteId = remotePart(draft.account_id, fields.replyToMessageId);
  if (remoteId === undefined) return {};
  const msg = q.get<{ internet_id: string | null; refs: string | null }>(
    'SELECT internet_id, refs FROM messages WHERE account_id = ? AND remote_id = ?',
    draft.account_id,
    remoteId,
  );
  if (!msg?.internet_id) return {};
  let refs: string[] = [];
  try {
    const parsed: unknown = msg.refs ? JSON.parse(msg.refs) : [];
    if (Array.isArray(parsed)) refs = parsed.filter((r): r is string => typeof r === 'string');
  } catch {
    refs = [];
  }
  const all = [...refs, msg.internet_id];
  // Keep the root and the most recent ids, as RFC 5322 suggests for long chains.
  const references = all.length > 20 ? [all[0], ...all.slice(-19)] : all;
  return { inReplyTo: msg.internet_id, references };
}

export function attachmentsOf(
  ctx: Pick<OutboxCtx, 'blobs'>,
  fields: DraftFields,
): MimeAttachment[] {
  return fields.attachments.map(a => {
    const bytes = a.blobId !== undefined ? ctx.blobs?.get(a.blobId) : undefined;
    if (!bytes)
      fail(
        'notFound',
        `The attachment "${a.name}" is no longer available. Attach it again, then send.`,
      );
    return { name: a.name, mime: a.mime, bytes, inline: a.inline, contentId: a.contentId };
  });
}

export const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);

const WRONG_SENDER =
  "Send from this account's own address. Sending as another address is not supported yet.";

/**
 * The sender: the account's own address, whatever the draft says. The contract wants a send-as identity of the account
 * (compose.ts), but the engine stores none yet (`account-read.ts` lists the account address as the only identity), so
 * any other `from` is refused; its display name is kept.
 */
export function senderOf(
  draft: Pick<DraftRow, 'address' | 'display_name'>,
  fields: DraftFields,
): { address: string; name?: string } {
  const own = { address: draft.address, name: draft.display_name ?? undefined };
  if (!fields.from) return own;
  if (fields.from.address.trim().toLowerCase() !== draft.address.trim().toLowerCase())
    fail('validation', WRONG_SENDER, { path: ['action', 'draftId'] });
  return { address: draft.address, name: fields.from.name ?? own.name };
}

/**
 * The Message-ID this send goes out under. A draft whose synced copy is this revision already carries one (the copy is
 * uploaded with it, and `drafts.send` sends that copy), so the row reuses it: `findSent` then looks for the id that
 * really left. Otherwise a fresh one, pinned from here on. Ids are per revision, never shared across them:
 * - `microsoft` never reuses (Graph keeps a draft's Message-ID across edits and `payloadOf` never sends a Microsoft
 *   remote draft, so revision R+1 could share R's id after R went uncertain, was cancelled or actually left);
 * - any other provider skips an id that an earlier submission of ANOTHER revision of this draft already used.
 */
function messageIdOf(
  ctx: OutboxCtx,
  q: StoreReader,
  draft: DraftRow,
  fields: DraftFields,
  sender: string,
): string {
  const remote = draft.remote_internet_id;
  // A draft copy never holds Bcc (see `draftMime`), so a draft with Bcc recipients never leaves as its copy: its id is
  // not shared with the copy, `payloadOf` then sends the pinned MIME, and the Bcc goes in the envelope.
  if (
    remote &&
    !fields.bcc.length &&
    draft.provider !== 'microsoft' &&
    draft.synced_revision === draft.revision &&
    isMessageId(remote) &&
    !usedByOtherRevision(q, draft, remote)
  )
    return remote;
  return newMessageId(ctx.random, domainOf(checkAddress(sender)));
}

function usedByOtherRevision(q: StoreReader, draft: DraftRow, internetId: string) {
  return !!q.get(
    'SELECT 1 FROM submissions WHERE internet_id = ? AND NOT (draft_id = ? AND revision = ?) LIMIT 1',
    internetId,
    draft.id,
    draft.revision,
  );
}

function undoSeconds(ctx: OutboxCtx) {
  const value = ctx.settings?.().undoSendSeconds;
  return typeof value === 'number' && value >= 0 && value <= 60 ? value : DEFAULT_UNDO_SEND_SECONDS;
}

/**
 * A newer copy of the draft that was held while a send pinned it (`changedElsewhere`) is applied once nothing pins the
 * draft, as if it had just been reported: a clean phone draft takes it, an edited one is asked. It runs when a send ends
 * without going out (undo, cancel) and before a new send is checked, so the owner never sends over a version they have not
 * seen. The flag is cleared in the same commit (the report puts it back if a send pins the draft again meanwhile).
 */
export function releaseHeld(ctx: OutboxCtx, draftId: string) {
  const found = ctx.store.read(q => {
    const d = readDraft(q, draftId);
    const copy = d && parseData(d.data).meta.changedElsewhere;
    // The same test the report meets when it is applied: a remote draft is held by `sendPins`, a local one by any send.
    const pinned = d && (d.origin === 'remote' ? sendPins(q, d) : hasSend(q, d.id));
    return d && typeof copy === 'object' && !pinned ? { d, copy } : undefined;
  });
  if (!found) return;
  const { d, copy } = found;
  // Only a report of this very draft is replayed: another account's, or one of a copy this row no longer names (its id
  // changed, or it was forgotten), would insert a stale draft of its own. Those are kept as plain `true`.
  const ours = copy.accountId === d.account_id && d.remote_draft_id === copy.remoteDraftId;
  const clear = {
    kind: 'draft',
    op: 'meta',
    id: draftId,
    patch: { changedElsewhere: ours ? null : true },
  };
  try {
    ctx.store.commit({
      opId: `held:${draftId}:${copy.remoteMessageId}:${ctx.clock.now()}`,
      origin: 'system',
      writes: (ours ? [clear, { ...copy, kind: 'remoteDraft' }] : [clear]) as never,
    });
  } catch (error) {
    if (!(error instanceof DraftConflict)) throw error;
  }
}

/** Everything about the new row except the commit: reads the draft and writes the pinned MIME. */
function prepareSend(
  ctx: OutboxCtx,
  opId: string,
  action: Extract<SubmissionAction, { type: 'send' }>,
): NewSubmission {
  const now = ctx.clock.now();
  releaseHeld(ctx, action.draftId);
  const { draft, live, thread, reply } = ctx.store.read(q => {
    const d = readDraft(q, action.draftId);
    if (!d) return fail('notFound', 'This draft no longer exists.');
    const f = parseFields(d);
    return {
      draft: { row: d, fields: f },
      live: liveSubmissionOf(q, d.id),
      thread: threadOf(q, d, f),
      reply: replyHeaders(q, d, f),
    };
  });
  if (draft.row.revision !== action.revision) fail('stateMismatch', DRAFT_CHANGED);
  if (live) fail('stateMismatch', ON_ITS_WAY);
  const sync = parseData(draft.row.data).meta;
  if (sync.conflict) fail('stateMismatch', UNRESOLVED);
  if (sync.incomplete) fail('unavailable', INCOMPLETE_SENTENCE);
  const { fields } = draft;
  if (!fields.to.length && !fields.cc.length && !fields.bcc.length)
    fail('validation', 'Add at least one recipient.', { path: ['action', 'draftId'] });
  const from = senderOf(draft.row, fields);
  // The Date is when the message is meant to leave (the undo window's end, or the chosen time), not when it was composed.
  const undoAt = now + undoSeconds(ctx) * 1_000;
  const later = action.notBefore !== undefined && action.notBefore > undoAt;
  const notBefore = later ? action.notBefore! : undoAt;
  let mime: Uint8Array;
  let envelope: SubmissionMeta['envelope'];
  let internetId: string;
  try {
    internetId = ctx.store.read(q => messageIdOf(ctx, q, draft.row, fields, from.address));
    envelope = buildEnvelope(from, fields);
    mime = buildMime({
      from,
      to: fields.to,
      cc: fields.cc,
      subject: fields.subject,
      html: fields.html,
      messageId: internetId,
      date: notBefore,
      ...reply,
      attachments: attachmentsOf(ctx, fields),
      randomBytes: ctx.random,
    });
  } catch (error) {
    if (error instanceof MimeError) return fail('validation', error.message);
    throw error;
  }
  const meta: SubmissionMeta = {
    subject: fields.subject,
    toNames: [...fields.to, ...fields.cc].slice(0, 20).map(a => a.name || a.address),
    ...thread,
    envelope,
    attachments: fields.attachments.length,
    opId,
  };
  return {
    id: `sub_${hex(ctx.random(12))}`,
    draftId: draft.row.id,
    accountId: draft.row.account_id,
    internetId,
    mime,
    revision: draft.row.revision,
    state: later ? 'scheduled' : 'queued',
    queuedAt: now,
    notBefore,
    meta,
  };
}

function conflictSentence(error: SubmissionConflict, checking = STILL_CHECKING) {
  if (error.reason === 'draftMissing') return fail('notFound', 'This draft no longer exists.');
  if (error.reason === 'draftRevision') return fail('stateMismatch', DRAFT_CHANGED);
  if (error.reason === 'unresolved') return fail('stateMismatch', UNRESOLVED);
  if (error.reason === 'bodyPending') return fail('unavailable', INCOMPLETE_SENTENCE);
  if (error.reason === 'live') return fail('stateMismatch', ON_ITS_WAY);
  if (error.reason === 'alreadySent') return fail('stateMismatch', ALREADY_SENT);
  if (error.reason === 'checking') return fail('stateMismatch', checking);
  return error.current ? wrongState(error.current) : fail('notFound', NOT_IN_OUTBOX);
}

function send(
  ctx: OutboxCtx,
  opId: string,
  action: Extract<SubmissionAction, { type: 'send' }>,
): SetResult {
  const row = prepareSend(ctx, opId, action);
  let seq: number;
  try {
    seq = ctx.store.commit({
      opId,
      origin: 'local',
      writes: [{ kind: 'submission', op: 'create', row }],
    }).seq;
  } catch (error) {
    if (error instanceof SubmissionConflict) return conflictSentence(error);
    throw error;
  }
  ctx.deadlines.changed('outbox');
  return answer(ctx, opId, seq, row.id);
}

// ---------------------------------------------------------------- the other actions

function moveFor(action: RowAction, row: SubmissionRow, now: number) {
  const requeue = { notBefore: now, problem: null, attemptAt: null } as const;
  switch (action.type) {
    case 'undo':
      return { to: 'cancelled', set: {} } as const;
    case 'cancel':
      return { to: 'cancelled', set: { checkAt: null } } as const;
    case 'sendNow':
      return { to: 'queued', set: { notBefore: now, problem: null } } as const;
    case 'reschedule':
      return { to: 'scheduled', set: { notBefore: action.notBefore, problem: null } } as const;
    case 'sendAnyway':
      // The same Message-ID and bytes: the owner chose to send what may already have left.
      return { to: 'queued', set: { ...requeue, checkCount: 0, checkAt: null } } as const;
    case 'retry':
      return { to: 'queued', set: requeue } as const;
    default:
      return wrongState(row.state);
  }
}

/**
 * A reschedule or Send now changes when the message leaves, so its Date changes with it: the same bytes with a new first
 * header line, hence the same Message-ID. It rides in the move's own commit, which only a waiting row can pass: once the
 * `sending` marker is committed the move loses and the bytes were never touched. A row that has had an attempt is never
 * re-dated: its bytes may already have left (Send anyway re-queues an `uncertain` one), and a retry must go out as the
 * same bytes under the same Message-ID, not as a different message.
 */
function redated<T extends { notBefore?: number }>(row: SubmissionRow, set: T): T {
  if (set.notBefore === undefined || !row.mime || hadAttempt(row)) return set;
  try {
    return { ...set, mime: withDate(row.mime, set.notBefore) };
  } catch (error) {
    if (error instanceof MimeError) return set;
    throw error;
  }
}

/**
 * Send anyway, and cancel of an `uncertain` row, wait for the owner to be asked: a check still pending could find the
 * message, and cancelling would unlock the draft for a second Message-ID while the first one is out.
 */
const needsChecksDone = (action: RowAction, row: SubmissionRow) =>
  action.type === 'sendAnyway' || (action.type === 'cancel' && row.state === 'uncertain');

/** The refusals that depend on the row's problem, not only its state. */
function checkProblem(action: RowAction, row: SubmissionRow) {
  const reason = problemOf(row)?.reasonCode;
  if (
    needsChecksDone(action, row) &&
    (extraOf(row).checkAt !== undefined || reason !== 'send.uncertain')
  )
    fail('stateMismatch', action.type === 'cancel' ? STILL_CHECKING_CANCEL : STILL_CHECKING);
  if (action.type === 'retry' && reason === 'send.noBytes') fail('stateMismatch', NO_BYTES_COPY);
  if (action.type === 'retry' && reason !== undefined && UNRETRYABLE_CODES.has(reason))
    fail('stateMismatch', NO_RETRY_COPY);
}

function act(ctx: OutboxCtx, opId: string, action: RowAction, release: boolean): SetResult {
  const row = ctx.store.read(q => readSubmission(q, action.submissionId));
  if (!row) return fail('notFound', NOT_IN_OUTBOX);
  if (!ALLOWED[action.type].includes(row.state)) wrongState(row.state);
  checkProblem(action, row);
  if ('revision' in action && action.revision !== undefined && action.revision !== row.revision)
    fail('stateMismatch', REVISION_CHANGED);
  const now = ctx.clock.now();
  if (action.type === 'reschedule' && action.notBefore < now) fail('validation', PAST_TIME);
  const move = moveFor(action, row, now);
  const { to } = move;
  const set =
    action.type === 'sendNow' || action.type === 'reschedule' ? redated(row, move.set) : move.set;
  // The same demand inside the commit: a check scheduled after the read above makes it lose.
  const guard = needsChecksDone(action, row) ? { ifChecksDone: true as const } : {};
  let seq: number;
  try {
    seq = transition(
      ctx,
      { id: row.id, from: [row.state], to, ...guard, set },
      { was: row.state, why: action.type, origin: 'local', opId },
    ).seq;
  } catch (error) {
    if (error instanceof SubmissionConflict)
      return conflictSentence(error, action.type === 'cancel' ? STILL_CHECKING_CANCEL : undefined);
    throw error;
  }
  if (to === 'cancelled' && release) {
    try {
      releaseHeld(ctx, row.draft_id);
    } catch {
      // The undo is done and must answer; the held copy is applied by the next send check instead.
    }
  }
  ctx.deadlines.changed('outbox');
  return answer(ctx, opId, seq, row.id);
}

/** `Submission/set`. Throws `ContractError` with the sentence the UI shows. */
export function setSubmission(
  ctx: OutboxCtx,
  opId: string,
  action: SubmissionAction,
  release = true,
): SetResult {
  const prior = replayed(ctx, opId, action);
  if (prior) return prior;
  return action.type === 'send' ? send(ctx, opId, action) : act(ctx, opId, action, release);
}

/** `Submission/get`: unknown ids come back in `notFound`. */
export function getSubmissions(ctx: OutboxCtx, ids: readonly string[]) {
  return ctx.store.read(q => {
    const list: Submission[] = [];
    const notFound: string[] = [];
    for (const id of ids) {
      const row = readSubmission(q, id);
      if (row) list.push(toSubmission(row));
      else notFound.push(id);
    }
    return { list, notFound };
  });
}
