import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore, type StorePort, type StoreWrite } from '../../src/store';
import { openSqlite } from '../../../../apps/desktop/src/host/sqlite';
import { readThreadRows } from '../../src/views/rows';
import { lowGroups } from '../../src/views/sections';
import { compileView } from '../../src/views/registry';
import type { ViewEnv } from '../../src/views/specs';
import { ACCOUNT, T0, accountWrite, folderWrites, msg } from '../store/helpers';

/*
 * Who counts as "me" and who a Follow up waits on (ui-home's #454 handoff). A participant is the owner when its
 * address is any account's or sent a from-me message in the thread (an alias has no account row); `recipients` is the
 * newest outbound message's To+Cc so a thread only the owner wrote in still names someone.
 */

const ENV: ViewEnv = { now: T0 + 10 * 86_400_000, zone: 'UTC', followUpDays: 3 };
const STATE = { dbEpoch: 'test', seq: 0 };
const SENT = {
  kind: 'folder',
  accountId: ACCOUNT,
  remoteId: 'SENT',
  name: 'Sent',
  role: 'sent',
  folderKind: 'system',
} as const;

const sent = (
  remoteId: string,
  thread: string,
  minutes: number,
  extra: Parameters<typeof msg>[3] = {},
) =>
  msg(remoteId, thread, minutes, {
    from: { address: 'owner@mail.example', name: 'Owner' },
    to: [{ address: 'pat@mail.example', name: 'Pat' }],
    flags: { seen: true, flagged: false, draft: false, fromMe: true },
    folders: [{ folder: 'SENT' }],
    ...extra,
  });

function setup(writes: StoreWrite[]): StorePort {
  const store = openStore(openSqlite(':memory:'), { now: () => T0 });
  store.commit({ opId: 'setup', origin: 'sync', writes: [accountWrite, ...folderWrites, SENT] });
  for (const [i, w] of writes.entries())
    store.commit({ opId: `w${i}`, origin: 'sync', writes: [w] });
  return store;
}

const row = (store: StorePort, thread: string) =>
  store.read(q => readThreadRows(q, [`${ACCOUNT}:${thread}`], ENV, STATE)).list[0]!;

const fromMeFlags = { seen: true, flagged: false, draft: false, fromMe: true };

test('a send from an alias marks its participant me, and recipients name who the newest send went to', () => {
  const store = setup([
    msg('m1', 't1', 1, { from: { address: 'pat@mail.example', name: 'Pat' } }),
    sent('m2', 't1', 2, {
      from: { address: 'alias@mail.example', name: 'Owner Alias' },
      cc: [{ address: 'cc@mail.example' }],
    }),
  ]);
  try {
    const r = row(store, 't1');
    assert.equal(r.participants.find(p => p.address === 'alias@mail.example')?.me, true);
    assert.equal(r.participants.find(p => p.address === 'pat@mail.example')?.me, undefined);
    assert.deepEqual(r.recipients, [
      { name: 'Pat', address: 'pat@mail.example' },
      { address: 'cc@mail.example' },
    ]);
  } finally {
    store.close();
  }
});

test('another account of the owner counts as me too; inbound-only threads have no recipients', () => {
  const store = setup([
    { ...accountWrite, id: 'acct-2', address: 'desk@mail.example' },
    msg('m1', 't1', 1, { from: { address: 'desk@mail.example', name: 'Owner Elsewhere' } }),
    msg('m3', 't2', 1, { from: { address: 'pat@mail.example', name: 'Pat' } }),
  ]);
  try {
    assert.equal(row(store, 't1').participants[0]?.me, true);
    assert.equal(row(store, 't2').recipients, undefined);
  } finally {
    store.close();
  }
});

test('drafts name no one: recipients come only from sent mail', () => {
  const store = setup([
    msg('m1', 't1', 1, { from: { address: 'pat@mail.example', name: 'Pat' } }),
    sent('m2', 't1', 2, {
      from: { address: 'alias@mail.example', name: 'Owner Alias' },
      flags: { ...fromMeFlags, draft: true },
    }),
  ]);
  try {
    const r = row(store, 't1');
    assert.equal(r.recipients, undefined);
    assert.deepEqual(
      r.participants.map(p => p.address),
      ['pat@mail.example'],
    );
  } finally {
    store.close();
  }
});

test('the Low band groups and names the newest non-owner sender, past an alias of the owner', () => {
  const store = setup([
    msg('m1', 't1', 1, { from: { address: 'crowd@news.example', name: 'Crowd' } }),
    sent('m2', 't1', 2, {
      from: { address: 'alias@mail.example', name: 'Owner Alias' },
      to: [{ address: 'crowd@news.example' }],
    }),
    {
      kind: 'workflow',
      accountId: ACCOUNT,
      remoteThreadId: 't1',
      patch: { lane: 'low' },
    },
  ]);
  try {
    const groups = store.read(q => lowGroups(q));
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.address, 'crowd@news.example');
    assert.equal(groups[0]!.name, 'Crowd');
    assert.deepEqual(groups[0]!.threadIds, [`${ACCOUNT}:t1`]);
  } finally {
    store.close();
  }
});

