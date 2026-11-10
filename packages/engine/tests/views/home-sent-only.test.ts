import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore, type StoreWrite } from '../../src/store';
import { openSqlite } from '../../../../apps/desktop/src/host/sqlite';
import { compileView } from '../../src/views/registry';
import type { ViewEnv } from '../../src/views/specs';
import { ACCOUNT, T0, accountWrite, folderWrites, msg } from '../store/helpers';

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

test('and the Sent-only thread is still in Follow up once nobody has answered it', () => {
  assert.deepEqual(homeIds('follow', true), [`${ACCOUNT}:mine`]);
});
