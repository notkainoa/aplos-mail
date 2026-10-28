import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withBearer } from '../../../apps/desktop/scripts/live/auth';
import {
  createGuardedFetch,
  GuardRefusal,
  readOnlyViolations,
  type GuardedFetch,
} from '../../../apps/desktop/scripts/live/guard';
import { createPacedFetch, UnitPacer } from '../../../apps/desktop/scripts/live/pacer';
import { runLive, type RunDeps } from '../../../apps/desktop/scripts/live/run';
import { emptyResult, type SmokeProbe, type Tier } from '../../../apps/desktop/scripts/live/types';
import {
  addressHash,
  keychainWriter,
  newAddressSalt,
  saveAccount,
} from '../../../apps/desktop/scripts/live/vault';

/**
 * Security attack suite for the live runner. Each test states the SAFE expectation, so a failing
 * test is a hole. Requests are captured as they would go on the wire: the innermost fetch rebuilds
 * them with `new Request(url, init)`, which is what Node's fetch does, and reads the real body.
 * No real address, token or host is used; everything is example.test or an obvious fake.
 */

const SELF = 'self@example.test';
const OTHER = 'other@example.test';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3';
const FAKE_REFRESH = 'rt-FAKE-not-a-token';
const FAKE_ACCESS = 'at-FAKE-not-a-token';

interface WireRequest {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

type Answer = (request: WireRequest) => unknown;

/** The network: records exactly what would be sent and answers with JSON. */
function wire(answer: Answer = () => ({})) {
  const sent: WireRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input as string, init);
    const entry: WireRequest = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body ? await request.text() : '',
    };
    sent.push(entry);
    return new Response(JSON.stringify(answer(entry)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { sent, fetchImpl };
}

/** The same layering as run.ts: probe -> guard -> pacer -> bearer -> network. */
function pipeline(tier: Tier, answer?: Answer) {
  const net = wire(answer);
  const pacer = new UnitPacer({ now: () => 0, sleep: async () => undefined });
  const guard = createGuardedFetch(
    createPacedFetch(
      withBearer(net.fetchImpl, () => FAKE_ACCESS),
      pacer,
    ),
    { tier, calendarRunId: 'run-test', ...(tier === 'R' ? {} : { selfAddress: SELF }) },
  );
  return { guard, sent: net.sent };
}

async function outcome(guard: GuardedFetch, url: string, init?: RequestInit): Promise<string> {
  try {
    await guard(url, init);
    return 'sent';
  } catch (error) {
    if (error instanceof GuardRefusal) return `refused:${error.reason}`;
    throw error;
  }
}

async function expectRefused(tier: Tier, url: string, init?: RequestInit): Promise<void> {
  const { guard, sent } = pipeline(tier);
  const result = await outcome(guard, url, init);
  assert.match(result, /^refused:/, `${init?.method ?? 'GET'} ${url} should be refused`);
  assert.equal(sent.length, 0, 'nothing may reach the wire');
}

const b64 = (text: string): string => Buffer.from(text, 'latin1').toString('base64url');
const rfc822 = (headers: string[], body = 'Hello'): string =>
  `${headers.join('\r\n')}\r\n\r\n${body}`;
const raw = (headers: string[], body?: string): string => b64(rfc822(headers, body));
const jsonInit = (value: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

/** The agent account in a fresh vault, with the account check of SELF stored as sign-in would. */
async function saveAgent(vault: string, now: number): Promise<void> {
  const addressSalt = newAddressSalt();
  await saveAccount(vault, 'agent', {
    provider: 'gmail',
    grantedAt: new Date(now).toISOString(),
    keychainService: 'aplos-mail-live-agent',
    addressSalt,
    addressHash: addressHash(SELF, addressSalt),
  });
}

/** Google as the runner sees it: the token endpoint and the profile of the agent account. */
const agentAnswers: Answer = request => {
  if (request.url.startsWith('https://oauth2.googleapis.com/token'))
    return { access_token: FAKE_ACCESS, expires_in: 3600 };
  return request.url.startsWith(`${GMAIL}/profile`) ? { emailAddress: SELF } : {};
};

/** Every recipient address in an RFC 822 message on the wire, by a deliberately loose scan. */
function wireMentions(request: WireRequest, address: string): boolean {
  let text = request.body;
  try {
    const parsed = JSON.parse(text) as { raw?: string; message?: { raw?: string } };
    const value = parsed.raw ?? parsed.message?.raw;
    if (value) text += Buffer.from(value, 'base64').toString('latin1');
  } catch {
    // not JSON: the body itself is the message
  }
  return text.toLowerCase().includes(address);
}

// ---------------------------------------------------------------------------------------------
// 1. Time-of-check / time-of-use on the caller's init object (CONFIRMED holes)
// ---------------------------------------------------------------------------------------------

test('TOCTOU: a method getter (GET when checked, DELETE when sent) is not a permanent delete in tier R', async () => {
  const { guard, sent } = pipeline('R');
  let reads = 0;
  const init = {
    get method() {
      return reads++ === 0 ? 'GET' : 'DELETE';
    },
  } as RequestInit;
  await outcome(guard, `${GMAIL}/messages/m1`, init);
  assert.deepEqual(
    sent.map(r => r.method),
    sent.length ? ['GET'] : [],
    'a DELETE reached the wire in tier R',
  );
});

test('TOCTOU: tier R end to end, a probe that flips the method fails the run and the log shows the write', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'aplos-attack-vault-'));
  const evidence = await mkdtemp(join(tmpdir(), 'aplos-attack-evidence-'));
  const now = Date.parse('2026-10-27T10:00:00Z');
  await saveAgent(vault, now);
  const net = wire(agentAnswers);
  const sneaky: SmokeProbe = {
    id: 'attack.method-flip',
    provider: 'gmail',
    tier: 'R',
    async run(ctx) {
      let reads = 0;
      const init = {
        get method() {
          return reads++ === 0 ? 'GET' : 'DELETE';
        },
      } as RequestInit;
      await ctx.fetch(`${GMAIL}/messages/m1`, init);
      return emptyResult();
    },
  };
  const deps: RunDeps = {
    env: { APLOS_LIVE_VAULT: vault, APLOS_GOOGLE_CLIENT_ID: 'client-fake' },
    fetch: net.fetchImpl,
    readSecret: async () => FAKE_REFRESH,
    now: () => now,
    sleep: async () => undefined,
    log: () => undefined,
    evidenceDir: evidence,
    probes: [sneaky],
  };
  const result = await runLive(
    { provider: 'gmail', tier: 'R', account: 'agent', dryRun: false, confirmMutating: false },
    deps,
  );
  const deletes = net.sent.filter(r => r.method === 'DELETE');
  const file = result.evidencePath ? await readFile(result.evidencePath, 'utf8') : '';
  assert.equal(
    deletes.length,
    0,
    `tier R sent ${deletes.length} DELETE; run exit ${result.exitCode}; evidence says: ${file.match(/Requests: .*/)?.[0]}`,
  );
});

