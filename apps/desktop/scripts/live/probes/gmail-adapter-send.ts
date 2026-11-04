import { createHash } from 'node:crypto';
import type { AdapterContext, BoundGovernor, Clock, SubmissionPayload } from '@aplos/engine/ports';
import { buildEnvelope, buildMime } from '../../../../../packages/engine/src/outbox/mime';
import { GMAIL_COSTS } from '../../../src/host/providers/google/costs';
import {
  findSentCopy,
  SEND_TOKEN_HEADER,
  sendSubmission,
} from '../../../src/host/providers/google/send';
import { emptyResult, type ProbeContext, type ProbeResult, type SmokeProbe } from '../types';
import { shapeOf, SHAPE_CODE } from './gmail-draft-message-id';
import { getJson, ProbeHttpError } from './http';
import { existingToday, headersOf, searchRetry } from './gmail-send-message-id';

/**
 * Tier S-self probe `gmail.adapter-send-find` (run with `--phase adapter`): the token path of the REAL adapter on real
 * Gmail. The other send probe sends its own bytes; this one sends ONE message to the account's own address THROUGH the
 * adapter's `sendSubmission` (so `transmit` writes the `X-Aplos-Send` token exactly as production does) and then runs
 * the adapter's `findSentCopy` against the real Sent copy. Counts only: `sent`, `sentHeaderTokenKept` (the Sent copy
 * carries our token), `findSentByToken` (the adapter's findSent returned that very message), the Message-ID shape, and
 * the tries it took (Gmail's index lags a send by seconds).
 *
 * The guard accepts only the simple media upload of `messages.send` (`uploadType=media`, the body IS the message). The
 * adapter's `transmit` sends `uploadType=multipart` (JSON metadata plus the message, for a thread) so the probe hands it
 * a `fetch` that turns that upload, for a message with no thread, into the equivalent simple media upload of the SAME
 * message bytes before it reaches the guard. Everything else in `transmit` (the token, the route, the response parsing)
 * is the production code. The guard is unchanged; its recipient check runs on the very bytes that go out.
 *
 * One send per day: the run refuses (`probeMessagesExisting`) when a probe message of the day exists, by subject, by
 * Message-ID and by the adapter's own `findSent` for today's token. The address comes from the profile, goes into the
 * one `To:` header and nowhere else.
 */

const SUBJECT_PREFIX = 'aplos-live-probe-adapter ';
const MESSAGE_ID = /^[0-9a-f]{1,16}$/i;
const UPLOAD = '/upload/gmail/v1/users/me/messages/send';

/** Today's subject and a Message-ID that is fixed for the day (so a rerun finds it) in the outbox's `<32hex@domain>` form. */
export function adapterNames(date: Date): { subject: string; messageId: string } {
  const day = date.toISOString().slice(0, 10);
  const hex = createHash('sha256')
    .update(`aplos-live-probe-adapter ${day}`)
    .digest('hex')
    .slice(0, 32);
  return { subject: `${SUBJECT_PREFIX}${day}`, messageId: `<${hex}@aplos.invalid>` };
}

function failed(error: unknown, result: ProbeResult): void {
  const errorClass = error instanceof ProbeHttpError ? error.errorClass : 'other';
  result.status = 'fail';
  result.errorClasses[errorClass] = (result.errorClasses[errorClass] ?? 0) + 1;
}

/**
 * The adapter's multipart upload as the guard's simple media upload: the same message bytes, the same path, no thread.
 * Anything else (a resumable session, a thread, a body that is not the shape `transmit` writes) is refused here, so
 * nothing the guard has not been taught is sent in its place.
 */
export function mediaUpload(url: string, init: RequestInit): [string, RequestInit] {
  const target = new URL(url);
  const type = String(new Headers(init.headers).get('content-type') ?? '');
  const boundary = /^multipart\/related;\s*boundary=(.+)$/.exec(type)?.[1];
  if (
    !target.pathname.endsWith(UPLOAD) ||
    target.searchParams.get('uploadType') !== 'multipart' ||
    !boundary
  )
    throw new ProbeHttpError('guard');
  const body = Buffer.from(init.body as Uint8Array);
  const start = body.indexOf('Content-Type: message/rfc822\r\n\r\n');
  const end = body.lastIndexOf(`\r\n--${boundary}--`);
  const metadata = body.subarray(0, start).toString('latin1');
  if (start < 0 || end < start || /threadId/.test(metadata)) throw new ProbeHttpError('guard');
  const message = body.subarray(start + 'Content-Type: message/rfc822\r\n\r\n'.length, end);
  target.searchParams.set('uploadType', 'media');
  return [
    target.toString(),
    { method: 'POST', headers: { 'content-type': 'message/rfc822' }, body: message },
  ];
}

