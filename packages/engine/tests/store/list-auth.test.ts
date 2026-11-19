import test from 'node:test';
import assert from 'node:assert/strict';
import type { LaneFor, LaneInput } from '../../src/ports/content';
import { MIGRATIONS, openStore, type StorePort, type StoreWrite } from '../../src/store';
import { listHeaders } from '../../src/store/ingest';
import { ACCOUNT, accountWrite, folderWrites, msg, oldMessage, tempDb, withStore } from './helpers';

// `messages.list_auth` (migration 0005): `ListHeaders.authenticated` kept with the message, NULL when unknown.

const UNSUB = { urls: ['https://list.example/u'], oneClick: true };

function listAuth(store: StorePort, remoteId: string): number | null | undefined {
  return store.read(
    q =>
      q.get<{ list_auth: number | null }>(
        'SELECT list_auth FROM messages WHERE account_id = ? AND remote_id = ?',
        ACCOUNT,
        remoteId,
      )?.list_auth,
  );
}

function headersOf(store: StorePort, remoteId: string) {
  return store.read(q => {
    const m = q.get<{ hdr: number; list_unsub: string | null; list_auth: number | null }>(
      'SELECT hdr, list_unsub, list_auth FROM messages WHERE account_id = ? AND remote_id = ?',
      ACCOUNT,
      remoteId,
    );
    return m && listHeaders(m.hdr, m.list_unsub, m.list_auth);
  });
}

function write(store: StorePort, opId: string, writes: StoreWrite[]) {
  store.commit({ opId, origin: 'sync', writes });
}

test('migration 0005 on a 0004 database with mail: existing rows stay NULL (unknown), and it is idempotent', () => {
  const file = tempDb();
  try {
    const old = openStore(file.open(), { migrations: MIGRATIONS.slice(0, 4) });
    old.commit({ opId: 'a', origin: 'sync', writes: [accountWrite] });
    assert.equal(old.schemaVersion, 4);
    old.close();
    const raw = file.open();
    oldMessage(raw, 'm1', 't1', JSON.stringify(UNSUB));
    raw.close();
    for (let pass = 0; pass < 2; pass++) {
      const store = openStore(file.open());
      assert.equal(store.schemaVersion, MIGRATIONS.length);
      assert.equal(listAuth(store, 'm1'), null);
      const headers = headersOf(store, 'm1');
      assert.equal(headers?.listUnsubscribePost, 'List-Unsubscribe=One-Click');
      assert.equal('authenticated' in (headers ?? {}), false, 'unknown is absent, never false');
      store.close();
    }
  } finally {
    file.cleanup();
  }
});

test('a fresh database has messages.list_auth, and it accepts only 0, 1 or NULL', () => {
  withStore(store => {
    write(store, 'a', [accountWrite, ...folderWrites]);
    write(store, 'm', [msg('m1', 't1', 0, { listUnsubscribe: UNSUB, listAuthenticated: true })]);
    assert.equal(listAuth(store, 'm1'), 1);
  });
  const file = tempDb();
  try {
    const store = openStore(file.open());
    store.commit({ opId: 'a', origin: 'sync', writes: [accountWrite] });
    store.close();
    const db = file.open();
    oldMessage(db, 'm1', 't1', JSON.stringify(UNSUB));
    assert.throws(() =>
      db.prepare("UPDATE messages SET list_auth = 2 WHERE remote_id = 'm1'").run(),
    );
    assert.throws(() =>
      db.prepare("UPDATE messages SET list_auth = 'x' WHERE remote_id = 'm1'").run(),
    );
    db.close();
  } finally {
    file.cleanup();
  }
});

test('ingest stores true, false and absent, a read returns them, and a later write without one goes back to unknown', () => {
  withStore(store => {
    write(store, 'a', [accountWrite, ...folderWrites]);
    write(store, 'm', [
      msg('yes', 't1', 0, { listUnsubscribe: UNSUB, listAuthenticated: true }),
      msg('no', 't2', 0, { listUnsubscribe: UNSUB, listAuthenticated: false }),
      msg('unknown', 't3', 0, { listUnsubscribe: UNSUB }),
      msg('bare', 't4', 0, { listAuthenticated: true }),
    ]);
    assert.deepEqual(
      ['yes', 'no', 'unknown', 'bare'].map(id => listAuth(store, id)),
      [1, 0, null, null],
      'a verdict without List-Unsubscribe is not kept',
    );
    assert.equal(headersOf(store, 'yes')?.authenticated, true);
    assert.equal(headersOf(store, 'no')?.authenticated, false);
    assert.equal('authenticated' in (headersOf(store, 'unknown') ?? {}), false);
    write(store, 'again', [msg('yes', 't1', 0, { listUnsubscribe: UNSUB })]);
    assert.equal(listAuth(store, 'yes'), null, 'an omitted verdict is unknown, not the old one');
  });
});

test('hostile verdicts: a string "true", 1 or an object are stored as unknown, never authenticated', () => {
  withStore(store => {
    write(store, 'a', [accountWrite, ...folderWrites]);
    const hostile: unknown[] = ['true', 1, 'false', 0, {}, null];
    write(
      store,
      'm',
      hostile.map((v, i) =>
        msg(`h${i}`, `t${i}`, 0, { listUnsubscribe: UNSUB, listAuthenticated: v as boolean }),
      ),
    );
    assert.deepEqual(
      hostile.map((_, i) => listAuth(store, `h${i}`)),
      hostile.map(() => null),
    );
  });
});

test('laneFor reads the stored verdict in LaneMessage.list', () => {
  const calls: LaneInput[] = [];
  const laneFor: LaneFor = input => {
    calls.push(input);
    return { lane: 'low', importance: 'normal' };
  };
  withStore(
    store => {
      write(store, 'a', [accountWrite, ...folderWrites]);
      write(store, 'm', [msg('m1', 't1', 0, { listUnsubscribe: UNSUB, listAuthenticated: true })]);
      assert.equal(calls.at(-1)?.message.list.authenticated, true);
    },
    { ingest: { laneFor } },
  );
});