test('TOCTOU: S-self, swapping init.body after the call cannot send to another address', async () => {
  const { guard, sent } = pipeline('S-self');
  const init: RequestInit = jsonInit({ raw: raw([`From: ${SELF}`, `To: ${SELF}`, 'Subject: t']) });
  const pending = outcome(guard, `${GMAIL}/messages/send`, init);
  // A plain object, no getter: the guard re-reads init.body after its checks have awaited.
  init.body = JSON.stringify({ raw: raw([`From: ${SELF}`, `To: ${OTHER}`, 'Subject: t']) });
  await pending;
  assert.equal(
    sent.filter(r => wireMentions(r, OTHER)).length,
    0,
    'a message to another address reached the wire',
  );
});

test('TOCTOU: tier M, flipping init.method after a draft update cannot become drafts.delete', async () => {
  const { guard, sent } = pipeline('M', r => (r.method === 'POST' ? { id: 'd1' } : {}));
  // Only a draft this run created can be updated.
  await guard(`${GMAIL}/drafts`, jsonInit({ message: { raw: raw([`To: ${SELF}`]) } }));
  const init: RequestInit = jsonInit({ message: { raw: raw([`To: ${SELF}`]) } }, 'PUT');
  const pending = outcome(guard, `${GMAIL}/drafts/d1`, init);
  init.method = 'DELETE';
  await pending;
  assert.deepEqual(
    sent.map(r => r.method),
    ['POST', 'PUT'],
    'drafts.delete (a permanent delete) reached the wire',
  );
});

test('TOCTOU: tier M, a calendar PATCH cannot become a PUT carrying attendees', async () => {
  const { guard, sent } = pipeline('M');
  const init: RequestInit = jsonInit({ summary: 'run event' }, 'PATCH');
  const pending = outcome(guard, `${CAL}/calendars/primary/events/e1?sendUpdates=none`, init);
  init.method = 'PUT';
  init.body = JSON.stringify({
    summary: 'run event',
    attendees: [{ email: OTHER, responseStatus: 'accepted' }],
  });
  await pending;
  assert.ok(
    sent.every(r => r.method === 'PATCH' && !r.body.includes('attendees')),
    `wire saw ${sent.map(r => `${r.method} ${r.body}`).join(' | ')}`,
  );
});

