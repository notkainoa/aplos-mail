import test from 'node:test';
import assert from 'node:assert/strict';
import { DUE_QUERIES, dueSubmissions, nextDueAt } from '../../src/store';
import { T0, accountWrite, withStore } from './helpers';

test('scheduled sends are in sub_due and fall under the overdue rule like queued ones (FR-2)', () => {
  withStore((store, file) => {
    store.commit({ opId: 'setup', origin: 'sync', writes: [accountWrite] });
    // The outbox writes submissions through its own commit extension; a second connection stands in for it here.
    const db = file.open();
    const insert = db.prepare(
      `INSERT INTO submissions(id, draft_id, account_id, internet_id, not_before, state) VALUES(?, ?, 'acct-1', ?, ?, ?)`,
    );
    const min = 60_000;
    insert.run('undo', 'd1', '<1@mail.example>', T0 - 1 * min, 'queued');
    insert.run('later-off', 'd2', '<2@mail.example>', T0 - 3 * 24 * 60 * min, 'scheduled');
    insert.run('later-now', 'd3', '<3@mail.example>', T0 - 2 * min, 'scheduled');
    insert.run('later-future', 'd4', '<4@mail.example>', T0 + 60 * min, 'scheduled');
    insert.run('in-flight', 'd5', '<5@mail.example>', T0 - 60 * min, 'sending');
    db.close();

    const { due, overdue } = store.read(q => dueSubmissions(q, T0));
    assert.deepEqual(
      due.map(s => s.id),
      ['later-now', 'undo'],
    );
    assert.deepEqual(
      overdue.map(s => [s.id, s.state]),
      [['later-off', 'scheduled']],
      'a send-later row that fell due while the Mac was off is suspended, not sent days late',
    );
    assert.equal(store.read(nextDueAt), T0 - 3 * 24 * 60 * min);
    for (const [name, sql] of Object.entries(DUE_QUERIES)) {
      const plan = store.read(q =>
        q.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...(name === 'due' ? [T0] : [])),
      );
      assert.ok(
        plan.some(r => String(r.detail).includes('sub_due')),
        `${name} uses sub_due: ${plan.map(r => r.detail).join('; ')}`,
      );
    }
  });
});
