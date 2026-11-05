import { createHash, randomBytes } from 'node:crypto';
import { emptyResult, type ProbeContext, type ProbeResult, type SmokeProbe } from '../types';
import { getJson, ProbeHttpError, sendJson } from './http';

/**
 * Tier M probe `gmail.draft-message-id-after-edit`, in two phases (`--phase create`, then `--phase inspect`): what does
 * real Gmail do to a draft's identity when the API saves it and when ANOTHER client edits it? The first live run found
 * that Gmail does not keep the Message-ID the client wrote, so this version never compares to our value alone: it
 * records, per read, a short salted HASH of the Message-ID value (never the value) and its SHAPE (ours, Gmail-style
 * `<...@mail.gmail.com>`, other, absent), plus whether two custom headers (`X-Aplos-Probe`, and `X-Aplos-Draft`, the name the engine's draft-identity proposal would use) survives, and what the
 * `rfc822msgid:` search finds. The engine can then decide whether any id of ours (Message-ID or a custom header) can
 * identify a draft after a save or a foreign edit.
 *
 * `create` makes ONE draft with no recipient at all (so it holds no address), a fixed subject `aplos-live-probe <date>`,
 * a known Message-ID and the custom header, saves it once more over the API (the guard allows an update only of a draft
 * this run made), and writes the hashes and shapes to a small state file outside the repository (state.ts). Then the
 * OWNER edits the draft once on a phone, and `inspect` finds it again by its fixed subject and compares with the state.
 * Only 0/1 flags, shape codes and counts leave the probe. The draft is left in Drafts: the guard refuses every draft
 * delete in every tier, and the owner discards it by hand (nothing is sent, nothing is emptied from Trash).
 */

const SUBJECT_PREFIX = 'aplos-live-probe ';
const SUBJECT = /^aplos-live-probe (\d{4})-(\d{2})-(\d{2})$/;
/** The newest drafts `inspect` looks through; the probe draft is the newest unless the account is busy. */
const SCAN = 25;
const BODY_V1 = 'Aplos live probe, first save.';
const BODY_V2 = 'Aplos live probe, second save over the API.';
const CUSTOM_HEADER = 'X-Aplos-Probe';
/** The header name the engine's draft-identity proposal (plans/engine/draft-identity.md) would carry its own id in. */
const ENGINE_HEADER = 'X-Aplos-Draft';

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

/** The fixed subject and the Message-ID derived from its date, so `inspect` needs no memory of `create`. */
export function probeNames(date: Date): { subject: string; messageId: string } {
  const day = date.toISOString().slice(0, 10);
  return {
    subject: `${SUBJECT_PREFIX}${day}`,
    messageId: `<aplos-live-probe-${day.replaceAll('-', '')}@aplos.invalid>`,
  };
}