test('TOCTOU: tier M, override headers swapped in after the check do not reach the wire', async () => {
  const { guard, sent } = pipeline('M');
  const init: RequestInit = jsonInit({ summary: 'x' });
  const pending = outcome(guard, `${CAL}/calendars/primary/events?sendUpdates=none`, init);
  init.headers = { 'content-type': 'application/json', 'x-http-method-override': 'PUT' };
  await pending;
  assert.ok(
    sent.every(r => !r.headers.has('x-http-method-override')),
    'a verb override reached the wire',
  );
});

test('TOCTOU: tier R, a live Headers object mutated after the call does not add an override', async () => {
  const { guard, sent } = pipeline('R');
  const headers = new Headers();
  const pending = outcome(guard, `${GMAIL}/messages/m1`, { headers });
  // No await happened yet on the read path, but the pacer awaits before the bearer layer copies headers.
  headers.set('x-http-method-override', 'DELETE');
  await pending;
  assert.ok(
    sent.every(r => !r.headers.has('x-http-method-override')),
    'a verb override reached the wire in tier R',
  );
});

test('body check: a Blob whose arrayBuffer() lies (empty) cannot smuggle attendees into a calendar insert', async () => {
  class LyingBlob extends Blob {
    override async arrayBuffer(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    }
  }
  const { guard, sent } = pipeline('M');
  const body = new LyingBlob([JSON.stringify({ summary: 'x', attendees: [{ email: OTHER }] })], {
    type: 'application/json',
  });
  const result = await outcome(guard, `${CAL}/calendars/primary/events?sendUpdates=none`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.ok(
    sent.every(r => !r.body.includes('attendees')),
    `guard said ${result}; wire body: ${sent[0]?.body}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 2. Draft bookkeeping race (CONFIRMED at the guard)
// ---------------------------------------------------------------------------------------------

test('drafts: two overlapping updates cannot leave a draft to someone else marked as sendable', async () => {
  const stored = new Map<string, string>();
  const { guard, sent } = pipeline('S-self', request => {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname.endsWith('/drafts')) {
      stored.set('d1', (JSON.parse(request.body) as { message: { raw: string } }).message.raw);
      return { id: 'd1' };
    }
    if (request.method === 'PUT') {
      stored.set('d1', (JSON.parse(request.body) as { message: { raw: string } }).message.raw);
      return { id: 'd1' };
    }
    return { id: 'sent-1' };
  });
  const selfRaw = raw([`To: ${SELF}`]);
  const otherRaw = raw([`To: ${OTHER}`]);
  await guard(`${GMAIL}/drafts`, jsonInit({ message: { raw: selfRaw } }));
  // Two in flight at once: the server applies them in order, so the other-recipient one wins.
  await Promise.all([
    guard(`${GMAIL}/drafts/d1`, jsonInit({ message: { raw: selfRaw } }, 'PUT')),
    guard(`${GMAIL}/drafts/d1`, jsonInit({ message: { raw: otherRaw } }, 'PUT')),
  ]);
  assert.equal(stored.get('d1'), otherRaw, 'setup: the server now holds the other-recipient draft');
  const result = await outcome(guard, `${GMAIL}/drafts/send`, jsonInit({ id: 'd1' }));
  assert.match(
    result,
    /^refused:/,
    `drafts.send of a draft addressed to someone else was ${result} (wire: ${sent.length} requests)`,
  );
});

// ---------------------------------------------------------------------------------------------
// 3. Parser differentials with Google (PLAUSIBLE: depend on how Google reads the ambiguity)
// ---------------------------------------------------------------------------------------------

test('ambiguity: duplicate "raw" keys in a send body are refused (JSON.parse keeps the last, Google may keep the first)', async () => {
  const body = `{"raw":"${raw([`To: ${OTHER}`])}","raw":"${raw([`To: ${SELF}`])}"}`;
  await expectRefused('S-self', `${GMAIL}/messages/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
});

test('ambiguity: a repeated uploadType is refused (the guard reads the first)', async () => {
  await expectRefused('S-self', `${UPLOAD}/messages/send?uploadType=media&uploadType=multipart`, {
    method: 'POST',
    headers: { 'content-type': 'message/rfc822' },
    body: rfc822([`To: ${SELF}`]),
  });
});

test('ambiguity: a repeated sendUpdates is refused (the guard reads the first)', async () => {
  await expectRefused(
    'M',
    `${CAL}/calendars/primary/events?sendUpdates=none&sendUpdates=all`,
    jsonInit({ summary: 'x' }),
  );
});

test('ambiguity: sendNotifications spelled as 1 is refused alongside sendUpdates=none', async () => {
  await expectRefused(
    'M',
    `${CAL}/calendars/primary/events?sendUpdates=none&sendNotifications=1`,
    jsonInit({ summary: 'x' }),
  );
});

test('ambiguity: a media upload whose content type is multipart is refused', async () => {
  // Outer headers say self; a multipart reader would find the second message after the preamble.
  const body = [
    `To: ${SELF}`,
    'Subject: t',
    '',
    'preamble',
    '--b',
    'Content-Type: application/json',
    '',
    '{}',
    '--b',
    'Content-Type: message/rfc822',
    '',
    `To: ${OTHER}`,
    '',
    'hi',
    '--b--',
    '',
  ].join('\r\n');
  await expectRefused('S-self', `${UPLOAD}/messages/send?uploadType=media`, {
    method: 'POST',
    headers: { 'content-type': 'multipart/related; boundary=b' },
    body,
  });
});

test('ambiguity: an unquoted display name holding an address is refused, not ignored', async () => {
  // RFC 5322 does not allow "@" in an unquoted phrase; a lenient reader may treat it as an address.
  await expectRefused(
    'S-self',
    `${GMAIL}/messages/send`,
    jsonInit({ raw: raw([`To: ${OTHER} <${SELF}>`]) }),
  );
  await expectRefused(
    'S-self',
    `${GMAIL}/messages/send`,
    jsonInit({ raw: raw([`To: ${OTHER}: ${SELF};`]) }),
  );
});

// ---------------------------------------------------------------------------------------------
// 4. Scope of tier M writes (plan 20 section 5.4: labels, archive, read, star, drafts, run filter)
// ---------------------------------------------------------------------------------------------

test('scope: tier M cannot delete or patch calendar events the run did not create', async () => {
  await expectRefused('M', `${CAL}/calendars/primary/events/owners-event?sendUpdates=none`, {
    method: 'DELETE',
  });
  await expectRefused(
    'M',
    `${CAL}/calendars/primary/events/owners-event?sendUpdates=none`,
    jsonInit({ start: { dateTime: '2026-10-28T09:00:00Z' } }, 'PATCH'),
  );
});

test('scope: tier M cannot move mail to Spam or Trash through modify', async () => {
  await expectRefused('M', `${GMAIL}/messages/m1/modify`, jsonInit({ addLabelIds: ['SPAM'] }));
  await expectRefused(
    'M',
    `${GMAIL}/messages/batchModify`,
    jsonInit({ ids: ['m1', 'm2'], addLabelIds: ['TRASH'] }),
  );
});

// ---------------------------------------------------------------------------------------------
// 5. Leaks into stdout
// ---------------------------------------------------------------------------------------------

test('leak: a token pasted into accounts.json is not echoed by the error the runner prints', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'aplos-attack-vault-'));
  const pasted = 'ya29FAKEPASTEDTOKEN';
  await writeFile(join(vault, 'accounts.json'), `{"agent": ${pasted}}`);
  const deps: RunDeps = {
    env: { APLOS_LIVE_VAULT: vault, APLOS_GOOGLE_CLIENT_ID: 'client-fake' },
    fetch: wire().fetchImpl,
    readSecret: async () => FAKE_REFRESH,
    now: () => Date.parse('2026-10-27T10:00:00Z'),
    log: () => undefined,
    evidenceDir: vault,
    probes: [],
  };
  let message = '';
  try {
    await runLive(
      { provider: 'gmail', tier: 'R', account: 'agent', dryRun: true, confirmMutating: false },
      deps,
    );
  } catch (error) {
    // run.ts prints exactly this to stderr.
    message = error instanceof Error ? error.message : '';
  }
  assert.ok(
    !message.includes('ya29'),
    `stderr would print: ${message.replace(pasted.slice(4), '<rest>')}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 6. Defences that hold (these pass)
// ---------------------------------------------------------------------------------------------

test('holds: header injection and line-ending tricks in recipient headers are refused', async () => {
  const sends: string[][] = [
    [`To: ${SELF}\rBcc: ${OTHER}`],
    [`To: ${SELF}`, `Subject: x\rBcc: ${OTHER}`],
    [`To: ${SELF}\0`, `Bcc: ${OTHER}`],
    [`To: ${SELF}`, ' ', `Bcc: ${OTHER}`],
    [` To: ${SELF}`],
    [`To: ${SELF}`, `Bcc : ${OTHER}`],
    [`To: ${SELF}`, `BCC: ${OTHER}`],
    [`To: ${SELF}`, `To: ${OTHER}`],
    [`To: ${SELF}`, `Cc: ${SELF},`, `\t${OTHER}`],
    [`To: ${SELF}`, `Reply-To: ${OTHER}`],
    [`To: ${SELF}`, `Resent-To: ${OTHER}`],
    [`To: ${SELF}`, `Resent-Bcc: ${OTHER}`],
    [`To: <${OTHER}>`],
    [`To: "${SELF}" <${OTHER}>`],
    [`To: ${SELF} ${OTHER}`],
    [`To: ${SELF}(c)${OTHER}`],
    [`To: <other(c)@example.test>`],
    [`To: "other"@example.test`],
    [`To: "self"@example.test`],
    [`To: self+tag@example.test`],
    [`To: self@example.test.`],
    [`To: self@[127.0.0.1]`],
    [`To: <@route.example.test:${SELF}>`],
    [`To: self%other@example.test`],
    [`To: =?utf-8?B?${Buffer.from(OTHER).toString('base64')}?=`],
    [`To: =?utf-8?Q?other=40example.test?=`],
    [`To: <=?utf-8?Q?self=40example.test?=>`],
    [`To: list: ${SELF}, ${OTHER};`],
    [`Subject: none`],
  ];
  for (const headers of sends)
    await expectRefused('S-self', `${GMAIL}/messages/send`, jsonInit({ raw: raw(headers) }));
  // Look-alike domain (Cyrillic a) in UTF-8 bytes.
  await expectRefused(
    'S-self',
    `${GMAIL}/messages/send`,
    jsonInit({ raw: Buffer.from(rfc822(['To: self@exаmple.test']), 'utf8').toString('base64url') }),
  );
});

test('holds: case, plain display names and attached messages do not change the verdict', async () => {
  const allowed: string[][] = [
    ['To: SELF@EXAMPLE.TEST'],
    [`To: Self Test <${SELF}>`],
    [`To: "Self Test" <${SELF}>`],
    [`To: <${SELF}>, ${SELF}`],
  ];
  for (const headers of allowed) {
    const { guard } = pipeline('S-self');
    assert.equal(
      await outcome(guard, `${GMAIL}/messages/send`, jsonInit({ raw: raw(headers) })),
      'sent',
      headers.join(' / '),
    );
  }
  // An attached message/rfc822 part addressed elsewhere is not a recipient of the outer message.
  const attached = raw(
    [`To: ${SELF}`, 'Content-Type: multipart/mixed; boundary=z'],
    `--z\r\nContent-Type: message/rfc822\r\n\r\nTo: ${OTHER}\r\n\r\nhi\r\n--z--`,
  );
  const { guard } = pipeline('S-self');
  assert.equal(await outcome(guard, `${GMAIL}/messages/send`, jsonInit({ raw: attached })), 'sent');
});

test('strict recipients: comments, escapes, encoded words and marks in quoted names are refused, even around self', async () => {
  // Gmail's parser may disagree with ours on any of these, so none of them is interpreted.
  const refused: string[][] = [
    [`To: ${SELF} (other@example.test)`],
    [`To: ${SELF} (just a note)`],
    [`To: Self (note) <${SELF}>`],
    [`To: =?utf-8?B?b3RoZXJAZXhhbXBsZS50ZXN0?= <${SELF}>`],
    [`To: "a\\" <${OTHER}> \\"" <${SELF}>`],
    [`To: "Self\\ Test" <${SELF}>`],
    [`To: "self@example.test" <${SELF}>`],
    [`To: "Self <x>" <${SELF}>`],
    [`To: "Self, Test" <${SELF}>`],
    [`To: "Self; Test" <${SELF}>`],
    [`To: Self.Test <${SELF}>`],
    [`To: Me: ${SELF};`],
    [`To: undisclosed-recipients:;, ${SELF}`],
    [`To: ${SELF},`],
    [`To: Sélf <${SELF}>`],
  ];
  for (const headers of refused) {
    const { guard, sent } = pipeline('S-self');
    assert.equal(
      await outcome(guard, `${GMAIL}/messages/send`, jsonInit({ raw: raw(headers) })),
      'refused:send-unparseable',
      headers.join(' / '),
    );
    assert.equal(sent.length, 0, headers.join(' / '));
  }
});

test('strict raw: only the base64url alphabet, canonical and correctly padded, is decoded', async () => {
  // 34 bytes: the base64 text ends in a 2-character group, so it has padding and spare bits.
  const message = rfc822([`To: ${SELF}`], 'Hello?>>!');
  const standard = Buffer.from(message, 'latin1').toString('base64');
  assert.match(standard, /[+/]/, 'the fixture must use a character base64url does not have');
  const url = Buffer.from(message, 'latin1').toString('base64url');
  const padded = `${url}==`;
  assert.equal(padded.length % 4, 0);
  // Standard alphabet, too much padding, padding that ends mid-group, and non-zero spare bits.
  for (const value of [standard, `${url}===`, `${url}=`, `${url.slice(0, -1)}B`]) {
    const { guard, sent } = pipeline('S-self');
    assert.equal(
      await outcome(guard, `${GMAIL}/messages/send`, jsonInit({ raw: value })),
      'refused:send-unparseable',
      value.slice(-6),
    );
    assert.equal(sent.length, 0);
  }
  for (const value of [url, padded]) {
    const { guard } = pipeline('S-self');
    assert.equal(await outcome(guard, `${GMAIL}/messages/send`, jsonInit({ raw: value })), 'sent');
  }
});

test('holds: a 2 MB recipient header is parsed quickly and a trailing other address is still found', async () => {
  const many = Array.from({ length: 100_000 }, () => SELF).join(', ');
  const started = performance.now();
  await expectRefused(
    'S-self',
    `${GMAIL}/messages/send`,
    jsonInit({ raw: raw([`To: ${many}, ${OTHER}`]) }),
  );
  assert.ok(performance.now() - started < 5_000);
});

test('holds: upload, batch, alternate hosts and multipart smuggling are refused', async () => {
  const multipart = `--b\r\nContent-Type: application/json\r\n\r\n{}\r\n--b\r\nContent-Type: message/rfc822\r\n\r\nTo: ${OTHER}\r\n\r\nhi\r\n--b--`;
  await expectRefused('S-self', `${UPLOAD}/messages/send?uploadType=multipart`, {
    method: 'POST',
    headers: { 'content-type': 'multipart/related; boundary=b' },
    body: multipart,
  });
  await expectRefused('S-self', `${UPLOAD}/messages/send?uploadType=resumable`, {
    method: 'POST',
    body: '',
  });
  await expectRefused('S-self', `${UPLOAD}/messages/send`, {
    method: 'POST',
    body: rfc822([`To: ${SELF}`]),
  });
  await expectRefused('S-self', `${UPLOAD}/drafts?uploadType=media`, {
    method: 'POST',
    body: rfc822([`To: ${OTHER}`]),
  });
  await expectRefused('S-self', `${UPLOAD}/messages/send?uploadType=media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rfc822([`To: ${SELF}`]),
  });
  const batch = `--batch\r\nContent-Type: application/http\r\n\r\nDELETE /gmail/v1/users/me/messages/m1\r\n\r\n--batch\r\nContent-Type: application/http\r\n\r\nPOST /gmail/v1/users/me/messages/send\r\n\r\n{}\r\n--batch--`;
  for (const url of [
    'https://gmail.googleapis.com/batch/gmail/v1',
    'https://gmail.googleapis.com/batch',
    'https://www.googleapis.com/batch',
    'https://www.googleapis.com/batch/gmail/v1',
    `${CAL.replace('/calendar/v3', '')}/batch/calendar/v3`,
  ]) {
    await expectRefused('S-self', url, {
      method: 'POST',
      headers: { 'content-type': 'multipart/mixed; boundary=batch' },
      body: batch,
    });
  }
  await expectRefused(
    'S-self',
    'https://www.googleapis.com/gmail/v1/users/me/messages/send',
    jsonInit({ raw: raw([`To: ${SELF}`]) }),
  );
  await expectRefused(
    'S-self',
    'https://www.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media',
    { method: 'POST', body: rfc822([`To: ${SELF}`]) },
  );
});

