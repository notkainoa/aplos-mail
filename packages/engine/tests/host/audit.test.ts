import assert from 'node:assert/strict';
import test from 'node:test';
import type { Caller } from '@aplos/contract/access';
import { auditExtension, auditWrites } from '../../src/host/audit';
import { openStore, StoreError } from '../../src/store';
import { tempDb } from '../store/helpers';

const window: Caller = { kind: 'window', scopes: [] };
const client: Caller = { kind: 'listener', via: 'http', clientId: 'c1', scopes: ['admin'] };

function world() {
  const file = tempDb();
  const store = openStore(file.open(), { now: () => 1_000, extensions: [auditExtension] });
  const rows = () =>
    (
      file
        .open()
        .prepare('SELECT at, client_id, method, target FROM audit_log ORDER BY id')
        .all() as Array<Record<string, unknown>>
    ).map(row => ({ ...row }));
  return { store, rows };
}

test('a window or main call writes no audit row; a listener client writes one', () => {
  assert.deepEqual(auditWrites(window, 'Mail/allowImages', 'a@b.example'), []);
  assert.deepEqual(auditWrites({ kind: 'host', scopes: [] }, 'Mail/allowImages'), []);
  assert.deepEqual(auditWrites(client, 'Mail/allowImages', 'a@b.example'), [
    { kind: 'audit', clientId: 'c1', method: 'Mail/allowImages', target: 'a@b.example' },
  ]);
  assert.throws(
    () => auditWrites({ kind: 'listener', scopes: [] }, 'Mail/allowImages'),
    StoreError,
    'an unidentified listener is refused',
  );
});

test('the row lands with the commit, content-free, stamped with the store clock', () => {
  const { store, rows } = world();
  store.commit({
    opId: 'o1',
    origin: 'local',
    writes: [
      ...auditWrites(client, 'Mail/allowImages', '@shop.example'),
      ...auditWrites(client, 'Account/remove'),
    ],
  });
  assert.deepEqual(rows(), [
    { at: 1_000, client_id: 'c1', method: 'Mail/allowImages', target: '@shop.example' },
    { at: 1_000, client_id: 'c1', method: 'Account/remove', target: null },
  ]);
});

test('a commit that fails rolls the audit row back, and a replayed opId writes it once', () => {
  const { store, rows } = world();
  assert.throws(() =>
    store.commit({
      opId: 'bad',
      origin: 'local',
      writes: [
        ...auditWrites(client, 'Mail/allowImages', 'x'),
        { kind: 'audit', clientId: '', method: 'm' },
      ],
    }),
  );
  assert.deepEqual(rows(), []);
  const write = {
    opId: 'same',
    origin: 'local' as const,
    writes: auditWrites(client, 'Clients/revoke', 'c2'),
  };
  store.commit(write);
  store.commit(write);
  assert.equal(rows().length, 1);
});

test('a row with an empty or oversized field is refused, never cut', () => {
  const { store, rows } = world();
  const bad = [
    { kind: 'audit' as const, clientId: 'c1', method: '' },
    { kind: 'audit' as const, clientId: 'c1', method: 'm', target: 'x'.repeat(1_001) },
  ];
  for (const [i, write] of bad.entries())
    assert.throws(
      () => store.commit({ opId: `b${i}`, origin: 'local', writes: [write] }),
      StoreError,
    );
  assert.deepEqual(rows(), []);
});

test('every id the contract accepts (1000 characters) can be audited', () => {
  const { store, rows } = world();
  const long: Caller = { ...client, clientId: 'c'.repeat(1_000) };
  store.commit({
    opId: 'long',
    origin: 'local',
    writes: auditWrites(long, 'Mail/allowImages', 't'.repeat(1_000)),
  });
  assert.equal(rows().length, 1);
});
