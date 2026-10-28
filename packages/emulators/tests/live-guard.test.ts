import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGuardedFetch,
  GuardRefusal,
  readOnlyViolations,
  type GuardReason,
} from '../../../apps/desktop/scripts/live/guard';
import {
  assertRefused,
  b64,
  CAL,
  GMAIL,
  guardFor,
  json,
  message,
  network,
  OTHER,
  refusal,
  SELF,
  UPLOAD,
} from './live-guard-helpers';

/** The origin, shape, tier and run-scoped rules of the guard, and the S-self send rules. */

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
  for (const tier of ['R', 'M', 'S-self'] as const)
    for (const url of bad) await assertRefused(tier, 'origin-not-allowed', url);
  await assertRefused('R', 'unsupported-request', 'not a url');
  await assertRefused('R', 'unsupported-request', '/relative/path');
});

test('a Request object is refused because its body cannot be checked unread', async () => {
  const { guard, calls } = guardFor('M');
  await assert.rejects(
    guard(new Request(`${GMAIL}/profile`) as never),
    (error: unknown) => error instanceof GuardRefusal && error.reason === 'unsupported-request',
  );
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
    assert.ok(
      ['tier-r-read-only', 'unsupported-request'].includes(error.reason),
      `${method} ${url} -> ${error.reason}`,
    );
    assert.equal(calls.length, 0);
  }
  const { guard, calls } = guardFor('R');
  await guard(`${GMAIL}/profile`);
  await guard(`${GMAIL}/threads?labelIds=INBOX`);
  await guard('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'rt-fake',
      client_id: 'client-fake',
    }),
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(readOnlyViolations(guard.requests()), []);
});

test('readOnlyViolations flags a write in a request log', () => {
  assert.equal(
    readOnlyViolations([{ method: 'gmail.users.messages.modify', httpMethod: 'POST', count: 1 }])
      .length,
    1,
  );
  assert.equal(
    readOnlyViolations([{ method: 'oauth.token', httpMethod: 'POST', count: 2 }]).length,
    0,
  );
});

test('requests are recorded by API method name and verb, never by URL, and sent with redirects off', async () => {
  const { guard, calls } = guardFor('R');
  await guard(`${GMAIL}/threads/aaa?format=metadata`);
  await guard(`${GMAIL}/threads/bbb?format=metadata`);
  await guard(`${GMAIL}/labels`);
  assert.deepEqual(
    guard.requests().sort((a, b) => a.method.localeCompare(b.method)),
    [
      { method: 'gmail.users.labels.list', httpMethod: 'GET', count: 1 },
      { method: 'gmail.users.threads.get', httpMethod: 'GET', count: 2 },
    ],
  );
  assert.ok(
    calls.every(call => call.redirect === 'error'),
    'a redirect could leave the allowed hosts',
  );
});

test('verb overrides cannot turn a POST into a delete', async () => {
  await assertRefused('M', 'method-override', `${GMAIL}/messages/abc/modify`, {
    method: 'POST',
    headers: { 'X-HTTP-Method-Override': 'DELETE' },
    body: '{}',
  });
  await assertRefused('M', 'method-override', `${GMAIL}/messages/abc/modify?$httpMethod=DELETE`, {
    method: 'POST',
    body: '{}',
  });
  await assertRefused('R', 'method-override', `${GMAIL}/profile`, {
    headers: { 'x-http-method': 'DELETE' },
  });
});

test('paths: encoded slashes, double slashes, custom verbs and unknown endpoints are refused', async () => {
  await assertRefused('M', 'url-not-canonical', `${GMAIL}/messages/abc%2Fmodify`, json({}));
  await assertRefused('M', 'url-not-canonical', `${GMAIL}//messages/abc`);
  await assertRefused('M', 'unknown-endpoint', `${GMAIL}/messages/abc%3AbatchDelete`, json({}));
  await assertRefused('M', 'unknown-endpoint', `${GMAIL}/messages/abc:batchDelete`, json({}));
  await assertRefused(
    'M',
    'unknown-endpoint',
    'https://gmail.googleapis.com/gmail/v1/users/someone@example.test/messages',
  );
  await assertRefused(
    'M',
    'unknown-endpoint',
    'https://www.googleapis.com/gmail/v1/users/me/messages',
  );
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
  for (const tier of ['M', 'S-self'] as const)
    for (const [url, init] of cases) await assertRefused(tier, 'permanent-delete', url, init);
});