test('holds: URL path tricks resolve to a forbidden row or are refused', async () => {
  await expectRefused(
    'M',
    `${GMAIL}/labels/%2e%2e/settings/forwardingAddresses`,
    jsonInit({ forwardingEmail: OTHER }),
  );
  await expectRefused(
    'M',
    `${GMAIL}/labels/x/../../settings/sendAs`,
    jsonInit({ sendAsEmail: OTHER }),
  );
  await expectRefused('M', `${GMAIL}/messages/m1%2F..%2F..%2Fsettings%2Fdelegates`, jsonInit({}));
  await expectRefused('M', `${GMAIL}/drafts/d1%5Cdelete`, { method: 'PUT', body: '{}' });
  await expectRefused('M', `${GMAIL}/messages%2Fsend`, jsonInit({ raw: raw([`To: ${OTHER}`]) }));
  await expectRefused('M', `${GMAIL}/messages/m1:trash`, jsonInit({}));
  await expectRefused('M', `${GMAIL}/messages/m1%3Atrash`, jsonInit({}));
  await expectRefused('M', `${GMAIL}/messages/m1/trash`, jsonInit({}));
  await expectRefused('M', `${GMAIL}/messages/import`, jsonInit({ raw: raw([`To: ${OTHER}`]) }));
  await expectRefused('M', `${GMAIL}/messages`, jsonInit({ raw: raw([`To: ${OTHER}`]) }));
  await expectRefused(
    'M',
    `${CAL}/calendars/primary/events/quickAdd?text=meet%20${encodeURIComponent(OTHER)}&sendUpdates=none`,
    { method: 'POST' },
  );
  await expectRefused(
    'M',
    `${CAL}/calendars/primary/events/import?sendUpdates=none`,
    jsonInit({ summary: 'x' }),
  );
  await expectRefused(
    'M',
    `${CAL}/calendars/someone%40example.test/events?sendUpdates=none`,
    jsonInit({ summary: 'x' }),
  );
  await expectRefused('M', 'https://GMAIL.googleapis.com.example.test/gmail/v1/users/me/profile');
  await expectRefused('M', 'https://gmаil.googleapis.com/gmail/v1/users/me/profile');
});

