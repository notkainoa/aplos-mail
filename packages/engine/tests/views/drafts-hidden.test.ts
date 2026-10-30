import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../src/store';
import { readCounts } from '../../src/views/counts';
import { compileView } from '../../src/views/registry';
import type { ViewEnv } from '../../src/views/specs';
import { accountWrite, tempDb } from '../store/helpers';

/*
 * A discarded or sent draft whose remote copy is still to be deleted keeps its row, hidden (`_sync.removing`). The
 * Drafts list and the drafts count read the same rows, so neither shows it.
 */

const NOW = Date.UTC(2026, 9, 28, 9, 0, 0);
const ENV: ViewEnv = { now: NOW, zone: 'America/Los_Angeles', followUpDays: 3 };

test('the Drafts list and the drafts count leave out a draft waiting for its copy to be deleted', () => {
  const file = tempDb();
  const setup = openStore(file.open());
  setup.commit({ opId: 'setup', origin: 'sync', writes: [accountWrite] });
  setup.close();
  const db = file.open();
  const insert = db.prepare(
    'INSERT INTO drafts(id, account_id, revision, data, updated_at) VALUES(?, ?, 1, ?, ?)',
  );
  insert.run('shown', 'acct-1', JSON.stringify({ subject: 'A', _sync: { rev: 1 } }), NOW);
  insert.run('plain', 'acct-1', '{}', NOW - 1);
  insert.run('hidden', 'acct-1', JSON.stringify({ _sync: { rev: 1, removing: true } }), NOW - 2);
  insert.run('unreadable', 'acct-1', 'not json', NOW - 3);
  db.close();
  const store = openStore(file.open());
  try {
    store.read(q => {
      const ids = compileView({ kind: 'drafts' }, ENV)
        .rows(q, undefined, 50)
        .map(r => r.id);
      assert.deepEqual(ids, ['shown', 'plain', 'unreadable']);
      assert.equal(readCounts(q, ENV).all.drafts, 3);
    });
  } finally {
    store.close();
    file.cleanup();
  }
});