test('settings writes are refused except filter create and delete', async () => {
  const writes: [string, string][] = [
    ['POST', 'settings/sendAs'],
    ['PATCH', 'settings/sendAs/x@example.test'],
    ['DELETE', 'settings/sendAs/x'],
    ['POST', 'settings/forwardingAddresses'],
    ['PUT', 'settings/autoForwarding'],
    ['POST', 'settings/delegates'],
    ['PUT', 'settings/imap'],
    ['PUT', 'settings/pop'],
    ['PUT', 'settings/vacation'],
    ['PUT', 'settings/language'],
    ['POST', 'settings/cse/identities'],
    ['PATCH', 'settings/labels'],
  ];
  for (const tier of ['M', 'S-self'] as const) {
    for (const [method, tail] of writes)
      await assertRefused(tier, 'settings-write', `${GMAIL}/${tail}`, json({}, method));
  }
});

test("filters: creation is allowed without forwarding, and only this run's filters can be deleted", async () => {
  const net = network((url, method) =>
    method === 'POST' && url.endsWith('/settings/filters') ? { id: 'filter-1' } : {},
  );
  const run = new Set<string>();
  const guard = createGuardedFetch(net.fetchImpl, { tier: 'M', allowRunFilterIds: run });

  await assert.rejects(
    guard(`${GMAIL}/settings/filters/filter-1`, { method: 'DELETE' }),
    (e: unknown) => e instanceof GuardRefusal && e.reason === 'filter-not-created-by-run',
  );
  await assert.rejects(
    guard(
      `${GMAIL}/settings/filters`,
      json({ criteria: { from: 'a' }, action: { forward: OTHER } }),
    ),
    (e: unknown) => e instanceof GuardRefusal && e.reason === 'filter-forward',
  );
  assert.equal(net.calls.length, 0);

  await guard(
    `${GMAIL}/settings/filters`,
    json({ criteria: { from: 'a' }, action: { addLabelIds: ['STARRED'] } }),
  );
  assert.deepEqual([...guard.createdFilterIds], ['filter-1']);
  await assert.rejects(
    guard(`${GMAIL}/settings/filters/someone-elses`, { method: 'DELETE' }),
    (e: unknown) => e instanceof GuardRefusal && e.reason === 'filter-not-created-by-run',
  );
  await guard(`${GMAIL}/settings/filters/filter-1`, { method: 'DELETE' });
  assert.equal(guard.createdFilterIds.size, 0);
  assert.equal(net.calls.length, 2);

  // A caller can also hand the guard a set of ids it created in an earlier step.
  const preset = createGuardedFetch(net.fetchImpl, {
    tier: 'M',
    allowRunFilterIds: new Set(['mine']),
  });
  await preset(`${GMAIL}/settings/filters/mine`, { method: 'DELETE' });
});

