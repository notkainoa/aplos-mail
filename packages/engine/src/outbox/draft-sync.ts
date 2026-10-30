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
  DRAFT_RETRY_MS,
  DraftConflict,
  fingerprintOf,
  liveOf,
  LIVE_SQL,
  needsUpload,
  parseData,
  readDraftRow,
  toDraft,
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
 * resumes whatever was pending. The same source removes a draft's remote copy after it was discarded or sent.
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

interface Removal {
  account: string;
  remoteDraftId: string;
  at: number;
  attempts: number;
  busy: boolean;
}

export interface DraftsCtx extends DraftsDeps {
  /** Drafts with an upload running here: one at a time per draft. */
  inflight: Set<string>;
  /** Remote copies to delete, by remote draft id (a crash between the local delete and this leaves the copy). */
  removals: Map<string, Removal>;
  jobs: Set<Promise<void>>;
  /** The newest announcement sent per draft, so a frame goes out once. */
  announced: Map<string, number>;
}

export function createDraftsCtx(deps: DraftsDeps): DraftsCtx {
  return {
    ...deps,
    inflight: new Set(),
    removals: new Map(),
    jobs: new Set(),
    announced: new Map(),
  };
}

/** A remote copy that is not deleted after this many refusals is left (and logged); the local draft is gone either way. */
const MAX_REMOVE_ATTEMPTS = 3;
/** Refusals that will not change by asking again. */
const PERMANENT = new Set(['permanent', 'permission', 'config', 'anti_abuse']);

const PROBLEM_COPY = 'This draft could not be saved to your account. It stays on this Mac.';

// ---------------------------------------------------------------- commits

function hex(bytes: Uint8Array) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
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

function draftMime(
  ctx: DraftsCtx,
  row: UploadRow,
  fields: DraftFields,
  internetId: string,
): Uint8Array {
  const reply = ctx.store.read(q => replyHeaders(q, row, fields));
  // A draft copy keeps the attachments it can read; one whose bytes are gone stays listed in the local draft.
  const readable = fields.attachments.filter(
    a => a.blobId !== undefined && ctx.blobs?.get(a.blobId),
  );
  return buildMime({
    from: senderOf(row, fields),
    to: writable(fields.to),
    cc: writable(fields.cc),
    bcc: writable(fields.bcc),
    subject: fields.subject,
    html: fields.html,
    messageId: internetId,
    date: row.updated_at,
    ...reply,
    attachments: attachmentsOf(ctx, { ...fields, attachments: readable }),
    randomBytes: ctx.random,
  });
}

function uploadOf(
  row: UploadRow,
  fields: DraftFields,
  internetId: string,
  mime: Uint8Array,
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
  if (row.remote_message_id) upload.baseRemoteMessageId = row.remote_message_id;
  if (row.remote_change_key) upload.baseChangeKey = row.remote_change_key;
  const thread = fields.threadId?.startsWith(`${row.account_id}:`)
    ? fields.threadId.slice(row.account_id.length + 1)
    : undefined;
  if (thread !== undefined) upload.remoteThreadId = thread;
  return upload;
}

function problemFor(ctx: DraftsCtx, row: UploadRow, message: string) {
  const at = ctx.clock.now();
  setMeta(
    ctx,
    row.id,
    { problem: { reasonCode: 'draft.sync', message, at }, dueAt: null, uploading: null },
    { ifRevision: row.revision },
  );
}

function retryAt(ctx: DraftsCtx, row: UploadRow, at: number) {
  setMeta(ctx, row.id, { dueAt: at }, { ifRevision: row.revision });
}

/** What a refused upload does: wait for the pause, try again later, or give up with a problem. Never drops the draft. */
function refused(ctx: DraftsCtx, row: UploadRow, error: unknown) {
  const now = ctx.clock.now();
  if (error instanceof PausedError) return retryAt(ctx, row, error.until ?? now + DRAFT_RETRY_MS);
  const classified: ClassifiedError | undefined =
    error instanceof NotSentError || error instanceof ProviderError ? error.error : undefined;
  if (classified) ctx.log.event('draft.sync_failed', { draft: row.id, error: classified });
  if (classified && PERMANENT.has(classified.class)) return problemFor(ctx, row, PROBLEM_COPY);
  retryAt(ctx, row, now + DRAFT_RETRY_MS);
}

function raiseConflict(ctx: DraftsCtx, row: UploadRow, result: DraftSaveResult) {
  const { meta } = parseData(row.data);
  const seen = (meta.theirsSeen ?? 0) + 1;
  const conflict: NonNullable<typeof meta.conflict> = {
    theirsRevision: seen,
    at: ctx.clock.now(),
  };
  if (result.kind === 'gone') conflict.gone = true;
  else if (result.remoteMessageId !== undefined) conflict.theirsMessageId = result.remoteMessageId;
  setMeta(
    ctx,
    row.id,
    { conflict, theirsSeen: seen, dueAt: null, uploading: null },
    { ifRevision: row.revision, announce: true },
  );
}

