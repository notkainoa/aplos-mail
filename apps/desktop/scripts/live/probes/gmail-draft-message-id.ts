import { emptyResult, type ProbeContext, type ProbeResult, type SmokeProbe } from '../types';
import { getJson, ProbeHttpError, sendJson } from './http';

/**
 * Tier M probe `gmail.draft-message-id-after-edit`, in two phases (`--phase create`, then `--phase inspect`): does real
 * Gmail keep a draft's own `Message-ID` header when the draft is saved again, and when ANOTHER client edits it? That is
 * the open `TODO(live)` at google/drafts.ts and decides how the engine's `isEcho` proof may treat a draft whose
 * Message-ID is ours but whose message id is new.
 *
 * `create` makes ONE draft with no recipient at all (so it holds no address, ours or anyone's), a fixed subject
 * `aplos-live-probe <date>` and a known Message-ID, saves it once more over the API (the guard allows an update only of a
 * draft this run made) and reports whether the Message-ID and draft id survived that save. Then the OWNER edits the
 * draft once on a phone or in Gmail on the web, and `inspect` finds it again by that fixed subject and reports whether
 * its Message-ID is still ours and whether its body was changed. Nothing about the draft but those flags and counts
 * leaves the probe. The draft is left in Drafts: the guard refuses every draft delete in every tier, and the owner
 * discards it by hand (it is one empty-recipient draft; nothing is sent, nothing is emptied from Trash).
 */

const SUBJECT_PREFIX = 'aplos-live-probe ';
const SUBJECT = /^aplos-live-probe (\d{4})-(\d{2})-(\d{2})$/;
/** The newest drafts `inspect` looks through; the probe draft is the newest unless the account is busy. */
const SCAN = 25;
const BODY_V1 = 'Aplos live probe, first save.';
const BODY_V2 = 'Aplos live probe, second save over the API.';

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

/** The fixed subject and the Message-ID derived from its date, so `inspect` needs no memory of `create`. */
export function probeNames(date: Date): { subject: string; messageId: string } {
  const day = date.toISOString().slice(0, 10);
  return {
    subject: `${SUBJECT_PREFIX}${day}`,
    messageId: `<aplos-live-probe-${day.replaceAll('-', '')}@aplos.invalid>`,
  };
}

function rawMessage(date: Date, body: string): string {
  const { subject, messageId } = probeNames(date);
  return b64url(
    [
      `Subject: ${subject}`,
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n'),
  );
}

interface DraftRead {
  messageId?: string;
  headers: Map<string, string>;
  json: Record<string, unknown>;
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
    metadataHeaders: ['Subject', 'Message-ID'],
    fields: HEADER_FIELDS,
  });
  const message = json.message as { id?: unknown } | undefined;
  return {
    ...(typeof message?.id === 'string' ? { messageId: message.id } : {}),
    headers: headersOf(json),
    json,
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
  const made = await sendJson(
    ctx,
    'POST',
    '/drafts',
    {},
    {
      message: { raw: rawMessage(date, BODY_V1) },
    },
  );
  const first = idsOf(made.json);
  if (!first.draftId || !first.messageId) throw new ProbeHttpError('other');
  result.counts.created = 1;
  result.counts.createKeptMessageId =
    (await readHeaders(ctx, first.draftId)).headers.get('message-id') === ours ? 1 : 0;
  const saved = await sendJson(
    ctx,
    'PUT',
    `/drafts/${first.draftId}`,
    {},
    {
      message: { raw: rawMessage(date, BODY_V2) },
    },
  );
  const second = idsOf(saved.json);
  result.counts.updatedDraftIdKept = second.draftId === first.draftId ? 1 : 0;
  result.counts.updatedMessageIdChanged =
    second.messageId !== undefined && second.messageId !== first.messageId ? 1 : 0;
  result.counts.updatedKeptMessageIdHeader =
    (await readHeaders(ctx, first.draftId)).headers.get('message-id') === ours ? 1 : 0;
}

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
  result.counts.messageIdIsOurs = only.read.headers.get('message-id') === ours ? 1 : 0;
  const full = await getJson(ctx, `/drafts/${only.id}`, {
    format: 'full',
    fields: 'message(payload(mimeType,body(data),parts))',
  });
  const text = plainBody((full.json.message as { payload?: unknown } | undefined)?.payload);
  const unchanged = text !== undefined && text.trim() === BODY_V2;
  result.counts.bodyUnchanged = unchanged ? 1 : 0;
  result.counts.bodyEdited = unchanged ? 0 : 1;
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
