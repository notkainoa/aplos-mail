import type { ClassifiedError, DraftFields } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { Logger } from '../diag/log';
import { NotSentError, PausedError, ProviderError } from '../ports/base';
import type { DraftSyncPort } from '../ports/engine';
import type { DraftSaveResult, DraftUpload } from '../ports/provider';
import type { Clock, DeadlineRegistry, DeadlineSource } from '../ports/time';
import type { EngineFrame } from '../runtime/frames';
import type { CommitInput, StorePort, StoreWrite } from '../store';
import type { BlobSource } from './context';
import {
  createDueIndex,
  refreshDue,
  scanDue,
  sentDrafts,
  touchDue,
  withoutLiveSend,
  type DueIndex,
} from './draft-due';
import {
  DRAFT_REMOVE_MAX_MS,
  DRAFT_REMOVE_PERMANENT_MS,
  DRAFT_RETRY_MS,
  DraftConflict,
  fingerprintOf,
  liveOf,
  needsUpload,
  parseData,
  readAnyRow,
  remembered,
  earlierWith,
  readDraftRow,
  toDraft,
  type DraftMeta,
  type DraftRow,
  type MetaPatch,
} from './draft-state';
import type { DraftWrite } from './draft-writes';
import { attachmentsOf, domainOf, replyHeaders, senderOf } from './submissions';
import { buildMime, checkAddress, MimeError, newMessageId, type MimeAddress } from './mime';

/**
 * Draft sync (ARCH 7.4) and the `drafts` deadline source. The local draft is the truth; this uploads it through
 * `DraftSyncPort`: one serialized upload per draft, due 5 s after the last change or at once on close, skipped when the
 * content fingerprint is the synced one. A `PausedError` moves the due time to the pause's end and never drops the
 * draft; a refusal that will not change leaves the draft local with a problem; an upload the provider reports as
 * changed elsewhere raises the conflict state (`Draft/resolve`). Every fact lives in the draft row, so a restart
 * resumes whatever was pending. The same source removes a draft's remote copy after it was discarded or sent: the row
 * stays, hidden, until the provider confirms the removal, so a crash or a refusal never leaves a copy that would come
 * back as another device's draft.
 */

export interface DraftsDeps {
  store: StorePort;
  clock: Clock;
  deadlines: DeadlineRegistry;
  log: Logger;
  random: (n: number) => Uint8Array;
  blobs?: BlobSource;
  port: DraftSyncPort;
  /** Where `Draft/changed` goes; absent in tests that do not watch frames. */
  frames?: { emit(frame: EngineFrame): void };
}

interface RowlessRemoval {
  account: string;
  remoteDraftId: string;
  /** The message id the copy was saved under: the provider deletes only a draft that still holds it. */
  expectedMessageId?: string;
  at: number;
  attempts: number;
  busy: boolean;
}

export interface DraftsCtx extends DraftsDeps {
  /** Drafts with an upload running here: one at a time per draft. */
  inflight: Set<string>;
  /**
   * Remote copies to delete that no row waits for (an upload that finished after its draft was gone entirely), by remote
   * draft id. A discarded or sent draft's copy is deleted from its own hidden row instead, which survives a restart.
   */
  removals: Map<string, RowlessRemoval>;
  /** The deadline source's view of the table (see `draft-due.ts`). */
  index: DueIndex;
  jobs: Set<Promise<void>>;
  /** The newest announcement sent per draft, so a frame goes out once. */
  announced: Map<string, number>;
}

export function createDraftsCtx(deps: DraftsDeps): DraftsCtx {
  return {
    ...deps,
    inflight: new Set(),
    removals: new Map(),
    index: createDueIndex(),
    jobs: new Set(),
    announced: new Map(),
  };
}

/** A copy without a row that is not deleted after this many refusals is left (and logged). */
const MAX_REMOVE_ATTEMPTS = 3;
/** Refusals that will not change by asking again. */
const PERMANENT = new Set(['permanent', 'permission', 'config', 'anti_abuse']);

const PROBLEM_COPY = 'This draft could not be saved to your account. It stays on this Mac.';

// ---------------------------------------------------------------- commits