function rawMessage(date: Date, body: string, token: string, draftToken: string): string {
  const { subject, messageId } = probeNames(date);
  return b64url(
    [
      `Subject: ${subject}`,
      `Message-ID: ${messageId}`,
      `${CUSTOM_HEADER}: ${token}`,
      `${ENGINE_HEADER}: ${draftToken}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n'),
  );
}

// ---- the shape and the hash of a Message-ID value: only these ever leave this file ----

export type Shape = 'absent' | 'ours' | 'gmail' | 'other';
/** The code each shape has in the evidence: 0 absent, 1 ours, 2 Gmail-style, 3 other. */
export const SHAPE_CODE: Record<Shape, number> = { absent: 0, ours: 1, gmail: 2, other: 3 };
const GMAIL_STYLE = /^<[^<>@\s]+@mail\.gmail\.com>$/i;

export function shapeOf(value: string | undefined, ours: string): Shape {
  if (value === undefined) return 'absent';
  const trimmed = value.trim();
  if (trimmed === ours) return 'ours';
  return GMAIL_STYLE.test(trimmed) ? 'gmail' : 'other';
}

/** A short salted hash: enough to tell two values apart, not to recover one. */
export function saltedHash(salt: string, value: string | undefined): string {
  return createHash('sha256')
    .update(`${salt}:${value?.trim() ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

interface DraftRead {
  messageId?: string;
  headers: Map<string, string>;
}

const HEADER_FIELDS = 'id,message(id,payload(headers(name,value)))';

function headersOf(json: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  const message = json.message as { payload?: { headers?: unknown } } | undefined;
  const list = message?.payload?.headers;
  if (Array.isArray(list))
    for (const h of list as { name?: unknown; value?: unknown }[])
      if (typeof h.name === 'string' && typeof h.value === 'string')
        out.set(h.name.toLowerCase(), h.value);
  return out;
}

async function readHeaders(ctx: ProbeContext, draftId: string): Promise<DraftRead> {
  const { json } = await getJson(ctx, `/drafts/${draftId}`, {
    format: 'metadata',
    metadataHeaders: ['Subject', 'Message-ID', CUSTOM_HEADER, ENGINE_HEADER],
    fields: HEADER_FIELDS,
  });
  const message = json.message as { id?: unknown } | undefined;
  return {
    ...(typeof message?.id === 'string' ? { messageId: message.id } : {}),
    headers: headersOf(json),
  };
}

const DRAFT_ID = /^[A-Za-z0-9_-]{1,64}$/;

function failed(error: unknown, result: ProbeResult): ProbeResult {
  const errorClass = error instanceof ProbeHttpError ? error.errorClass : 'other';
  result.status = 'fail';
  result.errorClasses[errorClass] = (result.errorClasses[errorClass] ?? 0) + 1;
  return result;
}

/** The ids of a create or update answer: `{ id, message: { id } }`. */
function idsOf(json: Record<string, unknown>): { draftId?: string; messageId?: string } {
  const message = json.message as { id?: unknown } | undefined;
  return {
    ...(typeof json.id === 'string' && DRAFT_ID.test(json.id) ? { draftId: json.id } : {}),
    ...(typeof message?.id === 'string' ? { messageId: message.id } : {}),
  };
}

// ---- the rfc822msgid: search checks (read-only, counts only) ----

/** A Message-ID value as a search term (no angle brackets), or undefined when it is not a plain one. */
function searchTerm(value: string | undefined): string | undefined {
  const bare = value?.trim().replace(/^<|>$/g, '');
  return bare && /^[A-Za-z0-9._%+=-]{1,200}@[A-Za-z0-9.-]{1,100}$/.test(bare) ? bare : undefined;
}

async function hits(
  ctx: ProbeContext,
  path: '/drafts' | '/messages',
  term: string,
): Promise<number> {
  const key = path === '/drafts' ? 'drafts' : 'messages';
  const found = await getJson(ctx, path, {
    q: `rfc822msgid:${term}`,
    maxResults: '5',
    fields: `${key}(id)`,
  });
  const list = found.json[key];
  return Array.isArray(list) ? list.length : 0;
}

/**
 * How many drafts / messages `rfc822msgid:` finds for our Message-ID and for the one Gmail reports. A value that is not
 * a plain id is not searched (its counts stay absent).
 */
async function searchChecks(
  ctx: ProbeContext,
  result: ProbeResult,
  stage: 'Create' | 'Phone',
  ours: string,
  reported: string | undefined,
): Promise<void> {
  const terms = { Ours: searchTerm(ours), Reported: searchTerm(reported) };
  for (const [who, term] of Object.entries(terms)) {
    if (!term) continue;
    result.counts[`searchDrafts${who}${stage}`] = await hits(ctx, '/drafts', term);
    result.counts[`searchMessages${who}${stage}`] = await hits(ctx, '/messages', term);
  }
}

// ---- create ----

async function createPhase(ctx: ProbeContext, result: ProbeResult): Promise<void> {
  // One probe draft at a time: an older one would be judged in place of the new one by `inspect`.
  const existing = await findProbeDrafts(ctx);
  result.counts.emptyAnswers = existing.empty ? 1 : 0;
  result.counts.probeDraftsExisting = existing.matches.length;
  if (existing.matches.length > 0) {
    result.status = 'fail';
    return;
  }
  const date = new Date();
  const { messageId: ours } = probeNames(date);
  const salt = randomBytes(16).toString('hex');
  const token = randomBytes(16).toString('hex');
  const draftToken = randomBytes(16).toString('hex');
  const made = await sendJson(
    ctx,
    'POST',
    '/drafts',
    {},
    { message: { raw: rawMessage(date, BODY_V1, token, draftToken) } },
  );
  const first = idsOf(made.json);
  if (!first.draftId || !first.messageId) throw new ProbeHttpError('other');
  result.counts.created = 1;
  const afterCreate = await readHeaders(ctx, first.draftId);
  const createdId = afterCreate.headers.get('message-id');
  result.counts.createKeptMessageId = shapeOf(createdId, ours) === 'ours' ? 1 : 0;
  result.counts.messageIdShapeCreate = SHAPE_CODE[shapeOf(createdId, ours)];
  result.counts.customHeaderKeptAfterCreate =
    afterCreate.headers.get(CUSTOM_HEADER.toLowerCase()) === token ? 1 : 0;
  result.counts.engineHeaderKeptAfterCreate =
    afterCreate.headers.get(ENGINE_HEADER.toLowerCase()) === draftToken ? 1 : 0;

  const saved = await sendJson(
    ctx,
    'PUT',
    `/drafts/${first.draftId}`,
    {},
    { message: { raw: rawMessage(date, BODY_V2, token, draftToken) } },
  );
  const second = idsOf(saved.json);
  result.counts.updatedDraftIdKept = second.draftId === first.draftId ? 1 : 0;
  result.counts.updatedMessageIdChanged =
    second.messageId !== undefined && second.messageId !== first.messageId ? 1 : 0;
  const afterSave = await readHeaders(ctx, first.draftId);
  const savedId = afterSave.headers.get('message-id');
  result.counts.updatedKeptMessageIdHeader = shapeOf(savedId, ours) === 'ours' ? 1 : 0;
  result.counts.messageIdShapeSave = SHAPE_CODE[shapeOf(savedId, ours)];
  result.counts.messageIdStableAcrossApiSave =
    saltedHash(salt, createdId) === saltedHash(salt, savedId) ? 1 : 0;
  result.counts.customHeaderKeptAfterApiSave =
    afterSave.headers.get(CUSTOM_HEADER.toLowerCase()) === token ? 1 : 0;
  result.counts.engineHeaderKeptAfterApiSave =
    afterSave.headers.get(ENGINE_HEADER.toLowerCase()) === draftToken ? 1 : 0;

  // Saved BEFORE the searches: a failure there (a 429, say) must not leave the previous run's state for `inspect` to
  // compare with. What `inspect` compares with after the owner's edit: hashes and shapes only.
  await ctx.state?.save({
    salt,
    tokenHash: saltedHash(salt, token),
    draftTokenHash: saltedHash(salt, draftToken),
    afterCreateHash: saltedHash(salt, createdId),
    afterSaveHash: saltedHash(salt, savedId),
    draftIdHash: saltedHash(salt, first.draftId),
    afterCreateShape: shapeOf(createdId, ours),
    afterSaveShape: shapeOf(savedId, ours),
  });
  await searchChecks(ctx, result, 'Create', ours, savedId);
}

// ---- inspect ----

/** The text/plain body of a full draft read, or undefined. Walks the parts; never returned, only compared. */
function plainBody(part: unknown): string | undefined {
  if (typeof part !== 'object' || part === null) return undefined;
  const { mimeType, body, parts } = part as {
    mimeType?: unknown;
    body?: { data?: unknown };
    parts?: unknown;
  };
  if (mimeType === 'text/plain' && typeof body?.data === 'string')
    return Buffer.from(body.data, 'base64url').toString('utf8');
  for (const child of Array.isArray(parts) ? parts : []) {
    const found = plainBody(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The probe drafts among the newest `SCAN` drafts, newest first, and how many drafts were looked at. */
async function findProbeDrafts(
  ctx: ProbeContext,
): Promise<{ matches: { id: string; read: DraftRead }[]; scanned: number; empty: boolean }> {
  const list = await getJson(ctx, '/drafts', {
    maxResults: String(SCAN),
    fields: 'drafts(id)',
  });
  const ids = (Array.isArray(list.json.drafts) ? list.json.drafts : [])
    .map((d: { id?: unknown }) => String(d.id))
    .filter(id => DRAFT_ID.test(id))
    .slice(0, SCAN);
  const matches: { id: string; read: DraftRead }[] = [];
  for (const id of ids) {
    const read = await readHeaders(ctx, id);
    if (SUBJECT.test(read.headers.get('subject') ?? '')) matches.push({ id, read });
  }
  return { matches, scanned: ids.length, empty: list.empty };
}

async function inspectPhase(ctx: ProbeContext, result: ProbeResult): Promise<void> {
  const { matches, scanned, empty } = await findProbeDrafts(ctx);
  result.counts.emptyAnswers = empty ? 1 : 0;
  result.counts.draftsScanned = scanned;
  result.counts.draftsMatching = matches.length;
  result.counts.draftFound = matches.length > 0 ? 1 : 0;
  // Several probe drafts cannot be told apart without state, and an older one could be judged for the newest: no verdict.
  if (matches.length > 1) {
    result.status = 'fail';
    return;
  }
  const only = matches[0];
  if (!only) return;
  const subject = SUBJECT.exec(only.read.headers.get('subject') ?? '')!;
  const { messageId: ours } = probeNames(
    new Date(`${subject[1]}-${subject[2]}-${subject[3]}T00:00:00Z`),
  );
  const current = only.read.headers.get('message-id');
  result.counts.messageIdIsOurs = shapeOf(current, ours) === 'ours' ? 1 : 0;
  result.counts.messageIdShapePhone = SHAPE_CODE[shapeOf(current, ours)];

  const loaded = await ctx.state?.load();
  // A state file written for another draft (an older run whose create failed before it saved) is no state at all. A
  // file from before `draftIdHash` existed has none to compare and is taken as it is.
  const stale =
    loaded?.salt !== undefined &&
    loaded.draftIdHash !== undefined &&
    saltedHash(loaded.salt, only.id) !== loaded.draftIdHash;
  const before = stale ? undefined : loaded;
  if (!before?.salt) result.counts.stateMissing = 1;
  else {
    result.counts.stateMissing = 0;
    result.counts.messageIdStableAcrossPhoneEdit =
      saltedHash(before.salt, current) === before.afterSaveHash ? 1 : 0;
    const token = only.read.headers.get(CUSTOM_HEADER.toLowerCase());
    result.counts.customHeaderKeptAfterPhoneEdit =
      token !== undefined && saltedHash(before.salt, token) === before.tokenHash ? 1 : 0;
    const draftToken = only.read.headers.get(ENGINE_HEADER.toLowerCase());
    result.counts.engineHeaderKeptAfterPhoneEdit =
      draftToken !== undefined && saltedHash(before.salt, draftToken) === before.draftTokenHash
        ? 1
        : 0;
  }

  const full = await getJson(ctx, `/drafts/${only.id}`, {
    format: 'full',
    fields: 'message(payload(mimeType,body(data),parts))',
  });
  const text = plainBody((full.json.message as { payload?: unknown } | undefined)?.payload);
  const unchanged = text !== undefined && text.trim() === BODY_V2;
  result.counts.bodyUnchanged = unchanged ? 1 : 0;
  result.counts.bodyEdited = unchanged ? 0 : 1;
  await searchChecks(ctx, result, 'Phone', ours, current);
}

export const draftMessageIdAfterEdit: SmokeProbe = {
  id: 'gmail.draft-message-id-after-edit',
  provider: 'gmail',
  tier: 'M',
  phased: true,
  async run(ctx: ProbeContext): Promise<ProbeResult> {
    if (ctx.phase !== 'create' && ctx.phase !== 'inspect') return emptyResult('skip');
    const result = emptyResult();
    const started = ctx.now();
    try {
      if (ctx.phase === 'create') await createPhase(ctx, result);
      else await inspectPhase(ctx, result);
    } catch (error) {
      failed(error, result);
    }
    result.timingsMs.total = ctx.now() - started;
    return result;
  },
};
