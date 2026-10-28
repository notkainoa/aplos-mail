import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuardedFetch, GuardRefusal, readOnlyViolations, type GuardReason, type GuardedFetch } from '../../../apps/desktop/scripts/live/guard';
import type { Tier } from '../../../apps/desktop/scripts/live/types';

const SELF = 'self@example.test';
const OTHER = 'other@example.test';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3';

interface Call {
  url: string;
  method: string;
  redirect?: string;
  body?: unknown;
}

/** A stand-in for the network: records what was really sent and answers with canned JSON. */
function network(answer: (url: string, method: string) => unknown = () => ({})) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, redirect: init?.redirect, body: init?.body });
    return new Response(JSON.stringify(answer(url, method)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

function guardFor(tier: Tier, answer?: (url: string, method: string) => unknown) {
  const net = network(answer);
  const guard = createGuardedFetch(net.fetchImpl, { tier, selfAddress: SELF, calendarRunId: 'run-test' });
  return { ...net, guard };
}

async function refusal(guard: GuardedFetch, url: string, init?: RequestInit): Promise<GuardRefusal> {
  try {
    await guard(url, init);
  } catch (error) {
    assert.ok(error instanceof GuardRefusal, `expected a GuardRefusal, got ${String(error)}`);
    return error;
  }
  assert.fail(`${init?.method ?? 'GET'} ${url} should have been refused`);
}

async function assertRefused(tier: Tier, reason: GuardReason, url: string, init?: RequestInit, answer?: (url: string, method: string) => unknown): Promise<void> {
  const { guard, calls } = guardFor(tier, answer);
  const error = await refusal(guard, url, init);
  assert.equal(error.reason, reason, `${init?.method ?? 'GET'} ${url}`);
  assert.equal(calls.length, 0, 'nothing may be sent for a refused request');
}

const json = (value: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const b64 = (text: string): string => Buffer.from(text, 'latin1').toString('base64url');
const message = (headers: string[], body = 'Hello'): string => b64(`${headers.join('\r\n')}\r\n\r\n${body}`);

test('origins: only the Google API, OAuth and Calendar hosts are reachable', async () => {
  const bad = [
    'https://evil.example.test/gmail/v1/users/me/profile',
    'http://gmail.googleapis.com/gmail/v1/users/me/profile',
    'https://gmail.googleapis.com.evil.example.test/gmail/v1/users/me/profile',
    'https://gmail.googleapis.com@evil.example.test/gmail/v1/users/me/profile',
    'https://user:pw@gmail.googleapis.com/gmail/v1/users/me/profile',
    'https://gmail.googleapis.com:8443/gmail/v1/users/me/profile',
    'https://accounts.google.com/o/oauth2/v2/auth',
    'https://unsubscribe.example.test/u?id=1',
    'ftp://gmail.googleapis.com/x',
  ];
  for (const tier of ['R', 'M', 'S-self'] as const) for (const url of bad) await assertRefused(tier, 'origin-not-allowed', url);
  await assertRefused('R', 'unsupported-request', 'not a url');
  await assertRefused('R', 'unsupported-request', '/relative/path');
});

test('a Request object is refused because its body cannot be checked unread', async () => {
  const { guard, calls } = guardFor('M');
  await assert.rejects(guard(new Request(`${GMAIL}/profile`) as never), (error: unknown) => error instanceof GuardRefusal && error.reason === 'unsupported-request');
  assert.equal(calls.length, 0);
});

test('tier R: every write is refused except the OAuth token refresh', async () => {
  for (const [method, url] of [
    ['POST', `${GMAIL}/messages/abc123/modify`],
    ['POST', `${GMAIL}/messages/batchModify`],
    ['POST', `${GMAIL}/threads/abc123/modify`],
    ['POST', `${GMAIL}/labels`],
    ['DELETE', `${GMAIL}/labels/Label_1`],
    ['POST', `${GMAIL}/drafts`],
    ['PUT', `${GMAIL}/drafts/d1`],
    ['POST', `${GMAIL}/messages/send`],
    ['POST', `${GMAIL}/settings/filters`],
    ['PATCH', `${CAL}/calendars/primary/events/e1`],
    ['POST', `${CAL}/calendars/primary/events`],
    ['POST', 'https://oauth2.googleapis.com/revoke'],
    ['HEAD', `${GMAIL}/profile`],
  ]) {
    const { guard, calls } = guardFor('R');
    const error = await refusal(guard, url, { method, body: '{}' });
    assert.ok(['tier-r-read-only', 'unsupported-request'].includes(error.reason), `${method} ${url} -> ${error.reason}`);
    assert.equal(calls.length, 0);
  }
  const { guard, calls } = guardFor('R');
  await guard(`${GMAIL}/profile`);
  await guard(`${GMAIL}/threads?labelIds=INBOX`);
  await guard('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token' }) });
  assert.equal(calls.length, 3);
  assert.deepEqual(readOnlyViolations(guard.requests()), []);
});

test('readOnlyViolations flags a write in a request log', () => {
  assert.equal(readOnlyViolations([{ method: 'gmail.users.messages.modify', httpMethod: 'POST', count: 1 }]).length, 1);
  assert.equal(readOnlyViolations([{ method: 'oauth.token', httpMethod: 'POST', count: 2 }]).length, 0);
});