function hex(bytes: Uint8Array) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Re-reads a draft's row into the deadline index. It runs in `finally` blocks and in jobs nobody awaits, so it must never
 * throw: a store closed under a late upload (the shutdown grace ended first) would otherwise hide the original error or
 * become an unhandled rejection. A missed entry is found by the next full scan, and the draft's row holds the truth.
 * (There is no registered log event for this; the announce listener in `module.ts` swallows the same way.)
 */
function touchQuietly(ctx: DraftsCtx, id: string) {
  try {
    touchDue(ctx, id);
  } catch {
    // The store is closing or closed.
  }
}

/** Commits a write of the drafts' own; false when it lost its compare-and-set (the draft changed meanwhile). */
function tryCommit(ctx: DraftsCtx, write: StoreWrite, tag: string): boolean {
  const input: CommitInput = {
    opId: `drafts:${tag}:${hex(ctx.random(8))}`,
    origin: 'system',
    writes: [write],
  };
  try {
    ctx.store.commit(input);
    return true;
  } catch (error) {
    if (error instanceof DraftConflict) return false;
    throw error;
  } finally {
    if (write.kind === 'draft' || write.kind === 'draftDelete') touchQuietly(ctx, write.id);
  }
}

function setMeta(
  ctx: DraftsCtx,
  id: string,
  patch: MetaPatch,
  extra: { ifRevision?: number; announce?: true } = {},
) {
  const write: DraftWrite = { kind: 'draft', op: 'meta', id, patch, ...extra };
  return tryCommit(ctx, write, id);
}

// ---------------------------------------------------------------- the upload

interface UploadRow extends DraftRow {
  address: string;
  display_name: string | null;
}

function readUploadRow(ctx: DraftsCtx, id: string) {
  return ctx.store.read(q =>
    q.get<UploadRow>(
      `SELECT d.*, a.address, a.display_name FROM drafts d JOIN accounts a ON a.id = d.account_id WHERE d.id = ?`,
      id,
    ),
  );
}

/** Addresses the draft copy can hold: half-typed ones stay in the local draft but are left out of the copy. */
function writable(list: readonly MimeAddress[]): MimeAddress[] {
  return list.filter(a => {
    try {
      checkAddress(a.address);
      return true;
    } catch {
      return false;
    }
  });
}

interface DraftCopy {
  mime: Uint8Array;
  /** The copy left something out (an attachment whose bytes are gone), so it is not this revision. */
  partial: boolean;
}

/**
 * The bytes of a draft's copy at the provider. Bcc is never in it: a provider that sends the copy itself (Gmail
 * `drafts.send`) would put the header on the wire for every recipient to read, so a draft with Bcc recipients leaves as
 * the pinned MIME with the envelope instead (`prepareSend` gives it a Message-ID of its own).
 */
function draftMime(ctx: DraftsCtx, row: UploadRow, fields: DraftFields, internetId: string) {
  const reply = ctx.store.read(q => replyHeaders(q, row, fields));
  // A draft copy keeps the attachments it can read; one whose bytes are gone stays listed in the local draft.
  const readable = fields.attachments.filter(
    a => a.blobId !== undefined && ctx.blobs?.get(a.blobId),
  );
  const mime = buildMime({
    from: senderOf(row, fields),
    to: writable(fields.to),
    cc: writable(fields.cc),
    subject: fields.subject,
    html: fields.html,
    messageId: internetId,
    date: row.updated_at,
    ...reply,
    attachments: attachmentsOf(ctx, { ...fields, attachments: readable }),
    randomBytes: ctx.random,
  });
  return { mime, partial: readable.length < fields.attachments.length } satisfies DraftCopy;
}

