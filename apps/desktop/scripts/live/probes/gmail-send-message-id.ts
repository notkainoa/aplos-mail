import { randomBytes } from 'node:crypto';
import { emptyResult, type ProbeContext, type ProbeResult, type SmokeProbe } from '../types';
import { getJson, ProbeHttpError, sendJson } from './http';
import { saltedHash, shapeOf, SHAPE_CODE } from './gmail-draft-message-id';

/**
 * Tier S-self probe `gmail.send-message-id`: does `messages.send` of our MIME keep OUR Message-ID on the Sent copy? That
 * decides how an uncertain send can be recovered (`findSent` searches Sent by the Message-ID, google/send.ts) and
 * whether `useDraftsSend` can ever be switched on (plans/engine/draft-identity.md, item 4 and measurement d).
 *
 * It sends ONE message to the account's OWN address (the guard refuses any other recipient; the address is read from
 * the profile inside this function, used for the `To:` header and nowhere else, never stored, logged or reported), with a
 * fixed subject `aplos-live-probe-send <date>`, a one-line body, a known Message-ID and the custom header
 * `X-Aplos-Draft`. It then reads the Sent copy as metadata and reports the shape of its Message-ID (0 absent, 1 ours,
 * 2 Gmail-style, 3 other), whether the header survived, and how many Sent messages `rfc822msgid:` finds for our id and for
 * the id Gmail shows. One send per run; the run refuses while a probe message of the same day exists. The guard refuses
 * deletes, so the Sent copy and the copy delivered to the Inbox stay for the owner to discard by hand.
 */

const SUBJECT_PREFIX = 'aplos-live-probe-send ';
const HEADER = 'X-Aplos-Draft';
const SEARCHABLE = /^[A-Za-z0-9._%+=-]{1,200}@[A-Za-z0-9.-]{1,100}$/;
const MESSAGE_ID = /^[0-9a-f]{1,16}$/i;

/** Gmail's search index lags behind a send by seconds: an empty search is repeated a few times. Tests set `waitMs` to 0. */
export const searchRetry = { tries: 4, waitMs: 3000 };

export function sendNames(date: Date): { subject: string; messageId: string } {
  const day = date.toISOString().slice(0, 10);
  return {
    subject: `${SUBJECT_PREFIX}${day}`,
    messageId: `<aplos-live-probe-send-${day.replaceAll('-', '')}@aplos.invalid>`,
  };
}

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

function failed(error: unknown, result: ProbeResult): void {
  const errorClass = error instanceof ProbeHttpError ? error.errorClass : 'other';
  result.status = 'fail';
  result.errorClasses[errorClass] = (result.errorClasses[errorClass] ?? 0) + 1;
}

export function headersOf(json: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  const list = (json.payload as { headers?: unknown } | undefined)?.headers;
  if (Array.isArray(list))
    for (const h of list as { name?: unknown; value?: unknown }[])
      if (typeof h.name === 'string' && typeof h.value === 'string')
        out.set(h.name.toLowerCase(), h.value);
  return out;
}

export async function readMetadata(ctx: ProbeContext, id: string): Promise<Map<string, string>> {
  const { json } = await getJson(ctx, `/messages/${id}`, {
    format: 'metadata',
    metadataHeaders: ['Subject', 'Message-ID', HEADER],
    fields: 'id,payload(headers(name,value))',
  });
  return headersOf(json);
}

/**
 * How many probe messages of today are already in the account: a second send is refused. Two independent ways, because
 * Gmail's search index lags and tokenises a hyphenated subject its own way: the subject search (each hit's Subject is
 * compared exactly) and the `rfc822msgid:` search for today's FIXED Message-ID. The larger count decides. Any error
 * here throws before the send (the duplicate check fails closed).
 */
