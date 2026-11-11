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