function uploadOf(
  row: UploadRow,
  fields: DraftFields,
  internetId: string,
  mime: Uint8Array,
  earlier: string[],
): DraftUpload {
  const { meta } = parseData(row.data);
  const upload: DraftUpload = {
    draftId: row.id,
    revision: row.revision,
    fingerprint: meta.cur ?? fingerprintOf(fields),
    internetId,
    mime,
  };
  if (row.remote_draft_id) upload.remoteDraftId = row.remote_draft_id;
  else if (earlier.length) upload.supersedes = earlier.filter(id => id !== internetId);
  if (row.remote_message_id) upload.baseRemoteMessageId = row.remote_message_id;
  if (row.remote_change_key) upload.baseChangeKey = row.remote_change_key;
  const thread = fields.threadId?.startsWith(`${row.account_id}:`)
    ? fields.threadId.slice(row.account_id.length + 1)
    : undefined;
  if (thread !== undefined) upload.remoteThreadId = thread;
  return upload;
}

/** `attempt` is the upload this answers: once a choice or a newer attempt replaced it, its answer is dropped. */
function problemFor(ctx: DraftsCtx, row: UploadRow, message: string, attempt?: string) {
  const at = ctx.clock.now();
  setMeta(
    ctx,
    row.id,
    { problem: { reasonCode: 'draft.sync', message, at }, dueAt: null, uploading: null },
    { ifRevision: row.revision, ...(attempt !== undefined ? { ifUploading: attempt } : {}) },
  );
}

/** Asks again at `at`. A reply that may hide a write (`uncertain`) of a revision that has since changed re-uploads the current one. */
function retryAt(ctx: DraftsCtx, row: UploadRow, at: number, uncertain: boolean) {
  const write: DraftWrite = {
    kind: 'draft',
    op: 'retry',
    id: row.id,
    revision: row.revision,
    at,
    uncertain,
  };
  tryCommit(ctx, write, row.id);
}

/** What a refused upload does: wait for the pause, try again later, or give up with a problem. Never drops the draft. */
function refused(ctx: DraftsCtx, row: UploadRow, error: unknown, attempt: string) {
  const now = ctx.clock.now();
  if (error instanceof PausedError)
    return retryAt(ctx, row, error.until ?? now + DRAFT_RETRY_MS, false);
  const classified: ClassifiedError | undefined =
    error instanceof NotSentError || error instanceof ProviderError ? error.error : undefined;
  if (classified) ctx.log.event('draft.sync_failed', { draft: row.id, error: classified });
  if (classified && PERMANENT.has(classified.class))
    return problemFor(ctx, row, PROBLEM_COPY, attempt);
  // A refusal says nothing was written; anything else (a timeout, a 5xx) may have been.
  retryAt(ctx, row, now + DRAFT_RETRY_MS, !(error instanceof NotSentError));
}

function raiseConflict(
  ctx: DraftsCtx,
  row: UploadRow,
  upload: DraftUpload,
  result: DraftSaveResult,
) {
  const write: DraftWrite = {
    kind: 'draft',
    op: 'conflict',
    id: row.id,
    revision: row.revision,
    internetId: upload.internetId,
    gone: result.kind === 'gone',
    ...(result.kind === 'conflict' && result.remoteMessageId !== undefined
      ? { remoteMessageId: result.remoteMessageId }
      : {}),
    // The writer adopts the copy a conflict names only on a create (the row has no remote draft) and only when the
    // provider proved the copy carries this upload's Message-ID.
    ...(result.kind === 'conflict' && result.remoteDraftId !== undefined
      ? { remoteDraftId: result.remoteDraftId }
      : {}),
    ...(result.kind === 'conflict' && result.remoteInternetId !== undefined
      ? { remoteInternetId: result.remoteInternetId }
      : {}),
    at: ctx.clock.now(),
  };
  tryCommit(ctx, write, row.id);
}

function recordSaved(
  ctx: DraftsCtx,
  upload: DraftUpload,
  saved: Extract<DraftSaveResult, { kind: 'saved' }>,
  account: string,
  partial: boolean,
) {
  const write: DraftWrite = {
    kind: 'draft',
    op: 'synced',
    id: upload.draftId,
    revision: upload.revision,
    fingerprint: upload.fingerprint,
    remoteDraftId: saved.remoteDraftId,
    remoteMessageId: saved.remoteMessageId,
    internetId: upload.internetId,
    ...(saved.changeKey !== undefined ? { changeKey: saved.changeKey } : {}),
    ...(partial ? { partial: true as const } : {}),
    at: ctx.clock.now(),
  };
  // The draft was discarded or sent while the upload ran: the copy it just made is nobody's, so it goes.
  if (!tryCommit(ctx, write, upload.draftId))
    queueRemoval(ctx, account, saved.remoteDraftId, saved.remoteMessageId);
}