function recordSaved(
  ctx: DraftsCtx,
  upload: DraftUpload,
  saved: Extract<DraftSaveResult, { kind: 'saved' }>,
  account: string,
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
    at: ctx.clock.now(),
  };
  // The draft was discarded or sent while the upload ran: the copy it just made is nobody's, so it goes.
  if (!tryCommit(ctx, write, upload.draftId)) queueRemoval(ctx, account, saved.remoteDraftId);
}

async function syncDraft(ctx: DraftsCtx, id: string) {
  const row = readUploadRow(ctx, id);
  if (!row) return;
  const { fields, meta } = parseData(row.data);
  if (meta.conflict) return;
  if (!needsUpload(fields, meta, row.remote_draft_id !== null))
    return void setMeta(ctx, id, { dueAt: null }, { ifRevision: row.revision });
  // One Message-ID per revision, kept across retries of that revision (an uncertain create is recognised by it).
  const internetId =
    meta.uploading?.revision === row.revision
      ? meta.uploading.internetId
      : newMessageId(ctx.random, domainOf(row.address));
  let mime: Uint8Array;
  try {
    mime = draftMime(ctx, row, fields, internetId);
  } catch (error) {
    const known = error instanceof MimeError || error instanceof ContractError;
    return problemFor(ctx, row, known ? error.message : PROBLEM_COPY);
  }
  const marked = setMeta(
    ctx,
    id,
    { uploading: { internetId, revision: row.revision } },
    { ifRevision: row.revision },
  );
  if (!marked) return;
  const upload = uploadOf(row, fields, internetId, mime);
  let result: DraftSaveResult;
  try {
    result = await ctx.port.save(row.account_id, upload);
  } catch (error) {
    return refused(ctx, row, error);
  }
  if (result.kind === 'saved') return recordSaved(ctx, upload, result, row.account_id);
  raiseConflict(ctx, row, result);
}

// ---------------------------------------------------------------- remote copies

/** Deletes the provider's copy of a draft that is gone here. */
export function queueRemoval(ctx: DraftsCtx, account: string, remoteDraftId: string) {
  if (ctx.removals.has(remoteDraftId)) return;
  ctx.removals.set(remoteDraftId, {
    account,
    remoteDraftId,
    at: ctx.clock.now(),
    attempts: 0,
    busy: false,
  });
  ctx.deadlines.changed('drafts');
}

async function runRemoval(ctx: DraftsCtx, removal: Removal) {
  removal.busy = true;
  try {
    await ctx.port.remove(removal.account, removal.remoteDraftId);
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

interface SentRow {
  id: string;
  account_id: string;
  remote_draft_id: string | null;
  [k: string]: string | null;
}

/** A draft whose current revision went out is done: it leaves Drafts, and its remote copy is deleted. */
function sentDrafts(ctx: DraftsCtx): SentRow[] {
  return ctx.store.read(q =>
    q.all<SentRow>(
      `SELECT d.id, d.account_id, d.remote_draft_id FROM drafts d
       WHERE EXISTS (SELECT 1 FROM submissions s WHERE s.draft_id = d.id AND s.state = 'sent' AND s.revision = d.revision)
         AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.draft_id = d.id AND s.state IN (${LIVE_SQL}))`,
    ),
  );
}

function cleanUpSent(ctx: DraftsCtx) {
  for (const draft of sentDrafts(ctx)) {
    if (!tryCommit(ctx, { kind: 'draftDelete', id: draft.id }, draft.id)) continue;
    if (draft.remote_draft_id) queueRemoval(ctx, draft.account_id, draft.remote_draft_id);
  }
}

// ---------------------------------------------------------------- the source

interface Due {
  id: string;
  due: number;
  [k: string]: string | number;
}

/** Drafts with an upload due; a draft with a live send is locked and syncs again once the send ends. */
function dueDrafts(ctx: DraftsCtx): Due[] {
  return ctx.store.read(q =>
    q.all<Due>(
      `SELECT t.id AS id, t.due AS due FROM
         (SELECT id, json_extract(data, '$._sync.dueAt') AS due FROM drafts) t
       WHERE t.due IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.draft_id = t.id AND s.state IN (${LIVE_SQL}))`,
    ),
  );
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
      ctx.deadlines.changed('drafts');
    });
  ctx.jobs.add(done);
}

function nextDeadline(ctx: DraftsCtx): number | undefined {
  const now = ctx.clock.now();
  const times = dueDrafts(ctx)
    .filter(d => !ctx.inflight.has(d.id))
    .map(d => d.due);
  if (sentDrafts(ctx).length) times.push(now);
  for (const r of ctx.removals.values()) if (!r.busy) times.push(r.at);
  return times.length ? Math.min(...times) : undefined;
}

function fireDrafts(ctx: DraftsCtx, now: number) {
  cleanUpSent(ctx);
  for (const d of dueDrafts(ctx))
    if (d.due <= now && !ctx.inflight.has(d.id)) start(ctx, d.id, () => syncDraft(ctx, d.id));
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
  const pending = ctx.store.read(q =>
    q.all<{ id: string; due: number | null; [k: string]: string | number | null }>(
      `SELECT id, json_extract(data, '$._sync.dueAt') AS due FROM drafts`,
    ),
  );
  for (const d of pending) if (d.due !== null && d.due > now) setMeta(ctx, d.id, { dueAt: now });
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