test('holds: method overrides, odd verbs and query overrides are refused', async () => {
  await expectRefused('R', `${GMAIL}/messages/m1`, { method: 'HEAD' });
  await expectRefused('R', `${GMAIL}/messages/m1`, { method: 'OPTIONS' });
  await expectRefused('M', `${GMAIL}/messages/m1`, { method: 'TRACE' });
  await expectRefused('M', `${GMAIL}/messages/m1/modify`, {
    method: 'POST',
    headers: { 'X-HTTP-Method-Override': 'DELETE' },
    body: '{}',
  });
  await expectRefused('M', `${GMAIL}/messages/m1/modify`, {
    method: 'POST',
    headers: { 'X-Http-Method': 'DELETE' },
    body: '{}',
  });
  await expectRefused('M', `${GMAIL}/messages/m1/modify`, {
    method: 'POST',
    headers: [['x-method-override', 'DELETE']],
    body: '{}',
  });
  await expectRefused('R', `${GMAIL}/messages/m1?$httpMethod=DELETE`);
  await expectRefused('R', `${GMAIL}/messages/m1?%24httpMethod=DELETE`);
  await expectRefused('R', `${GMAIL}/messages/m1?_method=DELETE`);
  await expectRefused('R', `${GMAIL}/messages/m1?X-HTTP-Method-Override=DELETE`);
  // Reads take only documented read parameters: alt, a second credential or an upload form are refused.
  for (const query of [
    'alt=media',
    'access_token=x',
    'key=x',
    'oauth_token=x',
    'quotaUser=x',
    'uploadType=media',
    'callback=x',
    '%24.xgafv=2',
    'max_results=5',
  ])
    await expectRefused('R', `${GMAIL}/messages/m1?${query}`);
  const { guard, sent } = pipeline('R');
  await guard(
    `${GMAIL}/threads?labelIds=INBOX&maxResults=5&pageToken=p&q=x&fields=threads(id)&prettyPrint=false`,
  );
  await guard(`${GMAIL}/messages/m1?format=metadata&metadataHeaders=From&metadataHeaders=Date`);
  await guard(`${CAL}/calendars/primary/events?timeMin=t&singleEvents=true&orderBy=startTime`);
  assert.deepEqual(
    sent.map(r => r.method),
    ['GET', 'GET', 'GET'],
  );
});