async function syncDraft(ctx: DraftsCtx, id: string) {
  const row = readUploadRow(ctx, id);
  if (!row) return;
  const { fields, meta } = parseData(row.data);
  if (meta.removing) return;
  // A draft waiting for a choice uploads nothing, and no longer counts as due.
  if (meta.conflict) {
    if (meta.dueAt === undefined) return;
    return void setMeta(ctx, id, { dueAt: null }, { ifRevision: row.revision });
  }
  if (!needsUpload(fields, meta, row.remote_draft_id !== null))
    return void setMeta(ctx, id, { dueAt: null }, { ifRevision: row.revision });
  // One Message-ID per revision, kept across retries of that revision (an uncertain create is recognised by it).
  const internetId =
    meta.uploading?.revision === row.revision
      ? meta.uploading.internetId
      : newMessageId(ctx.random, domainOf(row.address));
  let copy: DraftCopy;
  try {
    copy = draftMime(ctx, row, fields, internetId);
  } catch (error) {
    const known = error instanceof MimeError || error instanceof ContractError;
    return problemFor(ctx, row, known ? error.message : PROBLEM_COPY);
  }
  // A first create nobody answered, then an edit: the new attempt takes the old one's place, and the old Message-ID is
  // kept so history reporting the copy it made is recognised as ours (no phantom draft).
  const old =
    meta.uploading && meta.uploading.internetId !== internetId ? [meta.uploading.internetId] : [];
  // A create that nobody answered may still have landed: the next create offers its Message-ID as `supersedes`.
  const earlier = row.remote_draft_id === null ? earlierWith(meta, ...old) : [];
  const marked = setMeta(
    ctx,
    id,
    {
      uploading: { internetId, revision: row.revision, base: row.remote_message_id },
      ...(old.length ? { wrote: remembered(meta, ...old) } : {}),
      ...(old.length && earlier.length ? { earlier } : {}),
    },
    { ifRevision: row.revision },
  );
  if (!marked) return;
  const upload = uploadOf(row, fields, internetId, copy.mime, earlier);
  let result: DraftSaveResult;
  try {
    result = await ctx.port.save(row.account_id, upload);
  } catch (error) {
    return refused(ctx, row, error, internetId);
  }
  if (result.kind === 'saved')
    return recordSaved(ctx, upload, result, row.account_id, copy.partial);
  raiseConflict(ctx, row, upload, result);
}

// ---------------------------------------------------------------- remote copies

/** Deletes the provider's copy of a draft that is gone here. */
export function queueRemoval(
  ctx: DraftsCtx,
  account: string,
  remoteDraftId: string,
  expectedMessageId?: string,
) {
  if (ctx.removals.has(remoteDraftId)) return;
  ctx.removals.set(remoteDraftId, {
    account,
    remoteDraftId,
    ...(expectedMessageId !== undefined ? { expectedMessageId } : {}),
    at: ctx.clock.now(),
    attempts: 0,
    busy: false,
  });
  ctx.deadlines.changed('drafts');
}

/** `remove`, passing the expected message id only when one is known (otherwise the call is the old two-argument one). */
function removeCopy(ctx: DraftsCtx, account: string, remoteDraftId: string, expected?: string) {
  return expected === undefined
    ? ctx.port.remove(account, remoteDraftId)
    : ctx.port.remove(account, remoteDraftId, expected);
}

async function runRemoval(ctx: DraftsCtx, removal: RowlessRemoval) {
  removal.busy = true;
  try {
    await removeCopy(ctx, removal.account, removal.remoteDraftId, removal.expectedMessageId);
    ctx.removals.delete(removal.remoteDraftId);
  } catch (error) {
    removal.busy = false;
    const now = ctx.clock.now();
    if (error instanceof PausedError) {
      removal.at = error.until ?? now + DRAFT_RETRY_MS;
      return;
    }
    removal.attempts += 1;
    removal.at = now + DRAFT_RETRY_MS;
    if (removal.attempts < MAX_REMOVE_ATTEMPTS) return;
    ctx.removals.delete(removal.remoteDraftId);
    if (error instanceof NotSentError || error instanceof ProviderError)
      ctx.log.event('draft.sync_failed', { draft: removal.remoteDraftId, error: error.error });
  }
}