test('requests are recorded by API method name and verb, never by URL, and sent with redirects off', async () => {
  const { guard, calls } = guardFor('R');
  await guard(`${GMAIL}/threads/aaa?format=metadata`);
  await guard(`${GMAIL}/threads/bbb?format=metadata`);
  await guard(`${GMAIL}/labels`);
  assert.deepEqual(guard.requests().sort((a, b) => a.method.localeCompare(b.method)), [
    { method: 'gmail.users.labels.list', httpMethod: 'GET', count: 1 },
    { method: 'gmail.users.threads.get', httpMethod: 'GET', count: 2 },
  ]);
  assert.ok(calls.every(call => call.redirect === 'error'), 'a redirect could leave the allowed hosts');
});

test('verb overrides cannot turn a POST into a delete', async () => {
  await assertRefused('M', 'method-override', `${GMAIL}/messages/abc/modify`, { method: 'POST', headers: { 'X-HTTP-Method-Override': 'DELETE' }, body: '{}' });
  await assertRefused('M', 'method-override', `${GMAIL}/messages/abc/modify?$httpMethod=DELETE`, { method: 'POST', body: '{}' });
  await assertRefused('R', 'method-override', `${GMAIL}/profile`, { headers: { 'x-http-method': 'DELETE' } });
});

test('paths: encoded slashes, double slashes, custom verbs and unknown endpoints are refused', async () => {
  await assertRefused('M', 'url-not-canonical', `${GMAIL}/messages/abc%2Fmodify`, json({}));
  await assertRefused('M', 'url-not-canonical', `${GMAIL}//messages/abc`);
  await assertRefused('M', 'unknown-endpoint', `${GMAIL}/messages/abc%3AbatchDelete`, json({}));
  await assertRefused('M', 'unknown-endpoint', `${GMAIL}/messages/abc:batchDelete`, json({}));
  await assertRefused('M', 'unknown-endpoint', 'https://gmail.googleapis.com/gmail/v1/users/someone@example.test/messages');
  await assertRefused('M', 'unknown-endpoint', 'https://www.googleapis.com/gmail/v1/users/me/messages');
  await assertRefused('M', 'unknown-endpoint', `${GMAIL}/watch`, json({}));
  await assertRefused('M', 'unknown-endpoint', `${GMAIL}/messages/import`, json({}));
  await assertRefused('M', 'unknown-endpoint', `${GMAIL}/labels/Label_1`, json({}, 'PATCH'));
  await assertRefused('M', 'unknown-endpoint', `${GMAIL}/messages/abc/trash`, json({}));
  await assertRefused('M', 'unknown-endpoint', `${GMAIL}/profile/extra`);
});

test('permanent deletes are refused in every tier', async () => {
  const cases: [string, RequestInit][] = [
    [`${GMAIL}/messages/abc123`, { method: 'DELETE' }],
    [`${GMAIL}/messages/batchDelete`, json({ ids: ['a'] })],
    [`${GMAIL}/threads/abc123`, { method: 'DELETE' }],
    [`${GMAIL}/drafts/d1`, { method: 'DELETE' }],
  ];
  for (const tier of ['M', 'S-self'] as const) for (const [url, init] of cases) await assertRefused(tier, 'permanent-delete', url, init);
});

test('settings writes are refused except filter create and delete', async () => {
  const writes: [string, string][] = [
    ['POST', 'settings/sendAs'], ['PATCH', 'settings/sendAs/x@example.test'], ['DELETE', 'settings/sendAs/x'],
    ['POST', 'settings/forwardingAddresses'], ['PUT', 'settings/autoForwarding'], ['POST', 'settings/delegates'],
    ['PUT', 'settings/imap'], ['PUT', 'settings/pop'], ['PUT', 'settings/vacation'], ['PUT', 'settings/language'],
    ['POST', 'settings/cse/identities'], ['PATCH', 'settings/labels'],
  ];
  for (const tier of ['M', 'S-self'] as const) {
    for (const [method, tail] of writes) await assertRefused(tier, 'settings-write', `${GMAIL}/${tail}`, json({}, method));
  }
});

test('filters: creation is allowed without forwarding, and only this run\'s filters can be deleted', async () => {
  const net = network((url, method) => (method === 'POST' && url.endsWith('/settings/filters') ? { id: 'filter-1' } : {}));
  const run = new Set<string>();
  const guard = createGuardedFetch(net.fetchImpl, { tier: 'M', allowRunFilterIds: run });

  await assert.rejects(guard(`${GMAIL}/settings/filters/filter-1`, { method: 'DELETE' }), (e: unknown) => e instanceof GuardRefusal && e.reason === 'filter-not-created-by-run');
  await assert.rejects(guard(`${GMAIL}/settings/filters`, json({ criteria: { from: 'a' }, action: { forward: OTHER } })), (e: unknown) => e instanceof GuardRefusal && e.reason === 'filter-forward');
  assert.equal(net.calls.length, 0);

  await guard(`${GMAIL}/settings/filters`, json({ criteria: { from: 'a' }, action: { addLabelIds: ['STARRED'] } }));
  assert.deepEqual([...run], ['filter-1']);
  await assert.rejects(guard(`${GMAIL}/settings/filters/someone-elses`, { method: 'DELETE' }), (e: unknown) => e instanceof GuardRefusal && e.reason === 'filter-not-created-by-run');
  await guard(`${GMAIL}/settings/filters/filter-1`, { method: 'DELETE' });
  assert.equal(run.size, 0);
  assert.equal(net.calls.length, 2);

  // A caller can also hand the guard a set of ids it created in an earlier step.
  const preset = createGuardedFetch(net.fetchImpl, { tier: 'M', allowRunFilterIds: new Set(['mine']) });
  await preset(`${GMAIL}/settings/filters/mine`, { method: 'DELETE' });
});