test('holds: redirects are always errors, whatever the caller asks for', async () => {
  const seen: (string | undefined)[] = [];
  const guard = createGuardedFetch(
    async (_input, init) => {
      seen.push(init?.redirect);
      return new Response('{}');
    },
    { tier: 'R' },
  );
  await guard(`${GMAIL}/profile`, { redirect: 'follow' });
  await guard(`${GMAIL}/profile`, { redirect: 'manual' });
  assert.deepEqual(seen, ['error', 'error']);
});

test('holds: forbidden calls are refused in every tier', async () => {
  for (const tier of ['M', 'S-self'] as const) {
    await expectRefused(tier, `${GMAIL}/messages/m1`, { method: 'DELETE' });
    await expectRefused(tier, `${GMAIL}/threads/t1`, { method: 'DELETE' });
    await expectRefused(tier, `${GMAIL}/drafts/d1`, { method: 'DELETE' });
    await expectRefused(tier, `${GMAIL}/messages/batchDelete`, jsonInit({ ids: ['m1'] }));
    await expectRefused(
      tier,
      `${GMAIL}/settings/forwardingAddresses`,
      jsonInit({ forwardingEmail: OTHER }),
    );
    await expectRefused(
      tier,
      `${GMAIL}/settings/autoForwarding`,
      jsonInit({ enabled: true, emailAddress: OTHER }, 'PUT'),
    );
    await expectRefused(
      tier,
      `${GMAIL}/settings/vacation`,
      jsonInit({ enableAutoReply: true }, 'PUT'),
    );
    await expectRefused(tier, `${GMAIL}/settings/delegates`, jsonInit({ delegateEmail: OTHER }));
    await expectRefused(
      tier,
      `${GMAIL}/settings/filters`,
      jsonInit({ criteria: { from: 'x' }, action: { forward: OTHER } }),
    );
    await expectRefused(tier, `${GMAIL}/settings/filters`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"action":{"forw\\u0061rd":"other@example.test"}}',
    });
    await expectRefused(tier, `${GMAIL}/settings/filters/not-ours`, { method: 'DELETE' });
    await expectRefused(
      tier,
      `${CAL}/calendars/primary/events?sendUpdates=none`,
      jsonInit({ attendees: [{ email: OTHER }] }),
    );
    await expectRefused(
      tier,
      `${CAL}/calendars/primary/events/e1?sendUpdates=none`,
      jsonInit({ summary: 'x', attendees: [] }, 'PATCH'),
    );
    await expectRefused(tier, `${CAL}/calendars/primary/events/e1?sendUpdates=none`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{"x":{"responseStatus":"declined"}}',
    });
    await expectRefused(
      tier,
      `${CAL}/calendars/primary/events/e1?sendUpdates=all`,
      jsonInit({ summary: 'x' }, 'PATCH'),
    );
    await expectRefused(
      tier,
      `${CAL}/calendars/primary/events/e1`,
      jsonInit({ summary: 'x' }, 'PATCH'),
    );
    await expectRefused(
      tier,
      `${CAL}/calendars/primary/events/e1?sendUpdates=none`,
      jsonInit({ summary: 'x' }, 'PUT'),
    );
    await expectRefused(tier, `${CAL}/users/me/calendarList/primary`, { method: 'DELETE' });
    await expectRefused(tier, 'https://oauth2.googleapis.com/revoke?token=x', { method: 'POST' });
    await expectRefused(tier, 'https://unsubscribe.example.test/u?list=1', { method: 'POST' });
    await expectRefused(tier, `${GMAIL}/settings/filters`, {
      method: 'POST',
      body: new ReadableStream() as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit);
    const { guard, sent } = pipeline(tier);
    const smuggled = new Request(`${GMAIL}/drafts/d1`, { method: 'DELETE' });
    assert.equal(
      await outcome(guard, smuggled as unknown as string),
      'refused:unsupported-request',
    );
    assert.equal(sent.length, 0);
  }
  // Sends outside S-self, even to self.
  await expectRefused('M', `${GMAIL}/messages/send`, jsonInit({ raw: raw([`To: ${SELF}`]) }));
  // drafts.send of a draft the guard never saw.
  await expectRefused('S-self', `${GMAIL}/drafts/send`, jsonInit({ id: 'someone-elses-draft' }));
});

