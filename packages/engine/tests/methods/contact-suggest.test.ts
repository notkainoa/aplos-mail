import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore } from '../../src/store';
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb } from '../store/helpers';
import { manualClock } from '../runtime.helpers';
import { suggest } from '../../src/methods/draft';
import type { EngineServices } from '../../src/methods/types';

/** A store over a temp db with mail committed, wrapped in the services shell `suggest` needs. */
function world(writes: Parameters<ReturnType<typeof openStore>['commit']>[0]['writes']) {
  const file = tempDb();
  const clock = manualClock();
  const store = openStore(file.open(), { now: () => clock.now() });
  store.commit({ opId: 'seed', origin: 'sync', writes });
  const services = { store, clock } as unknown as EngineServices;
  return { services, store, file };
}

test('Contact/suggest: ranks by sent_to * 2 + received_from, matching address or a name word', () => {
  const { services, file } = world([
    accountWrite,
    ...folderWrites.map(f => ({ ...f })),
    // Outbound: one to Priya, two to Maya (sent_to counts; drafts and self never count).
    msg('o1', 'T-1', 1, {
      from: { address: 'owner@mail.example', name: 'Owner' },
      to: [{ address: 'priya@mail.example', name: 'Priya Raman' }],
      flags: { seen: true, flagged: false, draft: false, fromMe: true },
    }),
    msg('o2', 'T-2', 2, {
      from: { address: 'owner@mail.example', name: 'Owner' },
      to: [
        { address: 'maya@mail.example', name: 'Maya Chen' },
        { address: 'maya@mail.example', name: 'Maya Chen' },
      ],
      flags: { seen: true, flagged: false, draft: false, fromMe: true },
    }),
    // Inbound: two from Priya, one from Sam.
    msg('i1', 'T-1', 3, { from: { address: 'priya@mail.example', name: 'Priya Raman' } }),
    msg('i2', 'T-1', 4, { from: { address: 'priya@mail.example', name: 'Priya Raman' } }),
    msg('i3', 'T-3', 5, { from: { address: 'sam@mail.example', name: 'Sam Blue' } }),
  ]);
  const all = suggest({ query: '', limit: 10 }, services).list;
  assert.deepEqual(
    all.map(r => [r.address, r.sentTo, r.receivedFrom]),
    [
      ['priya@mail.example', 1, 2], // score 4
      ['maya@mail.example', 1, 0], // score 2 (distinct per message)
      ['sam@mail.example', 0, 1],
    ],
  );
  // Name-word prefix: "ram" hits Priya Raman's second word, not the address.
  const ram = suggest({ query: 'ram', limit: 10 }, services).list;
  assert.deepEqual(
    ram.map(r => r.address),
    ['priya@mail.example'],
  );
  // Address prefix.
  assert.deepEqual(
    suggest({ query: 'may', limit: 10 }, services).list.map(r => r.address),
    ['maya@mail.example'],
  );
  // The owner's own address never appears.
  assert.ok(!all.some(r => r.address === 'owner@mail.example'));
  file.cleanup();
});

test('Contact/suggest: an empty query returns the top correspondents; limit is honored', () => {
  const { services, file } = world([
    accountWrite,
    ...folderWrites.map(f => ({ ...f })),
    msg('i1', 'T-1', 1, { from: { address: 'a@mail.example' } }),
    msg('i2', 'T-2', 2, { from: { address: 'b@mail.example' } }),
    msg('i3', 'T-3', 3, { from: { address: 'c@mail.example' } }),
  ]);
  const list = suggest({ query: '   ', limit: 2 }, services).list;
  assert.equal(list.length, 2);
  file.cleanup();
});

test("Contact/suggest: the account filter keeps one account's rows; disconnect purges them (R2G-3)", () => {
  const second = {
    ...accountWrite,
    id: 'acct-2',
    address: 'two@mail.example',
  } as const;
  const { services, file } = world([
    accountWrite,
    second,
    ...folderWrites.map(f => ({ ...f })),
    ...folderWrites.map(f => ({ ...f, accountId: 'acct-2' })),
    msg('i1', 'T-1', 1, { from: { address: 'shared@mail.example', name: 'Shared' } }),
    // The same address in account 2, plus one only account 2 knows.
    {
      ...msg('j1', 'T-9', 2, { from: { address: 'shared@mail.example', name: 'Shared' } }),
      accountId: 'acct-2',
      remoteThreadId: 'T-9',
      folders: [{ folder: 'INBOX' }],
    } as never,
    {
      ...msg('j2', 'T-9', 3, { from: { address: 'only2@mail.example' } }),
      accountId: 'acct-2',
    } as never,
  ]);
  const scoped = suggest({ query: '', accountId: 'acct-2', limit: 10 }, services).list;
  assert.deepEqual(
    scoped.map(r => [r.address, r.sentTo + r.receivedFrom]),
    [
      ['only2@mail.example', 1],
      ['shared@mail.example', 1],
    ],
  );
  // Without the filter the shared address sums both accounts.
  const shared = suggest({ query: 'shared', limit: 10 }, services).list;
  assert.equal(shared[0].receivedFrom, 2);
  // Account/disconnect removes the account row; its correspondents cascade away.
  services.store.commit({
    opId: 'drop',
    origin: 'sync',
    writes: [{ kind: 'accountRemove', accountId: 'acct-2' } as never],
  });
  const left = services.store.read(q =>
    q.all<{ account_id: string }>('SELECT account_id FROM correspondents GROUP BY account_id'),
  );
  assert.deepEqual(
    left.map(r => r.account_id),
    [ACCOUNT],
  );
  file.cleanup();
});