test('labels: only labels this run created can be deleted', async () => {
  const net = network((url, method) => (method === 'POST' && url.endsWith('/labels') ? { id: 'Label_77', name: 'x' } : {}));
  const guard = createGuardedFetch(net.fetchImpl, { tier: 'M' });
  await assert.rejects(guard(`${GMAIL}/labels/Label_1`, { method: 'DELETE' }), (e: unknown) => e instanceof GuardRefusal && e.reason === 'label-not-created-by-run');
  await assert.rejects(guard(`${GMAIL}/labels/INBOX`, { method: 'DELETE' }), (e: unknown) => e instanceof GuardRefusal && e.reason === 'label-not-created-by-run');
  await guard(`${GMAIL}/labels`, json({ name: 'aplos-live-check' }));
  assert.ok(guard.createdLabelIds.has('Label_77'));
  await guard(`${GMAIL}/labels/Label_77`, { method: 'DELETE' });
  await assert.rejects(guard(`${GMAIL}/labels/Label_77`, { method: 'DELETE' }), (e: unknown) => e instanceof GuardRefusal && e.reason === 'label-not-created-by-run');
});

test('reversible mailbox changes are allowed in M and S-self', async () => {
  for (const tier of ['M', 'S-self'] as const) {
    const { guard, calls } = guardFor(tier);
    await guard(`${GMAIL}/messages/abc/modify`, json({ addLabelIds: ['STARRED'] }));
    await guard(`${GMAIL}/threads/abc/modify`, json({ removeLabelIds: ['INBOX'] }));
    await guard(`${GMAIL}/messages/batchModify`, json({ ids: ['a'], removeLabelIds: ['UNREAD'] }));
    assert.equal(calls.length, 3);
  }
});

/** A tier M guard that has inserted event e1, so e1 counts as made by this run. */
async function guardWithRunEvent() {
  const net = network((_url, method) => (method === 'POST' ? { id: 'e1', extendedProperties: { private: { aplosLiveRun: 'run-test' } } } : {}));
  const guard = createGuardedFetch(net.fetchImpl, { tier: 'M', selfAddress: SELF, calendarRunId: 'run-test' });
  await guard(`${CAL}/calendars/primary/events?sendUpdates=none`, json({ summary: 'run event', extendedProperties: { private: { aplosLiveRun: 'run-test' } } }));
  net.calls.length = 0;
  return { ...net, guard };
}

async function assertRefusedOnRunEvent(reason: GuardReason, url: string, init?: RequestInit): Promise<void> {
  const { guard, calls } = await guardWithRunEvent();
  const error = await refusal(guard, url, init);
  assert.equal(error.reason, reason, `${init?.method ?? 'GET'} ${url}`);
  assert.equal(calls.length, 0, 'nothing may be sent for a refused request');
}

test('calendar: attendees, notifications, RSVPs, calendar-list writes and replacing updates are refused', async () => {
  const q = '?sendUpdates=none';
  await assertRefused('M', 'calendar-attendees', `${CAL}/calendars/primary/events${q}`, json({ summary: 'x', attendees: [{ email: OTHER }] }));
  await assertRefusedOnRunEvent('calendar-attendees', `${CAL}/calendars/primary/events/e1${q}`, json({ attendees: [] }, 'PATCH'));
  await assertRefusedOnRunEvent('calendar-attendees', `${CAL}/calendars/primary/events/e1${q}`, json({ extendedProperties: { x: { attendees: 1 } } }, 'PATCH'));
  await assertRefusedOnRunEvent('calendar-rsvp', `${CAL}/calendars/primary/events/e1${q}`, json({ attendees: [{ email: SELF, responseStatus: 'accepted' }] }, 'PATCH'));
  await assertRefused('M', 'calendar-send-updates', `${CAL}/calendars/primary/events?sendUpdates=all`, json({ summary: 'x' }));
  await assertRefused('M', 'calendar-send-updates', `${CAL}/calendars/primary/events?sendUpdates=externalOnly`, json({ summary: 'x' }));
  await assertRefused('M', 'calendar-send-updates', `${CAL}/calendars/primary/events`, json({ summary: 'x' }));
  await assertRefused('M', 'calendar-send-updates', `${CAL}/calendars/primary/events?sendUpdates=none&sendNotifications=true`, json({ summary: 'x' }));
  await assertRefused('M', 'calendar-send-updates', `${CAL}/calendars/primary/events?sendUpdates=none&sendNotifications=1`, json({ summary: 'x' }));
  await assertRefusedOnRunEvent('calendar-send-updates', `${CAL}/calendars/primary/events/e1`, { method: 'DELETE' });
  await assertRefused('M', 'calendar-put-replaces', `${CAL}/calendars/primary/events/e1${q}`, json({ summary: 'x' }, 'PUT'));
  await assertRefused('M', 'calendar-not-own', `${CAL}/calendars/${OTHER.replace('@', '%40')}/events${q}`, json({ summary: 'x' }));
  await assertRefused('M', 'body-unparseable', `${CAL}/calendars/primary/events${q}`, { method: 'POST', body: 'not json' });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await assertRefused('M', 'calendar-list-write', `${CAL}/users/me/calendarList`, json({ id: 'x' }, method));
    await assertRefused('M', 'calendar-list-write', `${CAL}/users/me/calendarList/primary`, json({ hidden: true }, method));
  }
  await assertRefused('M', 'unknown-endpoint', `${CAL}/calendars/primary/events/e1/move?destination=x`, json({}));
  await assertRefused('M', 'unknown-endpoint', `${CAL}/calendars/primary/events/quickAdd?text=lunch`, json({}));
});