/** A draft whose current revision went out is done: it leaves Drafts, and its remote copy is deleted (from the hidden row). */
function cleanUpSent(ctx: DraftsCtx) {
  for (const draft of sentDrafts(ctx, true))
    tryCommit(ctx, { kind: 'draftDelete', id: draft.id, at: ctx.clock.now() }, draft.id);
  ctx.index.sent = undefined;
}

// ---------------------------------------------------------------- hidden rows

/** The provider refused to delete the copy of a hidden row: ask again later, however many times it takes. */
function removalRefused(ctx: DraftsCtx, row: DraftRow, meta: DraftMeta, error: unknown) {
  const now = ctx.clock.now();
  if (error instanceof PausedError)
    return void setMeta(ctx, row.id, { removeAt: error.until ?? now + DRAFT_RETRY_MS });
  const tries = (meta.removeTries ?? 0) + 1;
  const classified: ClassifiedError | undefined =
    error instanceof NotSentError || error instanceof ProviderError ? error.error : undefined;
  if (classified) ctx.log.event('draft.sync_failed', { draft: row.id, error: classified });
  const wait =
    classified && PERMANENT.has(classified.class)
      ? DRAFT_REMOVE_PERMANENT_MS
      : Math.min(DRAFT_RETRY_MS * 2 ** (tries - 1), DRAFT_REMOVE_MAX_MS);
  setMeta(ctx, row.id, { removeTries: tries, removeAt: now + wait });
}

/** Did a send of this draft consume its remote copy (`SendReceipt.draftConsumed`, kept on the submission)? */
function consumedBySend(ctx: DraftsCtx, draftId: string): boolean {
  return (
    ctx.store.read(q =>
      q.get(
        `SELECT 1 FROM submissions WHERE draft_id = ? AND state = 'sent'
           AND json_extract(error, '$.draftConsumed') = 1 LIMIT 1`,
        draftId,
      ),
    ) !== undefined
  );
}

/** Deletes the provider's copy of a discarded or sent draft, then the hidden row. */
async function removeHidden(ctx: DraftsCtx, id: string) {
  const row = ctx.store.read(q => readAnyRow(q, id));
  if (!row) return;
  const { meta } = parseData(row.data);
  if (!meta.removing) return;
  // A send that consumed the remote draft left nothing to delete, and on a provider where the draft and the sent message
  // are one entity (JMAP) deleting it would delete the sent message.
  if (row.remote_draft_id !== null && !consumedBySend(ctx, id)) {
    try {
      // The copy this device last wrote or adopted: if the draft holds another message id (a phone edit, or a sent
      // message) the provider leaves it alone and the hidden row still ends.
      await removeCopy(
        ctx,
        row.account_id,
        row.remote_draft_id,
        row.remote_message_id ?? undefined,
      );
    } catch (error) {
      return removalRefused(ctx, row, meta, error);
    }
  }
  // No copy known and none reported within the grace period: there is nothing to wait for.
  tryCommit(ctx, { kind: 'draftDelete', id, at: ctx.clock.now(), final: true }, id);
}

// ---------------------------------------------------------------- the source

interface Due {
  id: string;
  due: number;
}

/** Drafts with an upload due; a draft with a live send is locked and syncs again once the send ends. */
function dueDrafts(ctx: DraftsCtx): Due[] {
  const running = [...ctx.index.uploads]
    .filter(([id]) => !ctx.inflight.has(id))
    .map(([id, due]) => ({ id, due }));
  const free = withoutLiveSend(
    ctx,
    running.map(d => d.id),
  );
  return running.filter(d => free.has(d.id));
}

/** Hidden rows whose copy is due to be deleted. */
function dueRemovals(ctx: DraftsCtx): Due[] {
  return [...ctx.index.removals]
    .filter(([id]) => !ctx.inflight.has(id) && !ctx.inflight.has(`removing:${id}`))
    .map(([id, r]) => ({ id, due: r.at }));
}

