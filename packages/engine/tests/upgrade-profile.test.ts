import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore } from '../src/store';
import { MIGRATIONS } from '../src/store/migrations';
import { accountIds, readAccounts } from '../src/sync/account-read';
import { tempDb } from './store/helpers';

/*
 * An existing profile must still find its accounts after an upgrade: a data dir written at any earlier schema version
 * opens on the current migrations with its account listed and readable. A profile that opens to onboarding has lost its
 * account rows or cannot read them; this is the check that the migrations themselves never do that. The old file is made
 * with raw SQL because the current writers use columns the old schema does not have yet.
 */
for (let version = 1; version < MIGRATIONS.length; version++) {
  test(`a profile written at schema ${version} upgrades with its account intact`, () => {
    const file = tempDb();
    try {
      const old = openStore(file.open(), { migrations: MIGRATIONS.slice(0, version) });
      assert.equal(old.schemaVersion, version);
      old.close();
      const db = file.open();
      db.prepare(
        `INSERT INTO accounts(id, provider, address, capabilities, status, created_at, updated_at)
         VALUES('acct-old', 'gmail', 'owner@mail.example', '{"mail":true,"calendar":true}', 'ok', 1, 1)`,
      ).run();
      db.close();

      const store = openStore(file.open());
      assert.equal(store.schemaVersion, MIGRATIONS.length);
      assert.deepEqual(accountIds(store), ['acct-old']);
      const { list, notFound } = readAccounts(store, () => undefined);
      assert.deepEqual(
        list.map(a => [a.id, a.address]),
        [['acct-old', 'owner@mail.example']],
      );
      assert.deepEqual(notFound, []);
      store.close();
    } finally {
      file.cleanup();
    }
  });
}
