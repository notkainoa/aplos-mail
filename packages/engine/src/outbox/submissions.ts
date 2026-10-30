import type { DraftFields, Receipt, Submission, SubmissionAction } from '@aplos/contract';
import type { StoreReader } from '../store';
import { DEFAULT_UNDO_SEND_SECONDS, fail, hex, transition, type OutboxCtx } from './context';
import {
  buildEnvelope,
  buildMime,
  checkAddress,
  MimeError,
  newMessageId,
  type MimeAttachment,
} from './mime';
import {
  liveSubmissionOf,
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
const ALREADY_SENT = 'This message was already sent. Change it to send another.';
const PAST_TIME = 'Pick a time in the future.';
const NOT_IN_OUTBOX = 'This message is no longer in the outbox.';
const REVISION_CHANGED = 'This message changed. Open it again before sending.';

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
  [k: string]: string | number | null;
}

function readDraft(q: StoreReader, id: string) {
  return q.get<DraftRow>(
    `SELECT d.id, d.account_id, d.thread_id, d.revision, d.data, a.address, a.display_name
     FROM drafts d JOIN accounts a ON a.id = d.account_id WHERE d.id = ?`,
    id,
  );
}

function parseFields(row: DraftRow): DraftFields {
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

function threadOf(q: StoreReader, draft: DraftRow, fields: DraftFields) {
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
function replyHeaders(q: StoreReader, draft: DraftRow, fields: DraftFields) {
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

function attachmentsOf(ctx: OutboxCtx, fields: DraftFields): MimeAttachment[] {
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

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);

function undoSeconds(ctx: OutboxCtx) {
  const value = ctx.settings?.().undoSendSeconds;
  return typeof value === 'number' && value >= 0 && value <= 60 ? value : DEFAULT_UNDO_SEND_SECONDS;
}

/** Everything about the new row except the commit: reads the draft and writes the pinned MIME. */
function prepareSend(
  ctx: OutboxCtx,
  opId: string,
  action: Extract<SubmissionAction, { type: 'send' }>,
): NewSubmission {
  const now = ctx.clock.now();
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
  const { fields } = draft;
  if (!fields.to.length && !fields.cc.length && !fields.bcc.length)
    fail('validation', 'Add at least one recipient.', { path: ['action', 'draftId'] });
  const from = fields.from ?? {
    address: draft.row.address,
    name: draft.row.display_name ?? undefined,
  };
  let mime: Uint8Array;
  let envelope: SubmissionMeta['envelope'];
  let internetId: string;
  try {
    internetId = newMessageId(ctx.random, domainOf(checkAddress(from.address)));
    envelope = buildEnvelope(from, fields);
    mime = buildMime({
      from,
      to: fields.to,
      cc: fields.cc,
      subject: fields.subject,
      html: fields.html,
      messageId: internetId,
      date: now,
      ...reply,
      attachments: attachmentsOf(ctx, fields),
      randomBytes: ctx.random,
    });
  } catch (error) {
    if (error instanceof MimeError) return fail('validation', error.message);
    throw error;
  }
  const undoAt = now + undoSeconds(ctx) * 1_000;
  const later = action.notBefore !== undefined && action.notBefore > undoAt;
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
    notBefore: later ? action.notBefore! : undoAt,
    meta,
  };
}

function conflictSentence(error: SubmissionConflict) {
  if (error.reason === 'draftMissing') return fail('notFound', 'This draft no longer exists.');
  if (error.reason === 'draftRevision') return fail('stateMismatch', DRAFT_CHANGED);
  if (error.reason === 'live') return fail('stateMismatch', ON_ITS_WAY);
  if (error.reason === 'alreadySent') return fail('stateMismatch', ALREADY_SENT);
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

function act(ctx: OutboxCtx, opId: string, action: RowAction): SetResult {
  const row = ctx.store.read(q => readSubmission(q, action.submissionId));
  if (!row) return fail('notFound', NOT_IN_OUTBOX);
  if (!ALLOWED[action.type].includes(row.state)) wrongState(row.state);
  if ('revision' in action && action.revision !== undefined && action.revision !== row.revision)
    fail('stateMismatch', REVISION_CHANGED);
  const now = ctx.clock.now();
  if (action.type === 'reschedule' && action.notBefore < now) fail('validation', PAST_TIME);
  const { to, set } = moveFor(action, row, now);
  let seq: number;
  try {
    seq = transition(
      ctx,
      { id: row.id, from: [row.state], to, set },
      { was: row.state, why: action.type, origin: 'local', opId },
    ).seq;
  } catch (error) {
    if (error instanceof SubmissionConflict) return conflictSentence(error);
    throw error;
  }
  ctx.deadlines.changed('outbox');
  return answer(ctx, opId, seq, row.id);
}

/** `Submission/set`. Throws `ContractError` with the sentence the UI shows. */
export function setSubmission(ctx: OutboxCtx, opId: string, action: SubmissionAction): SetResult {
  const prior = replayed(ctx, opId, action);
  if (prior) return prior;
  return action.type === 'send' ? send(ctx, opId, action) : act(ctx, opId, action);
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