export async function existingToday(
  ctx: ProbeContext,
  subject: string,
  ours: string,
  subjectQuery = 'subject:aplos-live-probe-send in:anywhere',
): Promise<number> {
  const found = await getJson(ctx, '/messages', {
    q: subjectQuery,
    maxResults: '10',
    fields: 'messages(id)',
  });
  const ids = (Array.isArray(found.json.messages) ? found.json.messages : [])
    .map((m: { id?: unknown }) => String(m.id))
    .filter(id => MESSAGE_ID.test(id));
  let same = 0;
  for (const id of ids) if ((await readMetadata(ctx, id)).get('subject') === subject) same++;
  const bare = ours.replace(/^<|>$/g, '');
  const byId = await getJson(ctx, '/messages', {
    q: `rfc822msgid:${bare} in:anywhere`,
    maxResults: '5',
    fields: 'messages(id)',
  });
  const idHits = Array.isArray(byId.json.messages) ? byId.json.messages.length : 0;
  return Math.max(same, idHits);
}

async function sentHits(ctx: ProbeContext, id: string | undefined): Promise<number> {
  const bare = id?.trim().replace(/^<|>$/g, '');
  if (!bare || !SEARCHABLE.test(bare)) return 0;
  const found = await getJson(ctx, '/messages', {
    q: `rfc822msgid:${bare} in:sent`,
    maxResults: '5',
    fields: 'messages(id)',
  });
  return Array.isArray(found.json.messages) ? found.json.messages.length : 0;
}

/** The two search counts, repeated while the index may still be catching up. Returns how many rounds it took. */
async function searchSent(
  ctx: ProbeContext,
  result: ProbeResult,
  ours: string,
  gmails: string | undefined,
): Promise<void> {
  let tries = 0;
  for (; tries < searchRetry.tries; tries++) {
    result.counts.sentFoundByRfc822msgidOurs = await sentHits(ctx, ours);
    result.counts.sentFoundByRfc822msgidGmails = await sentHits(ctx, gmails);
    if (
      result.counts.sentFoundByRfc822msgidOurs > 0 &&
      result.counts.sentFoundByRfc822msgidGmails > 0
    )
      break;
    if (tries + 1 < searchRetry.tries)
      await new Promise(resolve => setTimeout(resolve, searchRetry.waitMs));
  }
  result.counts.sentSearchTries = Math.min(tries + 1, searchRetry.tries);
}

async function sendOne(ctx: ProbeContext, result: ProbeResult): Promise<void> {
  const date = new Date();
  const { subject, messageId: ours } = sendNames(date);
  result.counts.probeMessagesExisting = await existingToday(ctx, subject, ours);
  if (result.counts.probeMessagesExisting > 0) {
    result.status = 'fail';
    return;
  }
  // The account's own address: only ever put in the To header of the one message this probe sends.
  const profile = await getJson(ctx, '/profile', { fields: 'emailAddress' });
  const self = typeof profile.json.emailAddress === 'string' ? profile.json.emailAddress : '';
  if (!self) throw new ProbeHttpError('other');
  const salt = randomBytes(16).toString('hex');
  const token = randomBytes(16).toString('hex');
  const raw = [
    `To: ${self}`,
    `Subject: ${subject}`,
    `Message-ID: ${ours}`,
    `${HEADER}: ${token}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Aplos live probe, one self-addressed message.',
  ].join('\r\n');
  const sent = await sendJson(ctx, 'POST', '/messages/send', {}, { raw: b64url(raw) });
  const id = typeof sent.json.id === 'string' && MESSAGE_ID.test(sent.json.id) ? sent.json.id : '';
  if (!id) throw new ProbeHttpError('other');
  result.counts.sent = 1;
  const copy = await readMetadata(ctx, id);
  const shown = copy.get('message-id');
  const shape = shapeOf(shown, ours);
  result.counts.sentKeptMessageId = shape === 'ours' ? 1 : 0;
  result.counts.sentMessageIdShape = SHAPE_CODE[shape];
  const kept = copy.get(HEADER.toLowerCase());
  result.counts.sentHeaderKept =
    kept !== undefined && saltedHash(salt, kept) === saltedHash(salt, token) ? 1 : 0;
  await searchSent(ctx, result, ours, shown);
}

export const sendMessageId: SmokeProbe = {
  id: 'gmail.send-message-id',
  provider: 'gmail',
  tier: 'S-self',
  async run(ctx: ProbeContext): Promise<ProbeResult> {
    const result = emptyResult();
    const started = ctx.now();
    try {
      await sendOne(ctx, result);
    } catch (error) {
      failed(error, result);
    }
    result.timingsMs.total = ctx.now() - started;
    return result;
  },
};