test('the home Low band preview names non-owner senders, never the owner', () => {
  const low = (thread: string): StoreWrite => ({
    kind: 'workflow',
    accountId: ACCOUNT,
    remoteThreadId: thread,
    patch: { lane: 'low' },
  });
  const store = setup([
    msg('m1', 't1', 1, { from: { address: 'crowd@news.example', name: 'Crowd' } }),
    sent('m2', 't1', 2, {
      from: { address: 'alias@mail.example', name: 'Owner Alias' },
      to: [{ address: 'crowd@news.example' }],
    }),
    msg('m3', 't2', 3, { from: { address: 'notes@news.example', name: 'Field Notes' } }),
    low('t1'),
    low('t2'),
  ]);
  try {
    const layout = store.read(q => compileView({ kind: 'home' }, ENV).layout(q));
    const section = layout.sections.find(s => s.key === 'low');
    assert.deepEqual(section?.senders, ['Field Notes', 'Crowd']);
  } finally {
    store.close();
  }
});

// ---- review of #464 (integrator Opus): rules whose undo used to stay green

const low = (thread: string): StoreWrite => ({
  kind: 'workflow',
  accountId: ACCOUNT,
  remoteThreadId: thread,
  patch: { lane: 'low' },
});

test('recipients never carry a Bcc address', () => {
  const store = setup([
    msg('m1', 't1', 1, { from: { address: 'pat@mail.example', name: 'Pat' } }),
    sent('m2', 't1', 2, { bcc: [{ address: 'secret@mail.example', name: 'Hidden' }] }),
  ]);
  try {
    assert.deepEqual(row(store, 't1').recipients, [{ name: 'Pat', address: 'pat@mail.example' }]);
  } finally {
    store.close();
  }
});

test('recipients follow the NEWEST message the owner sent', () => {
  const store = setup([
    sent('m1', 't1', 1, { to: [{ address: 'old@mail.example', name: 'Old' }] }),
    sent('m2', 't1', 3, { to: [{ address: 'new@mail.example', name: 'New' }] }),
    sent('m3', 't1', 2, { to: [{ address: 'mid@mail.example', name: 'Mid' }] }),
  ]);
  try {
    assert.deepEqual(row(store, 't1').recipients, [{ name: 'New', address: 'new@mail.example' }]);
  } finally {
    store.close();
  }
});

test('the Low band groups under the other person when the newest sender is the owner’s second account', () => {
  const store = setup([
    { ...accountWrite, id: 'acct-2', address: 'desk@mail.example' },
    msg('m1', 't1', 1, { from: { address: 'crowd@news.example', name: 'Crowd' } }),
    msg('m2', 't1', 2, { from: { address: 'desk@mail.example', name: 'Owner Elsewhere' } }),
    low('t1'),
  ]);
  try {
    const groups = store.read(q => lowGroups(q));
    assert.deepEqual(
      groups.map(g => [g.address, g.name]),
      [['crowd@news.example', 'Crowd']],
    );
  } finally {
    store.close();
  }
});

test('a draft sent from an address never hides a real sender of that address in the Low band', () => {
  const store = setup([
    msg('m1', 't1', 1, { from: { address: 'shared@list.example', name: 'List Team' } }),
    sent('m2', 't1', 2, {
      from: { address: 'shared@list.example', name: 'List Team' },
      flags: { ...fromMeFlags, draft: true },
    }),
    low('t1'),
  ]);
  try {
    const groups = store.read(q => lowGroups(q));
    assert.deepEqual(
      groups.map(g => g.address),
      ['shared@list.example'],
      'grouped by the address, which a hidden sender would have lost (it would fall back to the name)',
    );
  } finally {
    store.close();
  }
});

test('an empty from address is not the owner: the Low band agrees with the row’s participants', () => {
  const store = setup([
    msg('m1', 't1', 1, { from: { address: 'xavier@news.example', name: 'Xavier' } }),
    sent('m2', 't1', 2, {
      from: { address: '', name: 'Weird' },
      to: [{ address: 'xavier@news.example' }],
    }),
    low('t1'),
  ]);
  try {
    assert.equal(row(store, 't1').participants.find(p => p.name === 'Weird')?.me, undefined);
    const layout = store.read(q => compileView({ kind: 'home' }, ENV).layout(q));
    const section = layout.sections.find(s => s.key === 'low');
    assert.deepEqual(section?.senders, ['Weird']);
  } finally {
    store.close();
  }
});
