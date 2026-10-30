/**
 * prov-gmail-write filters: the sender_rules mirror on Gmail `users.settings.filters` (plan 20 PV4), on the
 * Gmail emulator. Block and skip-Inbox rules round-trip, an edit is delete-and-recreate with no duplicate,
 * an identical create returns the existing id, foreign filters are ignored and never deleted, a query
 * string can never be smuggled into `criteria.from`, a missing settings scope is no capability and zero
 * requests, delete of a missing filter is success, and the prices hold: create 5, list 1, delete 5.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCOPE } from '@aplos/emulators';
import type { SenderRule } from '@aplos/engine/ports';
import { CLIENT_ID, GMAIL_SCOPES, rig, type Rig } from './harness';

const rules = (r: Rig) => r.adapter.rules!;
const block = (addressOrDomain: string): SenderRule => ({ addressOrDomain, action: 'block' });
const skipInbox = (addressOrDomain: string): SenderRule => ({
  addressOrDomain,
  action: 'skipInbox',
});
/** Filter calls since a marked `emu.log.length` index (the log's `at` is clock time, not an index). */
const filterCalls = (r: Rig, mark = 0) =>
  r.emu.log.slice(mark).filter(e => e.service === 'gmail' && e.apiMethod.includes('filters'));
const methods = (r: Rig, mark = 0) => filterCalls(r, mark).map(e => e.apiMethod);
const remote = (r: Rig) => r.emu.mailbox.listFilters();

test('prov-gmail-T70 a block and a skip-Inbox rule become Gmail filters and list back', async () => {
  const r = await rig();
  const since = r.emu.log.length;
  const blockId = await rules(r).create(block('sales@spammy.test'), r.ctx());
  const skipId = await rules(r).create(skipInbox('@news.example.test'), r.ctx());
  assert.ok(blockId && skipId && blockId !== skipId);

  // The remote copy is exactly the filter shape filters.ts promises: land in Spam, out of the Inbox.
  const stored = remote(r);
  assert.equal(stored.length, 2);
  assert.deepEqual(
    stored.find(f => f.id === blockId),
    {
      id: blockId,
      criteria: { from: 'sales@spammy.test' },
      action: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] },
    },
  );
  assert.deepEqual(
    stored.find(f => f.id === skipId),
    {
      id: skipId,
      criteria: { from: '@news.example.test' },
      action: { removeLabelIds: ['INBOX'] },
    },
  );

  const listed = await rules(r).list(r.ctx());
  assert.deepEqual(
    new Map(listed.map(x => [x.remoteId, x])),
    new Map([
      [blockId, { remoteId: blockId, addressOrDomain: 'sales@spammy.test', action: 'block' }],
      [skipId, { remoteId: skipId, addressOrDomain: '@news.example.test', action: 'skipInbox' }],
    ]),
  );
  assert.deepEqual(
    filterCalls(r, since).map(e => [e.apiMethod, e.units]),
    [
      ['gmail.users.settings.filters.list', 1],
      ['gmail.users.settings.filters.create', 5],
      ['gmail.users.settings.filters.list', 1],
      ['gmail.users.settings.filters.create', 5],
      ['gmail.users.settings.filters.list', 1],
    ],
    'each create lists first, so an identical rule is never written twice',
  );
});

test('prov-gmail-T71 an identical create returns the existing id; an edit is delete-and-recreate', async () => {
  const r = await rig();
  const first = await rules(r).create(skipInbox('letters@x.test'), r.ctx());
  const since = r.emu.log.length;
  const again = await rules(r).create(skipInbox('letters@x.test'), r.ctx());
  assert.equal(again, first);
  assert.deepEqual(methods(r, since), ['gmail.users.settings.filters.list']);
  assert.equal(remote(r).length, 1, 'no duplicate was written');

  // The engine's edit: delete the old remote filter, create the new one.
  const afterSecond = r.emu.log.length;
  await rules(r).delete(first, r.ctx());
  const edited = await rules(r).create(block('letters@x.test'), r.ctx());
  assert.notEqual(edited, first);
  assert.equal(remote(r).length, 1, 'the mirror survives the edit as exactly one filter');
  assert.deepEqual(await rules(r).list(r.ctx()), [
    { remoteId: edited, addressOrDomain: 'letters@x.test', action: 'block' },
  ]);
  assert.deepEqual(methods(r, afterSecond), [
    'gmail.users.settings.filters.delete',
    'gmail.users.settings.filters.list',
    'gmail.users.settings.filters.create',
    'gmail.users.settings.filters.list',
  ]);
  const deletes = r.fetches.filter(f => f.method === 'DELETE');
  assert.equal(deletes.length, 1);
  assert.ok(deletes[0].path.endsWith(`/settings/filters/${first}`));
});

test('prov-gmail-T72 foreign filters are ignored by list and never deleted', async () => {
  const r = await rig();
  // Someone else's filters: an extra criterion, a criteria that is not `from`, a different action.
  const foreign = [
    r.emu.mailbox.createFilter(
      { from: 'bills@x.test', subject: 'invoice' },
      { removeLabelIds: ['INBOX'] },
    ),
    r.emu.mailbox.createFilter({ query: 'has:attachment' }, { removeLabelIds: ['UNREAD'] }),
    r.emu.mailbox.createFilter(
      { from: 'pal@x.test' },
      { addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] },
    ),
  ];
  const mine = await rules(r).create(skipInbox('@ads.example.test'), r.ctx());
  assert.deepEqual(await rules(r).list(r.ctx()), [
    { remoteId: mine, addressOrDomain: '@ads.example.test', action: 'skipInbox' },
  ]);
  await rules(r).delete(mine, r.ctx());
  assert.deepEqual(await rules(r).list(r.ctx()), []);
  const left = remote(r).map(f => f.id);
  assert.equal(left.length, 3, 'deleting our own filter touched none of the foreign ones');
  assert.deepEqual(new Set(left), new Set(foreign.map(f => f.id)));
});