test('Contact/suggest: a shared address keeps every count and every name; accents and owned addresses behave', () => {
  const second = {
    ...accountWrite,
    id: 'acct-2',
    address: 'two@mail.example',
  } as const;
  const { services, file } = world([
    accountWrite,
    second,
    ...folderWrites.map(f => ({ ...f })),
    ...folderWrites.map(f => ({ ...f, accountId: 'acct-2' })),
    // acct-1 knows the address as "Amy" with two inbound; acct-2 as "Zamy" with one.
    msg('i1', 'T-1', 1, { from: { address: 'shared@mail.example', name: 'Amy One' } }),
    msg('i2', 'T-1', 2, { from: { address: 'shared@mail.example', name: 'Amy One' } }),
    {
      ...msg('j1', 'T-9', 3, { from: { address: 'shared@mail.example', name: 'Zamy Two' } }),
      accountId: 'acct-2',
    } as never,
    // An accented name, reachable by its lowercase prefix.
    msg('i3', 'T-2', 4, { from: { address: 'x@mail.example', name: 'Élodie Martin' } }),
    // Mail between the owner's own accounts: neither address may surface.
    msg('i4', 'T-3', 5, { from: { address: 'two@mail.example' } }),
  ]);
  // "amy" matches only the Amy variant but keeps both accounts' counts (2 + 1).
  const amy = suggest({ query: 'amy', limit: 10 }, services).list;
  assert.equal(amy.length, 1);
  assert.equal(amy[0].receivedFrom, 3);
  assert.equal(amy[0].name, 'Amy One');
  // "zam" picks the Zamy display name with the same totals.
  const zam = suggest({ query: 'zam', limit: 10 }, services).list;
  assert.equal(zam.length, 1);
  assert.equal(zam[0].name, 'Zamy Two');
  assert.equal(zam[0].receivedFrom, 3);
  // Accented word prefix folds in JS, not the SQL prefilter.
  const elo = suggest({ query: 'élo', limit: 10 }, services).list;
  assert.deepEqual(
    elo.map(r => r.address),
    ['x@mail.example'],
  );
  // The owner's second account address is never suggested, scoped or not.
  assert.ok(
    !suggest({ query: '', limit: 10 }, services).list.some(r => r.address === 'two@mail.example'),
  );
  assert.ok(
    !suggest({ query: '', accountId: 'acct-2', limit: 10 }, services).list.some(
      r => r.address === 'owner@mail.example',
    ),
  );
  file.cleanup();
});

test('Contact/suggest: LIKE metacharacters are literal; a mixed-case owned address is excluded', () => {
  const caps = { ...accountWrite, address: 'Owner@Mail.Example' } as const;
  const { services, file } = world([
    caps,
    ...folderWrites.map(f => ({ ...f })),
    msg('i1', 'T-1', 1, { from: { address: '100%@mail.example' } }),
    msg('i2', 'T-2', 2, { from: { address: 'under_score@mail.example' } }),
    msg('i3', 'T-3', 3, { from: { address: 'back\\slash@mail.example' } }),
    msg('i4', 'T-4', 4, { from: { address: 'owner@mail.example' } }),
  ]);
  // "100%" matches the literal address only; % is not a wildcard here.
  assert.deepEqual(
    suggest({ query: '100%', limit: 10 }, services).list.map(r => r.address),
    ['100%@mail.example'],
  );
  // "_" matches the literal underscore, not any character.
  assert.deepEqual(
    suggest({ query: 'under_score', limit: 10 }, services).list.map(r => r.address),
    ['under_score@mail.example'],
  );
  // The owner's own address never surfaces even when accounts.address is mixed-case in the table.
  assert.ok(
    !suggest({ query: '', limit: 10 }, services).list.some(r => r.address === 'owner@mail.example'),
  );
  file.cleanup();
});
