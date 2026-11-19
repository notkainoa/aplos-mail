import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuardedFetch, GuardRefusal } from '../../../apps/desktop/scripts/live/guard';
import {
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

/**
 * The gaps an independent security review of the guard proved (plans/STATUS.md 2026-10-28 08:05),
 * each turned into a request that must be refused. Every test here failed before its fix.
 */

const TOKEN = 'https://oauth2.googleapis.com/token';
const form = (fields: Record<string, string> | string, query = ''): [string, RequestInit] => [
  TOKEN + query,
  {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: typeof fields === 'string' ? fields : new URLSearchParams(fields).toString(),
  },
];
const REFRESH = { grant_type: 'refresh_token', refresh_token: 'rt-fake', client_id: 'client-fake' };

/** A guard whose network answers a draft create with the given id and records every request. */
function draftGuard(tier: 'M' | 'S-self', createdId: string) {
  return guardFor(tier, (url, method) =>
    method === 'POST' && url.endsWith('/drafts') ? { id: createdId } : { id: 'sent-1' },
  );
}

const selfDraft = (method = 'POST') => json({ message: { raw: message([`To: ${SELF}`]) } }, method);
const otherDraft = (method = 'POST') =>
  json({ message: { raw: message([`To: ${OTHER}`]) } }, method);
const mentionsOther = (body: unknown): boolean =>
  typeof body === 'string' &&
  Buffer.from((JSON.parse(body) as { message?: { raw?: string } }).message?.raw ?? '', 'base64')
    .toString('latin1')
    .includes(OTHER);

// ---------- (1) draft-id aliasing ----------

test('review 1: a leading-zero alias of a self-only draft cannot rewrite it before drafts.send', async () => {
  const { guard, calls } = draftGuard('S-self', 'r123');
  await guard(`${GMAIL}/drafts`, selfDraft());
  const error = await refusal(guard, `${GMAIL}/drafts/r0123`, otherDraft('PUT'));
  assert.equal(error.reason, 'draft-not-created-by-run');
  assert.ok(!calls.some(call => mentionsOther(call.body)), 'the other-recipient draft was sent');
  // The real draft is untouched and still self-only, so its send goes out unchanged.
  await guard(`${GMAIL}/drafts/send`, json({ id: 'r123' }));
  assert.deepEqual(
    calls.map(call => call.method),
    ['POST', 'POST'],
  );
});

test('review 1: an encoded alias (%2B) of a run draft is refused, whether or not it decodes to the id', async () => {
  const plain = draftGuard('S-self', 'r123');
  await plain.guard(`${GMAIL}/drafts`, selfDraft());
  assert.equal(
    (await refusal(plain.guard, `${GMAIL}/drafts/r%2B123`, otherDraft('PUT'))).reason,
    'draft-not-created-by-run',
  );
  const plus = draftGuard('S-self', 'r+123');
  await plus.guard(`${GMAIL}/drafts`, selfDraft());
  assert.equal(
    (await refusal(plus.guard, `${GMAIL}/drafts/r%2B123`, otherDraft('PUT'))).reason,
    'draft-not-created-by-run',
  );
  assert.equal(plain.calls.length + plus.calls.length, 2, 'only the two creates went out');
  // The exact id Gmail returned is still updatable.
  await plus.guard(`${GMAIL}/drafts/r+123`, selfDraft('PUT'));
  assert.equal(plus.calls.length, 2);
});

test('review 1: drafts.send names only an id Gmail returned to this guard, spelled exactly', async () => {
  const { guard, calls } = draftGuard('S-self', 'r123');
  await guard(`${GMAIL}/drafts`, selfDraft());
  for (const id of ['r0123', 'R123', 'r123 ', 'r%31%32%33'])
    assert.equal(
      (await refusal(guard, `${GMAIL}/drafts/send`, json({ id }))).reason,
      'draft-not-verified-self',
      id,
    );
  assert.equal(calls.length, 1);
});

test('review 1: an update body naming another draft id, or unknown draft keys, is refused', async () => {
  const { guard, calls } = draftGuard('S-self', 'r123');
  await guard(`${GMAIL}/drafts`, selfDraft());
  const raw = message([`To: ${SELF}`]);
  assert.equal(
    (await refusal(guard, `${GMAIL}/drafts/r123`, json({ id: 'r999', message: { raw } }, 'PUT')))
      .reason,
    'body-unparseable',
  );
  assert.equal(
    (await refusal(guard, `${GMAIL}/drafts/r123`, json({ message: { raw }, extra: 1 }, 'PUT')))
      .reason,
    'body-unparseable',
  );
  assert.equal(calls.length, 1);
});

// ---------- (4) only run-created drafts can be overwritten ----------

test('review 4: tier M cannot overwrite an existing draft this run did not create', async () => {
  const { guard, calls } = draftGuard('M', 'r1');
  const error = await refusal(guard, `${GMAIL}/drafts/r999`, otherDraft('PUT'));
  assert.equal(error.reason, 'draft-not-created-by-run');
  assert.equal(calls.length, 0);
  await guard(`${GMAIL}/drafts`, otherDraft());
  await guard(`${GMAIL}/drafts/r1`, otherDraft('PUT'));
  assert.equal(calls.length, 2, "the run's own draft may still be updated");
});

// ---------- (2) label-modify bodies take exact keys only ----------

test('review 2: snake_case or other unknown keys in a label-modify body are refused', async () => {
  const cases: [string, unknown][] = [
    [`${GMAIL}/messages/batchModify`, { ids: ['a'], add_label_ids: ['TRASH'] }],
    [`${GMAIL}/messages/a/modify`, { add_label_ids: ['SPAM'] }],
    [`${GMAIL}/messages/a/modify`, { addlabelids: ['TRASH'] }],
    [`${GMAIL}/threads/t/modify`, { ids: ['a'], addLabelIds: ['STARRED'] }],
    [`${GMAIL}/threads/t/modify`, { labelIds: ['TRASH'] }],
    [`${GMAIL}/messages/a/modify`, { removeLabelIds: 'INBOX' }],
  ];
  for (const [url, body] of cases) {
    const { guard, calls } = guardFor('M');
    const error = await refusal(guard, url, json(body));
    assert.equal(error.reason, 'body-unparseable', JSON.stringify(body));
    assert.equal(calls.length, 0);
  }
  const { guard, calls } = guardFor('M');
  await guard(
    `${GMAIL}/messages/batchModify`,
    json({ ids: ['a'], addLabelIds: ['STARRED'], removeLabelIds: ['INBOX'] }),
  );
  await guard(`${GMAIL}/threads/t/modify`, json({ addLabelIds: ['STARRED'] }));
  assert.equal(calls.length, 2);
});

// ---------- (3) filters: criteria plus label actions, never Trash or Spam ----------

test('review 3: a filter may only add or remove ordinary labels, with known criteria', async () => {
  const cases: [unknown, string][] = [
    [
      { criteria: { query: 'in:anywhere' }, action: { addLabelIds: ['TRASH'] } },
      'label-spam-trash',
    ],
    [{ criteria: { from: 'a' }, action: { addLabelIds: ['spam'] } }, 'label-spam-trash'],
    [{ criteria: { from: 'a' }, action: { removeLabelIds: ['SPAM'] } }, 'label-spam-trash'],
    [{ criteria: { from: 'a' }, action: { forward: OTHER } }, 'filter-forward'],
    [{ criteria: { from: 'a' }, action: { add_label_ids: ['TRASH'] } }, 'body-unparseable'],
    [{ criteria: { from: 'a' }, action: { addLabelIds: 'TRASH' } }, 'body-unparseable'],
    [{ criteria: { from: 'a' }, action: {}, id: 'x' }, 'body-unparseable'],
    [{ criteria: { from_address: 'a' }, action: { addLabelIds: ['L1'] } }, 'body-unparseable'],
    [{ criteria: 'from:a', action: { addLabelIds: ['L1'] } }, 'body-unparseable'],
    [{ action: { addLabelIds: ['L1'] } }, 'body-unparseable'],
  ];
  for (const [body, reason] of cases) {
    const { guard, calls } = guardFor('M');
    const error = await refusal(guard, `${GMAIL}/settings/filters`, json(body));
    assert.equal(error.reason, reason, JSON.stringify(body));
    assert.equal(calls.length, 0);
  }
  const { guard, calls } = guardFor('M');
  await guard(
    `${GMAIL}/settings/filters`,
    json({
      criteria: { from: 'a', query: 'x', hasAttachment: true },
      action: { addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] },
    }),
  );
  assert.equal(calls.length, 1);
});