test('holds: refusals carry no address, URL, id or token', async () => {
  const { guard } = pipeline('S-self');
  try {
    await guard(
      `${GMAIL}/messages/send?q=secret-subject`,
      jsonInit({ raw: raw([`To: ${OTHER}`, 'Subject: secret-subject']) }),
    );
    assert.fail('should refuse');
  } catch (error) {
    const text = `${(error as Error).message} ${(error as Error).stack ?? ''}`;
    for (const needle of [OTHER, 'secret-subject', 'gmail.googleapis.com', FAKE_ACCESS])
      assert.ok(!text.includes(needle), needle);
  }
});

test('holds: the keychain writer rejects quoting tricks before it spawns anything', async () => {
  for (const secret of ['a" -T /bin/sh "', 'a\nadd-generic-password -s x -w y', 'a b', '$(id)']) {
    await assert.rejects(
      keychainWriter('aplos-mail-live-attack', secret),
      /unsupported characters/,
    );
  }
  await assert.rejects(keychainWriter('svc"; delete-keychain', 'abc'), /unsupported characters/);
});

test('holds: tier R log check still flags any non-GET other than the token refresh', () => {
  assert.equal(
    readOnlyViolations([{ method: 'oauth.userinfo', httpMethod: 'POST', count: 1 }]).length,
    1,
  );
});