test('labels: only labels this run created can be deleted', async () => {
  const net = network((url, method) =>
    method === 'POST' && url.endsWith('/labels') ? { id: 'Label_77', name: 'x' } : {},
  );
  const guard = createGuardedFetch(net.fetchImpl, { tier: 'M' });
  await assert.rejects(
    guard(`${GMAIL}/labels/Label_1`, { method: 'DELETE' }),
    (e: unknown) => e instanceof GuardRefusal && e.reason === 'label-not-created-by-run',
  );
  await assert.rejects(
    guard(`${GMAIL}/labels/INBOX`, { method: 'DELETE' }),
    (e: unknown) => e instanceof GuardRefusal && e.reason === 'label-not-created-by-run',
  );
  await guard(`${GMAIL}/labels`, json({ name: 'aplos-live-check' }));
  assert.ok(guard.createdLabelIds.has('Label_77'));
  await guard(`${GMAIL}/labels/Label_77`, { method: 'DELETE' });
  await assert.rejects(
    guard(`${GMAIL}/labels/Label_77`, { method: 'DELETE' }),
    (e: unknown) => e instanceof GuardRefusal && e.reason === 'label-not-created-by-run',
  );
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

test('batch requests are refused because a part could hide any of the above', async () => {
  await assertRefused('M', 'batch-unsupported', 'https://gmail.googleapis.com/batch/gmail/v1', {
    method: 'POST',
    body: '--b--',
  });
  await assertRefused(
    'S-self',
    'batch-unsupported',
    'https://www.googleapis.com/batch/calendar/v3',
    { method: 'POST', body: '--b--' },
  );
});

test('the body that was checked is the body that is sent, even if the caller reuses its buffer', async () => {
  const { guard, calls } = guardFor('M');
  const body = Buffer.from(
    JSON.stringify({
      summary: 'safe',
      extendedProperties: { private: { aplosLiveRun: 'run-test' } },
    }),
  );
  await guard(`${CAL}/calendars/primary/events?sendUpdates=none`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  body.fill(0x58);
  assert.equal(
    Buffer.from(calls[0]!.body as Uint8Array).toString(),
    JSON.stringify({
      summary: 'safe',
      extendedProperties: { private: { aplosLiveRun: 'run-test' } },
    }),
  );
});

test('a refusal never contains the address, the URL or the id', async () => {
  const { guard } = guardFor('S-self');
  const url = `${GMAIL}/messages/send`;
  const error = await refusal(
    guard,
    url,
    json({ raw: message([`To: ${OTHER}`, 'Subject: Secret plans']) }),
  );
  assert.equal(error.reason, 'send-recipients');
  for (const secret of [OTHER, SELF, 'Secret plans', 'googleapis', 'messages/send'])
    assert.ok(!error.message.includes(secret), `message leaked ${secret}`);
  assert.deepEqual(guard.refusals(), { 'send-recipients': 1 });
});

test('S-self needs an address; selfAddress must be a plain mailbox', () => {
  assert.throws(() => createGuardedFetch(network().fetchImpl, { tier: 'S-self' }));
  assert.throws(() =>
    createGuardedFetch(network().fetchImpl, { tier: 'S-self', selfAddress: 'Name <a@b.test>' }),
  );
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
  await assertRefused('M', 'send-tier', `${UPLOAD}/messages/send?uploadType=media`, {
    method: 'POST',
    body: `To: ${SELF}\r\n\r\nhi`,
  });
  await assertRefused('M', 'send-tier', `${GMAIL}/drafts/send`, json({ id: 'd1' }));
});

const ALLOWED: Record<string, string[]> = {
  'plain to self': [`To: ${SELF}`],
  'upper case and display name': [`To: Me <SELF@Example.Test>`],
  'to, cc and bcc all self': [`To: ${SELF}`, `Cc: ${SELF}`, `Bcc: ${SELF}`],
  'bcc only, self': [`Bcc: ${SELF}`],
  'quoted plain display name': [`To: "Self Test" <${SELF}>`],
  'folded header': [`To: ${SELF},`, `  ${SELF}`],
  'duplicate headers, all self': [`To: ${SELF}`, `To: ${SELF}`],
  'resent-to self': [
    `To: ${SELF}`,
    `Resent-To: ${SELF}`,
    'Resent-Date: Mon, 1 Jan 2026 00:00:00 +0000',
  ],
  'reply-to self': [`To: ${SELF}`, `Reply-To: ${SELF}`],
};

const REFUSED: Record<string, { headers: string[]; reason: GuardReason }> = {
  // An unquoted "@" in a display name is refused outright: a lenient reader might take it as an address.
  'display-name spoofing: self@x <other@y>': {
    headers: [`To: ${SELF} <${OTHER}>`],
    reason: 'send-unparseable',
  },
  'quoted spoof: "self@x" <other@y>': {
    headers: [`To: "${SELF}" <${OTHER}>`],
    reason: 'send-unparseable',
  },
  // Only `addr` and `Name <addr>` with a plain-word name: Gmail may read anything else differently.
  'group of self': { headers: [`To: Me: ${SELF};`], reason: 'send-unparseable' },
  'empty group plus self': {
    headers: [`To: undisclosed-recipients:;, ${SELF}`],
    reason: 'send-unparseable',
  },
  'quoted display name that looks like another address': {
    headers: [`To: "${OTHER}" <${SELF}>`],
    reason: 'send-unparseable',
  },
  'encoded-word display name that decodes to another address': {
    headers: [`To: =?utf-8?q?other=40example.test?= <${SELF}>`],
    reason: 'send-unparseable',
  },
  'comment that looks like another address': {
    headers: [`To: ${SELF} (${OTHER})`],
    reason: 'send-unparseable',
  },
  'other only': { headers: [`To: ${OTHER}`], reason: 'send-recipients' },
  'self and other in one header': { headers: [`To: ${SELF}, ${OTHER}`], reason: 'send-recipients' },
  'cc other': { headers: [`To: ${SELF}`, `Cc: ${OTHER}`], reason: 'send-recipients' },
  'bcc other only': { headers: [`Bcc: ${OTHER}`], reason: 'send-recipients' },
  'bcc other beside to self': {
    headers: [`To: ${SELF}`, `Bcc: ${OTHER}`],
    reason: 'send-recipients',
  },
  'reply-to other': { headers: [`To: ${SELF}`, `Reply-To: ${OTHER}`], reason: 'send-recipients' },
  'resent-to other': { headers: [`To: ${SELF}`, `Resent-To: ${OTHER}`], reason: 'send-recipients' },
  'resent-cc other': { headers: [`To: ${SELF}`, `Resent-Cc: ${OTHER}`], reason: 'send-recipients' },
  'resent-bcc other': {
    headers: [`To: ${SELF}`, `Resent-Bcc: ${OTHER}`],
    reason: 'send-recipients',
  },
  'envelope-style header': {
    headers: [`To: ${SELF}`, `X-Envelope-To: ${OTHER}`],
    reason: 'send-recipients',
  },
  'duplicate To, second is other': {
    headers: [`To: ${SELF}`, `To: ${OTHER}`],
    reason: 'send-recipients',
  },
  'header name with space before colon': {
    headers: [`To: ${SELF}`, `Cc : ${OTHER}`],
    reason: 'send-recipients',
  },
  'mixed-case header name': {
    headers: [`To: ${SELF}`, `bCC: ${OTHER}`],
    reason: 'send-recipients',
  },
  'folded second address': { headers: [`To: ${SELF},`, `\t${OTHER}`], reason: 'send-recipients' },
  'group of other': { headers: [`To: Friends: ${OTHER};`], reason: 'send-unparseable' },
  'group with self and other': {
    headers: [`To: Team: ${SELF}, ${OTHER};`],
    reason: 'send-unparseable',
  },
  'plus address is not self': { headers: [`To: self+tag@example.test`], reason: 'send-recipients' },
  'look-alike domain': { headers: [`To: self@example.test.evil.test`], reason: 'send-recipients' },
  'no recipients at all': { headers: ['Subject: nobody'], reason: 'send-recipients' },
  'empty To': { headers: ['To:'], reason: 'send-recipients' },
  'only an empty group': { headers: ['To: undisclosed-recipients:;'], reason: 'send-unparseable' },
  'encoded word as the address': {
    headers: [`To: =?utf-8?q?self=40example.test?=`],
    reason: 'send-unparseable',
  },
  'encoded word hiding the local part': {
    headers: [`To: =?utf-8?q?other?=@example.test`],
    reason: 'send-unparseable',
  },
  'two bare addresses without a comma': {
    headers: [`To: ${SELF} ${OTHER}`],
    reason: 'send-unparseable',
  },
  'semicolon as separator': { headers: [`To: ${SELF}; ${OTHER}`], reason: 'send-unparseable' },
  'unterminated quote': { headers: [`To: "${SELF}`], reason: 'send-unparseable' },
  'unterminated comment': { headers: [`To: ${SELF} (oops`], reason: 'send-unparseable' },
  'unterminated group': { headers: [`To: Team: ${SELF}`], reason: 'send-unparseable' },
  'two angle addresses': { headers: [`To: <${SELF}> <${OTHER}>`], reason: 'send-unparseable' },
  'source route': { headers: [`To: <@relay.test:${SELF}>`], reason: 'send-unparseable' },
  'domain literal': { headers: [`To: self@[192.0.2.1]`], reason: 'send-unparseable' },
  'quoted local part': { headers: [`To: "self"@example.test`], reason: 'send-unparseable' },
  'header line without a colon': {
    headers: [`To: ${SELF}`, 'garbage line'],
    reason: 'send-unparseable',
  },
  'mbox From line': {
    headers: ['From self@example.test Mon Jan  1 00:00:00 2026', `To: ${SELF}`],
    reason: 'send-unparseable',
  },
  'whitespace-only line inside the headers': {
    headers: [`To: ${SELF}`, '  ', `Cc: ${OTHER}`],
    reason: 'send-unparseable',
  },
  'header block starts with a fold': { headers: [` To: ${SELF}`], reason: 'send-unparseable' },
};

test('S-self allows sends whose every recipient is exactly the account itself', async () => {
  for (const [name, headers] of Object.entries(ALLOWED)) {
    const { guard, calls } = guardFor('S-self');
    const [url, init] = sendJson(message(headers));
    await guard(url, init);
    assert.equal(calls.length, 1, name);
    assert.deepEqual(
      guard.requests(),
      [{ method: 'gmail.users.messages.send', httpMethod: 'POST', count: 1 }],
      name,
    );
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
  for (const raw of [
    '',
    'not base64 !!',
    '@@@@',
    b64(`To: ${SELF}\rCc: ${OTHER}\r\n\r\nx`),
    b64(`To: ${SELF}\0\r\n\r\nx`),
  ]) {
    await assertRefused('S-self', 'send-unparseable', ...sendJson(raw));
  }
  // A blank first line means there are no headers, so there is nobody to send to.
  await assertRefused('S-self', 'send-recipients', ...sendJson(b64(`\r\n\r\nTo: ${SELF}`)));
  await assertRefused('S-self', 'body-unparseable', `${GMAIL}/messages/send`, {
    method: 'POST',
    body: 'not json',
  });
  await assertRefused(
    'S-self',
    'send-unparseable',
    `${GMAIL}/messages/send`,
    json({ threadId: 'abc' }),
  );
  await assertRefused('S-self', 'body-unparseable', `${GMAIL}/messages/send`, {
    method: 'POST',
    body: new ReadableStream() as never,
  });
});

test('headers are read from the outer message only: an attached message/rfc822 with other recipients is not confused', async () => {
  const attached = [
    `To: ${SELF}`,
    'Subject: forwarded',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="B1"',
    '',
    '--B1',
    'Content-Type: text/plain',
    '',
    `The body even says To: ${OTHER}`,
    '',
    '--B1',
    'Content-Type: message/rfc822',
    '',
    `From: someone@example.test`,
    `To: ${OTHER}`,
    `Cc: third@example.test`,
    `Bcc: ${OTHER}`,
    'Subject: inner',
    '',
    'inner body',
    '--B1--',
  ].join('\r\n');
  const { guard, calls } = guardFor('S-self');
  await guard(...sendJson(b64(attached)));
  assert.equal(calls.length, 1);

  // And the same attachment cannot rescue an outer message that is addressed to someone else.
  await assertRefused(
    'S-self',
    'send-recipients',
    ...sendJson(b64(attached.replace(`To: ${SELF}`, `To: ${OTHER}`))),
  );
});

test('the content type must match the parser the guard used', async () => {
  const raw = message([`To: ${SELF}`]);
  await assertRefused('S-self', 'body-unparseable', `${GMAIL}/messages/send`, {
    method: 'POST',
    headers: { 'content-type': 'message/rfc822' },
    body: JSON.stringify({ raw }),
  });
  await assertRefused('S-self', 'body-unparseable', `${UPLOAD}/messages/send?uploadType=media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `To: ${SELF}\r\n\r\nx`,
  });
  await assertRefused('M', 'body-unparseable', `${CAL}/calendars/primary/events?sendUpdates=none`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  });
});

test('LF-only line endings are read the same way', async () => {
  const { guard } = guardFor('S-self');
  await guard(...sendJson(b64(`To: ${SELF}\nSubject: x\n\nTo: ${OTHER}\n`)));
  await assertRefused(
    'S-self',
    'send-recipients',
    ...sendJson(b64(`To: ${SELF}\nCc: ${OTHER}\n\nbody\n`)),
  );
});

test('the upload send path applies the same recipient rules, and only uploadType=media', async () => {
  // A media upload must say it is a plain RFC 822 message; the body is not judged under another label.
  const rfc = { 'content-type': 'message/rfc822' };
  const good = `To: ${SELF}\r\nSubject: x\r\n\r\nhello`;
  const { guard, calls } = guardFor('S-self');
  await guard(`${UPLOAD}/messages/send?uploadType=media`, {
    method: 'POST',
    headers: rfc,
    body: good,
  });
  await guard(`${UPLOAD}/messages/send?uploadType=media`, {
    method: 'POST',
    headers: rfc,
    body: Buffer.from(good),
  });
  assert.equal(calls.length, 2);
  const bad = `To: ${SELF}\r\nBcc: ${OTHER}\r\n\r\nhello`;
  await assertRefused('S-self', 'send-recipients', `${UPLOAD}/messages/send?uploadType=media`, {
    method: 'POST',
    headers: rfc,
    body: bad,
  });
  await assertRefused('S-self', 'send-recipients', `${UPLOAD}/messages/send?uploadType=media`, {
    method: 'POST',
    headers: rfc,
    body: new Blob([bad]),
  });
  await assertRefused('S-self', 'send-recipients', `${UPLOAD}/messages/send?uploadType=media`, {
    method: 'POST',
    headers: rfc,
    body: '',
  });
  await assertRefused(
    'S-self',
    'send-upload-type',
    `${UPLOAD}/messages/send?uploadType=multipart`,
    { method: 'POST', body: good },
  );
  await assertRefused(
    'S-self',
    'send-upload-type',
    `${UPLOAD}/messages/send?uploadType=resumable`,
    { method: 'POST', body: good },
  );
  await assertRefused('S-self', 'send-upload-type', `${UPLOAD}/messages/send`, {
    method: 'POST',
    body: good,
  });
  await assertRefused('S-self', 'unknown-endpoint', `${UPLOAD}/messages?uploadType=media`, {
    method: 'POST',
    body: good,
  });
});

test('drafts can be sent only if this guard saw them created or updated with self as the only recipient', async () => {
  let counter = 0;
  const net = network((url, method) =>
    method === 'POST' && url.endsWith('/drafts') ? { id: `d${++counter}` } : {},
  );
  const guard = createGuardedFetch(net.fetchImpl, { tier: 'S-self', selfAddress: SELF });
  const draft = (headers: string[]): RequestInit => json({ message: { raw: message(headers) } });
  const refusedWith = async (
    reason: GuardReason,
    url: string,
    init: RequestInit,
  ): Promise<void> => {
    await assert.rejects(
      guard(url, init),
      (e: unknown) => e instanceof GuardRefusal && e.reason === reason,
    );
  };

  await guard(`${GMAIL}/drafts`, draft([`To: ${OTHER}`])); // d1, other
  await guard(`${GMAIL}/drafts`, draft([`To: ${SELF}`])); // d2, self
  await guard(`${GMAIL}/drafts`, draft([`To: ${SELF}`])); // d3, self
  await refusedWith('draft-not-verified-self', `${GMAIL}/drafts/send`, json({ id: 'd1' }));
  await refusedWith('draft-not-verified-self', `${GMAIL}/drafts/send`, json({ id: 'never-seen' }));
  await refusedWith('draft-not-verified-self', `${GMAIL}/drafts/send`, json({}));
  // A message attached to the send must be self-only too.
  await refusedWith(
    'send-recipients',
    `${GMAIL}/drafts/send`,
    json({ id: 'd2', message: { raw: message([`To: ${OTHER}`]) } }),
  );

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