// ---------- (5) explicit query keys on every write ----------

test('review 5: unknown or underscore query keys on writes are refused', async () => {
  const insert = { summary: 'x', extendedProperties: { private: { aplosLiveRun: 'run-test' } } };
  const raw = message([`To: ${SELF}`]);
  const cases: ['M' | 'S-self', string, RequestInit][] = [
    ['M', `${CAL}/calendars/primary/events?sendUpdates=none&send_updates=all`, json(insert)],
    ['M', `${CAL}/calendars/primary/events?sendUpdates=none&maxAttendees=5`, json(insert)],
    ['M', `${GMAIL}/labels?name=x`, json({ name: 'x' })],
    ['M', `${GMAIL}/messages/a/modify?x_y=1`, json({ addLabelIds: ['STARRED'] })],
    ['S-self', `${GMAIL}/drafts/send?id=r999`, json({ id: 'r1' })],
    ['S-self', `${GMAIL}/messages/send?raw=${message([`To: ${OTHER}`])}`, json({ raw })],
    ['S-self', `${UPLOAD}/messages/send?uploadType=media&raw=x`, { method: 'POST', body: '' }],
  ];
  for (const [tier, url, init] of cases) {
    const { guard, calls } = guardFor(tier);
    const error = await refusal(guard, url, init);
    assert.equal(error.reason, 'query-not-allowed', url);
    assert.equal(calls.length, 0);
  }
});