test('calendar: only events this run inserted can be changed or deleted', async () => {
  const q = '?sendUpdates=none';
  await assertRefused('M', 'calendar-event-not-created-by-run', `${CAL}/calendars/primary/events/owners-event${q}`, json({ summary: 'x' }, 'PATCH'));
  await assertRefused('M', 'calendar-event-not-created-by-run', `${CAL}/calendars/primary/events/owners-event${q}`, { method: 'DELETE' });
  // A failed insert makes nothing deletable, and a deleted event is no longer one of ours.
  const failing = createGuardedFetch(async () => new Response('{"id":"e9"}', { status: 500 }), { tier: 'M', selfAddress: SELF, calendarRunId: 'run-test' });
  await failing(`${CAL}/calendars/primary/events${q}`, json({ summary: 'x', extendedProperties: { private: { aplosLiveRun: 'run-test' } } }));
  await assert.rejects(failing(`${CAL}/calendars/primary/events/e9${q}`, { method: 'DELETE' }), { reason: 'calendar-event-not-created-by-run' });
  const { guard } = await guardWithRunEvent();
  await guard(`${CAL}/calendars/primary/events/e1${q}`, { method: 'DELETE' });
  await assert.rejects(guard(`${CAL}/calendars/primary/events/e1${q}`, { method: 'DELETE' }), { reason: 'calendar-event-not-created-by-run' });
});

test('calendar: plain event changes on the own calendar with sendUpdates=none are allowed', async () => {
  const { guard, calls } = guardFor('M', (_url, method) => (method === 'POST' ? { id: 'e1', extendedProperties: { private: { aplosLiveRun: 'run-test' } } } : {}));
  await guard(`${CAL}/calendars/primary/events?sendUpdates=none`, json({ summary: 'Test event', start: {}, end: {}, extendedProperties: { private: { aplosLiveRun: 'run-test' } } }));
  await guard(`${CAL}/calendars/${SELF.replace('@', '%40')}/events/e1?sendUpdates=none`, json({ summary: 'Renamed' }, 'PATCH'));
  await guard(`${CAL}/calendars/primary/events/e1?sendUpdates=none`, { method: 'DELETE' });
  await guard(`${CAL}/calendars/primary/events`);
  await guard(`${CAL}/users/me/calendarList`);
  assert.equal(calls.length, 5);
  // The body that was checked is the body that was sent.
  assert.equal(String(calls[0]!.body), JSON.stringify({ summary: 'Test event', start: {}, end: {}, extendedProperties: { private: { aplosLiveRun: 'run-test' } } }));
});

test('mail: modify and batchModify cannot move mail to Spam or Trash', async () => {
  for (const label of ['SPAM', 'TRASH', 'trash']) {
    await assertRefused('M', 'label-spam-trash', `${GMAIL}/messages/m1/modify`, json({ addLabelIds: ['STARRED', label] }));
    await assertRefused('M', 'label-spam-trash', `${GMAIL}/messages/batchModify`, json({ ids: ['m1'], addLabelIds: [label] }));
    await assertRefused('M', 'label-spam-trash', `${GMAIL}/threads/t1/modify`, json({ addLabelIds: [label] }));
  }
  await assertRefused('M', 'body-unparseable', `${GMAIL}/messages/m1/modify`, json({ addLabelIds: 'TRASH' }));
  const { guard, calls } = guardFor('M');
  await guard(`${GMAIL}/messages/m1/modify`, json({ addLabelIds: ['STARRED'], removeLabelIds: ['INBOX', 'UNREAD', 'TRASH'] }));
  assert.equal(calls.length, 1);
});

test('batch requests are refused because a part could hide any of the above', async () => {
  await assertRefused('M', 'batch-unsupported', 'https://gmail.googleapis.com/batch/gmail/v1', { method: 'POST', body: '--b--' });
  await assertRefused('S-self', 'batch-unsupported', 'https://www.googleapis.com/batch/calendar/v3', { method: 'POST', body: '--b--' });
});