test('prov-gmail-T73 a sender string that is not a plain address or domain is refused before any request', async () => {
  const r = await rig();
  const bad = [
    'x@y.test OR from:z@w.test',
    'x@y.test) OR (from:z@w.test',
    'x@y.test){from:z@w.test',
    '"x@y.test"',
    'x@y.test\nfrom:z@w.test',
    'from:x@y.test',
    'x@y.test subject:hi',
    'x@y@z.test',
    'not an address',
    `${'a'.repeat(300)}@x.test`,
  ];
  for (const addressOrDomain of bad) {
    const since = r.emu.log.length;
    await assert.rejects(rules(r).create({ addressOrDomain, action: 'block' }, r.ctx()));
    assert.equal(
      filterCalls(r, since).length,
      0,
      `no request for ${JSON.stringify(addressOrDomain)}`,
    );
  }
  assert.equal(remote(r).length, 0);
});

test('prov-gmail-T74 without gmail.settings.basic the account holds no provider rules and sends nothing', async () => {
  const r = await rig();
  const ctx = r.ctx();
  ctx.account = {
    ...ctx.account,
    grantedScopes: ctx.account.grantedScopes.filter(s => s !== SCOPE.gmailSettingsBasic),
    capabilities: { ...ctx.account.capabilities, filters: false },
  };
  const since = r.emu.log.length;
  assert.deepEqual(await rules(r).list(ctx), []);
  assert.equal(await rules(r).create(block('x@y.test'), ctx), undefined);
  await rules(r).delete('ANe1BmAnything', ctx);
  assert.equal(filterCalls(r, since).length, 0, 'zero filter requests without the scope');
  assert.equal(
    r.fetches.filter(f => f.path.includes('/settings/filters')).length,
    0,
    'not even the governor was asked',
  );
});

test('prov-gmail-T75 a 403 insufficientPermissions is no capability, and the refusal is not repeated', async () => {
  const r = await rig();
  // The account facts still claim the scope, but the grant was revoked at Google: consent again without it,
  // so the access token in use no longer carries gmail.settings.basic.
  const user = r.emu.users()[0].email;
  r.emu.oauth.setGrantedScopes(user, ['openid', 'email', 'profile', SCOPE.gmailModify]);
  const session = await r.emu.oauth.signIn({
    clientId: CLIENT_ID,
    scopes: GMAIL_SCOPES,
    fetch: r.emu.fetch,
  });
  assert.ok(!session.scope.includes(SCOPE.gmailSettingsBasic));
  r.tokens.access = session.accessToken;

  const since = r.emu.log.length;
  assert.equal(await rules(r).create(skipInbox('x@y.test'), r.ctx()), undefined);
  // The denial is remembered for the adapter's lifetime: everything after answers without a request.
  assert.equal(await rules(r).create(skipInbox('x@y.test'), r.ctx()), undefined);
  assert.deepEqual(await rules(r).list(r.ctx()), []);
  await rules(r).delete('ANe1BmAnything', r.ctx());
  assert.deepEqual(
    filterCalls(r, since).map(e => [e.apiMethod, e.status]),
    [
      ['gmail.users.settings.filters.list', 200],
      ['gmail.users.settings.filters.create', 403],
    ],
    'one list (settingsRead is covered by gmail.modify) and one refused create, then nothing',
  );
});

test('prov-gmail-T76 delete of a missing filter is success', async () => {
  const r = await rig();
  await rules(r).delete('ANe1BmDoesNotExist', r.ctx());
  assert.deepEqual(
    filterCalls(r).map(e => [e.apiMethod, e.status]),
    [['gmail.users.settings.filters.delete', 404]],
    'the 404 went out and was answered as success',
  );
});

test('prov-gmail-T77 filter calls are priced list 1, create 5, delete 5 through the governor', async () => {
  const r = await rig();
  const id = await rules(r).create(block('a@b.test'), r.ctx());
  await rules(r).list(r.ctx());
  await rules(r).delete(id, r.ctx());
  const charged: Record<string, number> = {};
  for (const e of filterCalls(r)) {
    assert.ok(!(e.apiMethod in charged) || charged[e.apiMethod] === e.units);
    charged[e.apiMethod] = e.units;
  }
  assert.deepEqual(charged, {
    'gmail.users.settings.filters.list': 1,
    'gmail.users.settings.filters.create': 5,
    'gmail.users.settings.filters.delete': 5,
  });
  const expected = {
    'gmail.settings.filters.list': 1,
    'gmail.settings.filters.create': 5,
    'gmail.settings.filters.delete': 5,
  };
  const governed = r.governor.sentCalls().filter(c => c.method.includes('settings.filters'));
  assert.ok(governed.length >= 3);
  for (const c of governed) assert.equal(c.cost, expected[c.method as keyof typeof expected]);
});