test('review 5: a patch of a run event cannot add send_notifications=true', async () => {
  const { guard, calls } = guardFor('M', (url, method) =>
    method === 'POST'
      ? { id: 'ev1', extendedProperties: { private: { aplosLiveRun: 'run-test' } } }
      : {},
  );
  await guard(
    `${CAL}/calendars/primary/events?sendUpdates=none&conferenceDataVersion=1`,
    json({ summary: 'x', extendedProperties: { private: { aplosLiveRun: 'run-test' } } }),
  );
  await guard(
    `${CAL}/calendars/primary/events/ev1?sendUpdates=none`,
    json({ summary: 'y' }, 'PATCH'),
  );
  const error = await refusal(
    guard,
    `${CAL}/calendars/primary/events/ev1?sendUpdates=none&send_notifications=true`,
    json({ summary: 'z' }, 'PATCH'),
  );
  assert.equal(error.reason, 'query-not-allowed');
  assert.equal(calls.length, 2);
});

// ---------- (6) no live internal state on the guarded fetch ----------

test('review 6: a probe cannot add ids to createdLabelIds to make an owner label deletable', async () => {
  const { guard, calls } = guardFor('M');
  try {
    (guard.createdLabelIds as Set<string>).add('Label_OWNER');
  } catch {
    // a frozen or read-only view is just as good
  }
  const error = await refusal(guard, `${GMAIL}/labels/Label_OWNER`, { method: 'DELETE' });
  assert.equal(error.reason, 'label-not-created-by-run');
  assert.equal(calls.length, 0);
});

test('review 6: the request log and refusal counters on the guarded fetch cannot be replaced', async () => {
  const { guard } = guardFor('M');
  await guard(`${GMAIL}/labels`);
  const target = guard as unknown as Record<string, unknown>;
  for (const name of ['requests', 'refusals', 'createdLabelIds', 'createdFilterIds']) {
    try {
      target[name] = () => [];
    } catch {
      // assignment to a frozen object throws in strict mode: that is the point
    }
  }
  assert.deepEqual(guard.requests(), [
    { method: 'gmail.users.labels.list', httpMethod: 'GET', count: 1 },
  ]);
  assert.equal(typeof guard.refusals, 'function');
  assert.ok(Object.isFrozen(guard));
});