test('the body that was checked is the body that is sent, even if the caller reuses its buffer', async () => {
  const { guard, calls } = guardFor('M');
  const body = Buffer.from(JSON.stringify({ summary: 'safe', extendedProperties: { private: { aplosLiveRun: 'run-test' } } }));
  await guard(`${CAL}/calendars/primary/events?sendUpdates=none`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  body.fill(0x58);
  assert.equal(Buffer.from(calls[0]!.body as Uint8Array).toString(), JSON.stringify({ summary: 'safe', extendedProperties: { private: { aplosLiveRun: 'run-test' } } }));
});

test('a refusal never contains the address, the URL or the id', async () => {
  const { guard } = guardFor('S-self');
  const url = `${GMAIL}/messages/send`;
  const error = await refusal(guard, url, json({ raw: message([`To: ${OTHER}`, 'Subject: Secret plans']) }));
  assert.equal(error.reason, 'send-recipients');
  for (const secret of [OTHER, SELF, 'Secret plans', 'googleapis', 'messages/send']) assert.ok(!error.message.includes(secret), `message leaked ${secret}`);
  assert.deepEqual(guard.refusals(), { 'send-recipients': 1 });
});

test('S-self needs an address; selfAddress must be a plain mailbox', () => {
  assert.throws(() => createGuardedFetch(network().fetchImpl, { tier: 'S-self' }));
  assert.throws(() => createGuardedFetch(network().fetchImpl, { tier: 'S-self', selfAddress: 'Name <a@b.test>' }));
});

// ---------- sends ----------

const sendJson = (raw: string): [string, RequestInit] => [`${GMAIL}/messages/send`, json({ raw })];

test('sends are refused outside tier S-self, even to the account itself', async () => {
  const raw = message([`To: ${SELF}`, 'Subject: hi']);
  for (const tier of ['R', 'M'] as const) {
    const [url, init] = sendJson(raw);
    const { guard, calls } = guardFor(tier);
    const error = await refusal(guard, url, init);
    assert.ok(error.reason === 'send-tier' || error.reason === 'tier-r-read-only');
    assert.equal(calls.length, 0);
  }
  await assertRefused('M', 'send-tier', `${UPLOAD}/messages/send?uploadType=media`, { method: 'POST', body: `To: ${SELF}\r\n\r\nhi` });
  await assertRefused('M', 'send-tier', `${GMAIL}/drafts/send`, json({ id: 'd1' }));
});

const ALLOWED: Record<string, string[]> = {
  'plain to self': [`To: ${SELF}`],
  'upper case and display name': [`To: Me <SELF@Example.Test>`],
  'to, cc and bcc all self': [`To: ${SELF}`, `Cc: ${SELF}`, `Bcc: ${SELF}`],
  'bcc only, self': [`Bcc: ${SELF}`],
  'group of self': [`To: Me: ${SELF};`],
  'empty group plus self': [`To: undisclosed-recipients:;, ${SELF}`],
  'display name that looks like another address': [`To: "${OTHER}" <${SELF}>`],
  'encoded-word display name that decodes to another address': [`To: =?utf-8?q?other=40example.test?= <${SELF}>`],
  'comment that looks like another address': [`To: ${SELF} (${OTHER})`],
  'folded header': [`To: ${SELF},`, `  ${SELF}`],
  'duplicate headers, all self': [`To: ${SELF}`, `To: ${SELF}`],
  'resent-to self': [`To: ${SELF}`, `Resent-To: ${SELF}`, 'Resent-Date: Mon, 1 Jan 2026 00:00:00 +0000'],
  'reply-to self': [`To: ${SELF}`, `Reply-To: ${SELF}`],
};

const REFUSED: Record<string, { headers: string[]; reason: GuardReason }> = {
  // An unquoted "@" in a display name is refused outright: a lenient reader might take it as an address.
  'display-name spoofing: self@x <other@y>': { headers: [`To: ${SELF} <${OTHER}>`], reason: 'send-unparseable' },
  'quoted spoof: "self@x" <other@y>': { headers: [`To: "${SELF}" <${OTHER}>`], reason: 'send-recipients' },
  'other only': { headers: [`To: ${OTHER}`], reason: 'send-recipients' },
  'self and other in one header': { headers: [`To: ${SELF}, ${OTHER}`], reason: 'send-recipients' },
  'cc other': { headers: [`To: ${SELF}`, `Cc: ${OTHER}`], reason: 'send-recipients' },
  'bcc other only': { headers: [`Bcc: ${OTHER}`], reason: 'send-recipients' },
  'bcc other beside to self': { headers: [`To: ${SELF}`, `Bcc: ${OTHER}`], reason: 'send-recipients' },
  'reply-to other': { headers: [`To: ${SELF}`, `Reply-To: ${OTHER}`], reason: 'send-recipients' },
  'resent-to other': { headers: [`To: ${SELF}`, `Resent-To: ${OTHER}`], reason: 'send-recipients' },
  'resent-cc other': { headers: [`To: ${SELF}`, `Resent-Cc: ${OTHER}`], reason: 'send-recipients' },
  'resent-bcc other': { headers: [`To: ${SELF}`, `Resent-Bcc: ${OTHER}`], reason: 'send-recipients' },
  'envelope-style header': { headers: [`To: ${SELF}`, `X-Envelope-To: ${OTHER}`], reason: 'send-recipients' },
  'duplicate To, second is other': { headers: [`To: ${SELF}`, `To: ${OTHER}`], reason: 'send-recipients' },
  'header name with space before colon': { headers: [`To: ${SELF}`, `Cc : ${OTHER}`], reason: 'send-recipients' },
  'mixed-case header name': { headers: [`To: ${SELF}`, `bCC: ${OTHER}`], reason: 'send-recipients' },
  'folded second address': { headers: [`To: ${SELF},`, `\t${OTHER}`], reason: 'send-recipients' },
  'group of other': { headers: [`To: Friends: ${OTHER};`], reason: 'send-recipients' },
  'group with self and other': { headers: [`To: Team: ${SELF}, ${OTHER};`], reason: 'send-recipients' },
  'plus address is not self': { headers: [`To: self+tag@example.test`], reason: 'send-recipients' },
  'look-alike domain': { headers: [`To: self@example.test.evil.test`], reason: 'send-recipients' },
  'no recipients at all': { headers: ['Subject: nobody'], reason: 'send-recipients' },
  'empty To': { headers: ['To:'], reason: 'send-recipients' },
  'only an empty group': { headers: ['To: undisclosed-recipients:;'], reason: 'send-recipients' },
  'encoded word as the address': { headers: [`To: =?utf-8?q?self=40example.test?=`], reason: 'send-unparseable' },
  'encoded word hiding the local part': { headers: [`To: =?utf-8?q?other?=@example.test`], reason: 'send-unparseable' },
  'two bare addresses without a comma': { headers: [`To: ${SELF} ${OTHER}`], reason: 'send-unparseable' },
  'semicolon as separator': { headers: [`To: ${SELF}; ${OTHER}`], reason: 'send-unparseable' },
  'unterminated quote': { headers: [`To: "${SELF}`], reason: 'send-unparseable' },
  'unterminated comment': { headers: [`To: ${SELF} (oops`], reason: 'send-unparseable' },
  'unterminated group': { headers: [`To: Team: ${SELF}`], reason: 'send-unparseable' },
  'two angle addresses': { headers: [`To: <${SELF}> <${OTHER}>`], reason: 'send-unparseable' },
  'source route': { headers: [`To: <@relay.test:${SELF}>`], reason: 'send-unparseable' },
  'domain literal': { headers: [`To: self@[192.0.2.1]`], reason: 'send-unparseable' },
  'quoted local part': { headers: [`To: "self"@example.test`], reason: 'send-unparseable' },
  'header line without a colon': { headers: [`To: ${SELF}`, 'garbage line'], reason: 'send-unparseable' },
  'mbox From line': { headers: ['From self@example.test Mon Jan  1 00:00:00 2026', `To: ${SELF}`], reason: 'send-unparseable' },
  'whitespace-only line inside the headers': { headers: [`To: ${SELF}`, '  ', `Cc: ${OTHER}`], reason: 'send-unparseable' },
  'header block starts with a fold': { headers: [` To: ${SELF}`], reason: 'send-unparseable' },
};

test('S-self allows sends whose every recipient is exactly the account itself', async () => {
  for (const [name, headers] of Object.entries(ALLOWED)) {
    const { guard, calls } = guardFor('S-self');
    const [url, init] = sendJson(message(headers));
    await guard(url, init);
    assert.equal(calls.length, 1, name);
    assert.deepEqual(guard.requests(), [{ method: 'gmail.users.messages.send', httpMethod: 'POST', count: 1 }], name);
  }
});

test('S-self refuses every message that reaches, or might reach, anyone else', async () => {
  for (const [name, { headers, reason }] of Object.entries(REFUSED)) {
    const { guard, calls } = guardFor('S-self');
    const [url, init] = sendJson(message(headers));
    const error = await refusal(guard, url, init);
    assert.equal(error.reason, reason, name);
    assert.equal(calls.length, 0, name);
  }
});

test('raw values that are not a message are refused', async () => {
  for (const raw of ['', 'not base64 !!', '@@@@', b64(`To: ${SELF}\rCc: ${OTHER}\r\n\r\nx`), b64(`To: ${SELF}\0\r\n\r\nx`)]) {
    await assertRefused('S-self', 'send-unparseable', ...sendJson(raw));
  }
  // A blank first line means there are no headers, so there is nobody to send to.
  await assertRefused('S-self', 'send-recipients', ...sendJson(b64(`\r\n\r\nTo: ${SELF}`)));
  await assertRefused('S-self', 'body-unparseable', `${GMAIL}/messages/send`, { method: 'POST', body: 'not json' });
  await assertRefused('S-self', 'send-unparseable', `${GMAIL}/messages/send`, json({ threadId: 'abc' }));
  await assertRefused('S-self', 'body-unparseable', `${GMAIL}/messages/send`, { method: 'POST', body: new ReadableStream() as never });
});

test('headers are read from the outer message only: an attached message/rfc822 with other recipients is not confused', async () => {
  const attached = [
    `To: ${SELF}`, 'Subject: forwarded', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B1"', '',
    '--B1', 'Content-Type: text/plain', '', `The body even says To: ${OTHER}`, '',
    '--B1', 'Content-Type: message/rfc822', '',
    `From: someone@example.test`, `To: ${OTHER}`, `Cc: third@example.test`, `Bcc: ${OTHER}`, 'Subject: inner', '', 'inner body',
    '--B1--',
  ].join('\r\n');
  const { guard, calls } = guardFor('S-self');
  await guard(...sendJson(b64(attached)));
  assert.equal(calls.length, 1);

  // And the same attachment cannot rescue an outer message that is addressed to someone else.
  await assertRefused('S-self', 'send-recipients', ...sendJson(b64(attached.replace(`To: ${SELF}`, `To: ${OTHER}`))));
});

test('the content type must match the parser the guard used', async () => {
  const raw = message([`To: ${SELF}`]);
  await assertRefused('S-self', 'body-unparseable', `${GMAIL}/messages/send`, { method: 'POST', headers: { 'content-type': 'message/rfc822' }, body: JSON.stringify({ raw }) });
  await assertRefused('S-self', 'body-unparseable', `${UPLOAD}/messages/send?uploadType=media`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `To: ${SELF}\r\n\r\nx` });
  await assertRefused('M', 'body-unparseable', `${CAL}/calendars/primary/events?sendUpdates=none`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
});

test('LF-only line endings are read the same way', async () => {
  const { guard } = guardFor('S-self');
  await guard(...sendJson(b64(`To: ${SELF}\nSubject: x\n\nTo: ${OTHER}\n`)));
  await assertRefused('S-self', 'send-recipients', ...sendJson(b64(`To: ${SELF}\nCc: ${OTHER}\n\nbody\n`)));
});

test('the upload send path applies the same recipient rules, and only uploadType=media', async () => {
  // A media upload must say it is a plain RFC 822 message; the body is not judged under another label.
  const rfc = { 'content-type': 'message/rfc822' };
  const good = `To: ${SELF}\r\nSubject: x\r\n\r\nhello`;
  const { guard, calls } = guardFor('S-self');
  await guard(`${UPLOAD}/messages/send?uploadType=media`, { method: 'POST', headers: rfc, body: good });
  await guard(`${UPLOAD}/messages/send?uploadType=media`, { method: 'POST', headers: rfc, body: Buffer.from(good) });
  assert.equal(calls.length, 2);
  const bad = `To: ${SELF}\r\nBcc: ${OTHER}\r\n\r\nhello`;
  await assertRefused('S-self', 'send-recipients', `${UPLOAD}/messages/send?uploadType=media`, { method: 'POST', headers: rfc, body: bad });
  await assertRefused('S-self', 'send-recipients', `${UPLOAD}/messages/send?uploadType=media`, { method: 'POST', headers: rfc, body: new Blob([bad]) });
  await assertRefused('S-self', 'send-recipients', `${UPLOAD}/messages/send?uploadType=media`, { method: 'POST', headers: rfc, body: '' });
  await assertRefused('S-self', 'send-upload-type', `${UPLOAD}/messages/send?uploadType=multipart`, { method: 'POST', body: good });
  await assertRefused('S-self', 'send-upload-type', `${UPLOAD}/messages/send?uploadType=resumable`, { method: 'POST', body: good });
  await assertRefused('S-self', 'send-upload-type', `${UPLOAD}/messages/send`, { method: 'POST', body: good });
  await assertRefused('S-self', 'unknown-endpoint', `${UPLOAD}/messages?uploadType=media`, { method: 'POST', body: good });
});

test('drafts can be sent only if this guard saw them created or updated with self as the only recipient', async () => {
  let counter = 0;
  const net = network((url, method) => (method === 'POST' && url.endsWith('/drafts') ? { id: `d${++counter}` } : {}));
  const guard = createGuardedFetch(net.fetchImpl, { tier: 'S-self', selfAddress: SELF });
  const draft = (headers: string[]): RequestInit => json({ message: { raw: message(headers) } });
  const refusedWith = async (reason: GuardReason, url: string, init: RequestInit): Promise<void> => {
    await assert.rejects(guard(url, init), (e: unknown) => e instanceof GuardRefusal && e.reason === reason);
  };

  await guard(`${GMAIL}/drafts`, draft([`To: ${OTHER}`])); // d1, other
  await guard(`${GMAIL}/drafts`, draft([`To: ${SELF}`])); // d2, self
  await guard(`${GMAIL}/drafts`, draft([`To: ${SELF}`])); // d3, self
  await refusedWith('draft-not-verified-self', `${GMAIL}/drafts/send`, json({ id: 'd1' }));
  await refusedWith('draft-not-verified-self', `${GMAIL}/drafts/send`, json({ id: 'never-seen' }));
  await refusedWith('draft-not-verified-self', `${GMAIL}/drafts/send`, json({}));
  // A message attached to the send must be self-only too.
  await refusedWith('send-recipients', `${GMAIL}/drafts/send`, json({ id: 'd2', message: { raw: message([`To: ${OTHER}`]) } }));

  // Updating a draft to another recipient makes it unsendable; updating it back to self restores it.
  await guard(`${GMAIL}/drafts/d3`, { ...draft([`To: ${OTHER}`]), method: 'PUT' });
  await refusedWith('draft-not-verified-self', `${GMAIL}/drafts/send`, json({ id: 'd3' }));
  await guard(`${GMAIL}/drafts/d3`, { ...draft([`To: ${SELF}`]), method: 'PUT' });

  await guard(`${GMAIL}/drafts/send`, json({ id: 'd2' }));
  await guard(`${GMAIL}/drafts/send`, json({ id: 'd3' }));
  await refusedWith('draft-not-verified-self', `${GMAIL}/drafts/send`, json({ id: 'd2' })); // already sent
  // A draft is never deleted.
  await refusedWith('permanent-delete', `${GMAIL}/drafts/d2`, { method: 'DELETE' });
});

test('calendar writes are refused by default in every tier (agent test account rules)', async () => {
  for (const tier of ['M', 'S-self'] as const) {
    const net = network();
    const guard = createGuardedFetch(net.fetchImpl, { tier, selfAddress: SELF });
    await assert.rejects(
      guard(`${CAL}/calendars/primary/events?sendUpdates=none`, json({ summary: 'Test event', start: {}, end: {} })),
      { reason: 'calendar-write-not-allowed' },
    );
    assert.equal(net.calls.length, 0, `${tier}: nothing reached the network`);
  }
});

test('calendar (orchestrator 2026-10-28): run-scoped events only, tagged with the run id, no guests, no other fields', async () => {
  const q = '?sendUpdates=none';
  const tag = { extendedProperties: { private: { aplosLiveRun: 'run-test' } } };
  const meet = { conferenceData: { createRequest: { requestId: 'req-1', conferenceSolutionKey: { type: 'hangoutsMeet' } } } };
  // Insert: the tag is required and must be this run's; only the allowed fields; a new Meet room is fine.
  await assertRefused('M', 'calendar-run-id', `${CAL}/calendars/primary/events${q}`, json({ summary: 'x' }));
  await assertRefused('M', 'calendar-run-id', `${CAL}/calendars/primary/events${q}`, json({ summary: 'x', extendedProperties: { private: { aplosLiveRun: 'other-run' } } }));
  await assertRefused('M', 'calendar-run-id', `${CAL}/calendars/primary/events${q}`, json({ summary: 'x', extendedProperties: { private: { aplosLiveRun: 'run-test', extra: '1' } } }));
  await assertRefused('M', 'calendar-run-id', `${CAL}/calendars/primary/events${q}`, json({ summary: 'x', extendedProperties: { shared: { aplosLiveRun: 'run-test' } } }));
  await assertRefused('M', 'calendar-field', `${CAL}/calendars/primary/events${q}`, json({ summary: 'x', location: 'y', ...tag }));
  await assertRefused('M', 'calendar-field', `${CAL}/calendars/primary/events${q}`, json({ summary: 'x', guestsCanModify: true, ...tag }));
  await assertRefused('M', 'calendar-field', `${CAL}/calendars/primary/events${q}`, json({ summary: 'x', ...tag, conferenceData: { conferenceId: 'abc', entryPoints: [] } }));
  const { guard, calls } = guardFor('M', (_url, method) => (method === 'POST' ? { id: 'e1', ...tag } : {}));
  await guard(`${CAL}/calendars/primary/events${q}&conferenceDataVersion=1`, json({ summary: 'Run event', start: {}, end: {}, ...tag, ...meet }));
  // Patch: rename, re-time and re-describe only; never the tag or the room.
  await guard(`${CAL}/calendars/primary/events/e1${q}`, json({ summary: 'Renamed', description: 'd', start: {}, end: {} }, 'PATCH'));
  await assert.rejects(guard(`${CAL}/calendars/primary/events/e1${q}`, json({ extendedProperties: { private: { aplosLiveRun: 'x' } } }, 'PATCH')), { reason: 'calendar-field' });
  await assert.rejects(guard(`${CAL}/calendars/primary/events/e1${q}`, json({ ...meet }, 'PATCH')), { reason: 'calendar-field' });
  await assert.rejects(guard(`${CAL}/calendars/primary/events/e1${q}`, json({ colorId: '5' }, 'PATCH')), { reason: 'calendar-field' });
  await guard(`${CAL}/calendars/primary/events/e1${q}`, { method: 'DELETE' });
  assert.equal(calls.length, 3);
  // An insert the server answers without this run's tag is never adopted.
  const untagged = guardFor('M', (_url, method) => (method === 'POST' ? { id: 'e2' } : {}));
  await untagged.guard(`${CAL}/calendars/primary/events${q}`, json({ summary: 'x', ...tag }));
  await assert.rejects(untagged.guard(`${CAL}/calendars/primary/events/e2${q}`, { method: 'DELETE' }), { reason: 'calendar-event-not-created-by-run' });
  // No run id, or another tier: no calendar writes at all, deletes included.
  for (const [tier, runId] of [['M', undefined], ['S-self', 'run-test'], ['R', 'run-test']] as const) {
    const net = network();
    const g = createGuardedFetch(net.fetchImpl, { tier, selfAddress: SELF, ...(runId ? { calendarRunId: runId } : {}) });
    await assert.rejects(g(`${CAL}/calendars/primary/events${q}`, json({ summary: 'x', ...tag })), (error: { reason: string }) => ['calendar-write-not-allowed', 'tier-r-read-only'].includes(error.reason));
    await assert.rejects(g(`${CAL}/calendars/primary/events/e1${q}`, { method: 'DELETE' }), (error: { reason: string }) => ['calendar-write-not-allowed', 'tier-r-read-only', 'calendar-event-not-created-by-run'].includes(error.reason));
    assert.equal(net.calls.length, 0, `${tier}: nothing reached the network`);
  }
});
