import assert from 'node:assert/strict';
import test from 'node:test';
import { MIGRATIONS } from '../../src/store/migrations';
import { openStore } from '../../src/store';
import { accountWrite, tempDb } from './helpers';

const listed = (file: ReturnType<typeof tempDb>) =>
  (
    file.open().prepare('SELECT calendar_listed_at AS at FROM accounts').get() as
      { at: number | null } | undefined
  )?.at;

test('migration 0006 on a 0005 database: existing accounts stay NULL, it is idempotent, and the first write wins', () => {
  const file = tempDb();
  try {
    const old = openStore(file.open(), { migrations: MIGRATIONS.slice(0, 5) });
    old.commit({ opId: 'a', origin: 'sync', writes: [accountWrite] });
    assert.equal(old.schemaVersion, 5);
    old.close();
    for (let pass = 0; pass < 2; pass++) {
      const store = openStore(file.open());
      assert.equal(store.schemaVersion, MIGRATIONS.length);
      assert.equal(listed(file), null, 'unknown until the next list');
      store.close();
    }
    const store = openStore(file.open());
    store.commit({
      opId: 'l1',
      origin: 'sync',
      writes: [{ kind: 'account', id: accountWrite.id, calendarListedAt: 1_000 }],
    });
    assert.equal(listed(file), 1_000);
    store.commit({
      opId: 'l2',
      origin: 'sync',
      writes: [{ kind: 'account', id: accountWrite.id, calendarListedAt: 9_999 }],
    });
    assert.equal(listed(file), 1_000, 'a later value never moves it');
    store.close();
  } finally {
    file.cleanup?.();
  }
});

test('a new account can carry calendarListedAt from its first write', () => {
  const file = tempDb();
  try {
    const store = openStore(file.open());
    store.commit({
      opId: 'n',
      origin: 'sync',
      writes: [{ ...accountWrite, calendarListedAt: 42 }],
    });
    assert.equal(listed(file), 42);
    store.close();
  } finally {
    file.cleanup?.();
  }
});