test("review 6: the caller's filter-id set is copied, so changing it later allows no delete", async () => {
  const net = network((url, method) =>
    method === 'POST' && url.endsWith('/settings/filters') ? { id: 'filter-1' } : {},
  );
  const preset = new Set(['mine']);
  const guard = createGuardedFetch(net.fetchImpl, { tier: 'M', allowRunFilterIds: preset });
  preset.add('owner-filter');
  await assert.rejects(
    guard(`${GMAIL}/settings/filters/owner-filter`, { method: 'DELETE' }),
    (e: unknown) => e instanceof GuardRefusal && e.reason === 'filter-not-created-by-run',
  );
  await guard(`${GMAIL}/settings/filters/mine`, { method: 'DELETE' });
  assert.equal(net.calls.length, 1);
});

// ---------- (8) the token endpoint takes exactly a refresh ----------

test('review 8: tier R sends only a well-formed refresh_token body to /token', async () => {
  const cases: [string, RequestInit][] = [
    form('grant_type=x'),
    form({ ...REFRESH, grant_type: 'authorization_code' }),
    form({ ...REFRESH, scope: 'https://mail.google.com/' }),
    form({ grant_type: 'refresh_token', refresh_token: 'rt-fake' }),
    form(`${new URLSearchParams(REFRESH).toString()}&client_id=other`),
    form({ ...REFRESH, client_secret: '' }),
    form(REFRESH, '?scope=x'),
    [
      TOKEN,
      {
        method: 'POST',
        body: JSON.stringify(REFRESH),
        headers: { 'content-type': 'application/json' },
      },
    ],
    [TOKEN, { method: 'POST' }],
  ];
  for (const [url, init] of cases) {
    const { guard, calls } = guardFor('R');
    const error = await refusal(guard, url, init);
    assert.ok(
      ['token-body', 'query-not-allowed', 'body-unparseable'].includes(error.reason),
      `${String(init.body)}: ${error.reason}`,
    );
    assert.equal(calls.length, 0);
  }
  const { guard, calls } = guardFor('R');
  await guard(...form(REFRESH));
  await guard(...form({ ...REFRESH, client_secret: 'secret-fake' }));
  await guard(TOKEN, { method: 'POST', body: new URLSearchParams(REFRESH) });
  assert.equal(calls.length, 3);
});

test('review 8: the sign-in code exchange is allowed only on a guard built for it, with exact keys', async () => {
  const exchange = {
    grant_type: 'authorization_code',
    code: 'code-fake',
    client_id: 'client-fake',
    redirect_uri: 'http://127.0.0.1:5555/oauth/callback',
    code_verifier: 'verifier-fake',
  };
  const plain = guardFor('R');
  assert.equal((await refusal(plain.guard, ...form(exchange))).reason, 'token-body');
  const net = network();
  const signin = createGuardedFetch(net.fetchImpl, { tier: 'R', allowCodeExchange: true });
  await signin(...form(exchange));
  for (const bad of [
    { ...exchange, redirect_uri: 'https://example.test/oauth/callback' },
    { ...exchange, scope: 'x' },
  ])
    assert.equal((await refusal(signin, ...form(bad))).reason, 'token-body');
  assert.equal(net.calls.length, 1);
});

// ---------- follow-up: messages.send bodies take exact keys ----------

test('review follow-up: a messages.send body may carry only raw and threadId', async () => {
  const raw = message([`To: ${SELF}`]);
  for (const body of [
    { raw, labelIds: ['TRASH'] },
    { raw, threadId: 7 },
    { raw, payload: {} },
    { raw, Raw: raw },
  ]) {
    const { guard, calls } = guardFor('S-self');
    const error = await refusal(guard, `${GMAIL}/messages/send`, json(body));
    assert.equal(error.reason, 'body-unparseable', JSON.stringify(Object.keys(body)));
    assert.equal(calls.length, 0);
  }
  const { guard, calls } = guardFor('S-self');
  await guard(`${GMAIL}/messages/send`, json({ raw, threadId: 't1' }));
  assert.equal(calls.length, 1);
});
