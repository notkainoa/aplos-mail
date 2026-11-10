import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore, type StoreWrite } from '../../src/store';
import { openSqlite } from '../../../../apps/desktop/src/host/sqlite';
import { compileView } from '../../src/views/registry';
import type { ViewEnv } from '../../src/views/specs';
import { ACCOUNT, T0, accountWrite, folderWrites, msg } from '../store/helpers';
import { incoming, patch, worldEngine } from './harness';

/*
 * A thread the owner started and nobody has answered is not new mail. Every thread starts `new`, and the first sync
 * reads Sent as well as Inbox, so before this fix such a thread sat in Do now (and in Follow up) on the real engine.
 */

const ENV: ViewEnv = { now: T0 + 10 * 86_400_000, zone: 'UTC', followUpDays: 3 };

const sentOnly = (): StoreWrite =>
  msg('s1', 'mine', 1, {
    from: { address: accountWrite.address },
    to: [{ address: 'friend@mail.example' }],
    flags: { seen: true, flagged: false, draft: false, fromMe: true },
    folders: [{ folder: 'SENT' }],
  });

function homeIds(section: 'do' | 'update' | 'low' | 'follow', awaiting = false): string[] {
  const store = openStore(openSqlite(':memory:'), { now: () => T0 });
  try {
    store.commit({
      opId: 'setup',
      origin: 'sync',
      writes: [
        accountWrite,
        ...folderWrites,
        {
          kind: 'folder',
          accountId: ACCOUNT,
          remoteId: 'SENT',
          name: 'Sent',
          role: 'sent',
          folderKind: 'system',
        },
      ],
    });
    store.commit({ opId: 'in', origin: 'sync', writes: [msg('m1', 'theirs', 2)] });
    store.commit({ opId: 'out', origin: 'sync', writes: [sentOnly()] });
    if (awaiting)
      store.commit({
        opId: 'awaiting',
        origin: 'local',
        writes: [
          {
            kind: 'workflow',
            accountId: ACCOUNT,
            remoteThreadId: 'mine',
            patch: { replyStatus: 'awaitingReply' },
          },
        ],
      });
    const plan = compileView({ kind: 'homeSection', section }, ENV);
    return store.read(q => plan.rows(q, undefined, 50).map(r => r.id));
  } finally {
    store.close();
  }
}

test('a thread the owner started stays out of Do now; mail someone sent to the owner stays in', () => {
  assert.deepEqual(homeIds('do'), [`${ACCOUNT}:theirs`]);
});

test('unchanged by the fix: the Sent-only thread is still in Follow up once nobody has answered it', () => {
  assert.deepEqual(homeIds('follow', true), [`${ACCOUNT}:mine`]);
});

// Through the real engine (`View/query`). The Sent-only threads are put in every lane first, so the Update and Low
// assertions can fail: a thread in lane `low` that the cursor let through would show up there.
test('a Sent-only thread is in no Home lane whichever lane it holds; an answered one is in its lane', async () => {
  const t = await worldEngine(3, 0);
  try {
    const lanes = ['do', 'update', 'low'] as const;
    const mine = (lane: string) => `lonely-${lane}`;
    const heard = (lane: string) => `heard-${lane}`;
    t.commit(
      lanes.flatMap(lane => [
        incoming(heard(lane)),
        {
          ...incoming(mine(lane), { folder: 'SENT', seen: true }),
          from: { address: 'owner@mail.example', name: 'Owner' },
          to: [{ address: 'friend@mail.example' }],
          flags: { seen: true, flagged: false, draft: false, fromMe: true },
        },
      ]),
      'sync',
    );
    t.commit(
      lanes
        .flatMap(lane => [mine(lane), heard(lane)])
        .map(id => patch(`acct-1:${id}`, { rankSource: 'user', lane: id.split('-')[1] })),
    );
    for (const lane of lanes) {
      const ids = (
        await t.call('View/query', { spec: { kind: 'homeSection', section: lane }, limit: 50 })
      ).ids;
      assert.ok(ids.includes(`acct-1:${heard(lane)}`), `mail from someone stays in ${lane}`);
      assert.ok(
        !ids.includes(`acct-1:${mine(lane)}`),
        `a Sent-only thread is not new mail in ${lane}`,
      );
    }
  } finally {
    await t.close();
  }
});