function start(ctx: DraftsCtx, key: string, job: () => Promise<void>) {
  ctx.inflight.add(key);
  const done: Promise<void> = Promise.resolve()
    .then(job)
    .catch(() => {
      // A store failure mid-upload leaves the draft where the next fire finds it, still due.
    })
    .finally(() => {
      ctx.inflight.delete(key);
      ctx.jobs.delete(done);
      if (!key.startsWith('remove:')) touchQuietly(ctx, key.replace(/^removing:/, ''));
      ctx.deadlines.changed('drafts');
    });
  ctx.jobs.add(done);
}

function nextDeadline(ctx: DraftsCtx): number | undefined {
  const now = ctx.clock.now();
  refreshDue(ctx);
  const times = [...dueDrafts(ctx), ...dueRemovals(ctx)].map(d => d.due);
  if (sentDrafts(ctx).length) times.push(now);
  for (const r of ctx.removals.values()) if (!r.busy) times.push(r.at);
  return times.length ? Math.min(...times) : undefined;
}

function fireDrafts(ctx: DraftsCtx, now: number) {
  cleanUpSent(ctx);
  // A fire is rare next to a save, so it looks at the whole table: nothing it misses stays missed.
  scanDue(ctx);
  for (const d of dueDrafts(ctx)) if (d.due <= now) start(ctx, d.id, () => syncDraft(ctx, d.id));
  for (const d of dueRemovals(ctx))
    if (d.due <= now) start(ctx, `removing:${d.id}`, () => removeHidden(ctx, d.id));
  for (const r of [...ctx.removals.values()]) {
    const key = `remove:${r.remoteDraftId}`;
    if (r.at <= now && !r.busy && !ctx.inflight.has(key)) start(ctx, key, () => runRemoval(ctx, r));
  }
  return Promise.resolve();
}

export function draftsSource(ctx: DraftsCtx): DeadlineSource {
  return {
    id: 'drafts',
    next: async () => nextDeadline(ctx),
    fire: now => fireDrafts(ctx, now),
  };
}

/** The editor closed: upload now (unless the draft waits on a choice). */
export function closeDraft(ctx: DraftsCtx, id: string) {
  const row = ctx.store.read(q => readDraftRow(q, id));
  if (!row || parseData(row.data).meta.conflict) return;
  setMeta(ctx, id, { dueAt: ctx.clock.now(), problem: null });
  ctx.deadlines.changed('drafts');
}

/** The Mac woke or the network returned: problems and waits end, so every pending draft asks again. */
export function wakeDrafts(ctx: DraftsCtx) {
  const now = ctx.clock.now();
  scanDue(ctx);
  for (const [id, due] of [...ctx.index.uploads]) if (due > now) setMeta(ctx, id, { dueAt: now });
  for (const [id, r] of [...ctx.index.removals])
    if (!r.waiting && r.at > now) setMeta(ctx, id, { removeAt: now, removeTries: null });
  for (const r of ctx.removals.values()) r.at = Math.min(r.at, now);
  ctx.deadlines.changed('drafts');
}

// ---------------------------------------------------------------- frames

/** `Draft/changed` for a draft another device (or a resolve) changed; a change announced once is not announced again. */
export function announceDraft(ctx: DraftsCtx, id: string) {
  const row = ctx.store.read(q => readDraftRow(q, id));
  if (!row || !ctx.frames) return;
  const { meta } = parseData(row.data);
  if (meta.announce === undefined || meta.announce <= (ctx.announced.get(id) ?? 0)) return;
  ctx.announced.set(id, meta.announce);
  const live = ctx.store.read(q => liveOf(q, id));
  ctx.frames.emit({
    frame: 'Draft/changed',
    draftId: id,
    revision: row.revision,
    conflict: meta.conflict !== undefined,
    draft: toDraft(row, live?.id),
  });
}

export async function settledDrafts(ctx: DraftsCtx) {
  while (ctx.jobs.size) await Promise.all([...ctx.jobs]);
}