/** An adapter context that sends straight through the probe's guarded fetch: no pacing of its own, no store. */
function adapterContext(self: string): AdapterContext {
  const governor: BoundGovernor = {
    run: (_req, fn) => fn({ signal: new AbortController().signal }),
    observe: () => undefined,
    charge: () => undefined,
    batchSize: () => 10,
  };
  const log = { event: () => undefined, id: (value: string) => value };
  // `timer` is the engine's deadline loop; the adapter never calls it.
  const clock: Clock = {
    timer: () => {
      throw new Error('the probe has no timer loop');
    },
    now: () => Date.now(),
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      }),
  };
  return {
    account: { id: 'live', provider: 'gmail', address: self, grantedScopes: [], capabilities: {} },
    governor,
    clock,
    log,
    signal: new AbortController().signal,
    lookup: {},
    memory: new Map(),
    generation: 0,
  } as unknown as AdapterContext;
}

async function runAdapterSend(ctx: ProbeContext, result: ProbeResult): Promise<void> {
  const started = Date.now();
  const { subject, messageId } = adapterNames(new Date(started));
  const profile = await getJson(ctx, '/profile', { fields: 'emailAddress' });
  const self = typeof profile.json.emailAddress === 'string' ? profile.json.emailAddress : '';
  if (!self) throw new ProbeHttpError('other');
  const adapter = adapterContext(self);
  const deps = {
    fetch: ((url: string | URL | Request, init?: RequestInit) =>
      String(url).includes('/upload/')
        ? ctx.fetch(...mediaUpload(String(url), init ?? {}))
        : ctx.fetch(url, init)) as typeof fetch,
    costs: GMAIL_COSTS,
    userAgent: 'aplos-live-probe',
    closed: new AbortController().signal,
  };

  // Refused while a probe message of the day exists: by subject, by Message-ID and by the adapter's own findSent.
  const dayStart = started - 36 * 3_600_000;
  const known = await existingToday(
    ctx,
    subject,
    messageId,
    'subject:aplos-live-probe-adapter in:anywhere',
  );
  const byToken = await findSentCopy(deps, messageId, dayStart, adapter);
  result.counts.probeMessagesExisting = Math.max(known, byToken.kind === 'found' ? 1 : 0);
  if (result.counts.probeMessagesExisting > 0) {
    result.status = 'fail';
    return;
  }

  const input = {
    from: { address: self },
    to: [{ address: self }],
    cc: [],
    subject,
    html: '<p>Aplos live probe, one self-addressed message sent through the adapter.</p>',
    messageId,
    date: started,
  };
  const mime = Buffer.from(buildMime(input));
  const payload: SubmissionPayload = {
    submissionId: 'live-probe',
    internetId: messageId,
    mime,
    envelope: buildEnvelope(input.from, { to: input.to, cc: [], bcc: [] }),
  };
  // ONE send, never retried: an error here is the answer.
  const receipt = await sendSubmission(deps, payload, adapter);
  result.counts.sent = 1;
  const id = receipt.remoteMessageId;
  if (!id || !MESSAGE_ID.test(id)) throw new ProbeHttpError('other');

  const copy = await getJson(ctx, `/messages/${id}`, {
    format: 'metadata',
    metadataHeaders: ['Message-ID', SEND_TOKEN_HEADER],
    fields: 'id,payload(headers(name,value))',
  });
  const headers = headersOf(copy.json);
  const shape = shapeOf(headers.get('message-id'), messageId);
  result.counts.sentKeptMessageId = shape === 'ours' ? 1 : 0;
  result.counts.sentMessageIdShape = SHAPE_CODE[shape];
  result.counts.sentHeaderTokenKept =
    headers.get(SEND_TOKEN_HEADER.toLowerCase()) === messageId ? 1 : 0;

  result.counts.findSentByToken = 0;
  let tries = 0;
  for (; tries < searchRetry.tries; tries++) {
    const found = await findSentCopy(deps, messageId, started - 60_000, adapter);
    if (found.kind === 'found' && found.remoteMessageId === id) {
      result.counts.findSentByToken = 1;
      break;
    }
    if (tries + 1 < searchRetry.tries) await adapter.clock.sleep(searchRetry.waitMs);
  }
  result.counts.sentSearchTries = Math.min(tries + 1, searchRetry.tries);
}

export const adapterSendFind: SmokeProbe = {
  id: 'gmail.adapter-send-find',
  provider: 'gmail',
  tier: 'S-self',
  phased: true,
  async run(ctx: ProbeContext): Promise<ProbeResult> {
    if (ctx.phase !== 'adapter') return emptyResult('skip');
    const result = emptyResult();
    const started = ctx.now();
    try {
      await runAdapterSend(ctx, result);
    } catch (error) {
      failed(error, result);
    }
    result.timingsMs.total = ctx.now() - started;
    return result;
  },
};
