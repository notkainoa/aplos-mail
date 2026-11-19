import test from 'node:test';
import assert from 'node:assert/strict';
import { demoWrites } from '../../src/ai/demo/data';
import { loadDemo } from '../../src/ai/demo/load';
import { demoSentId, withDemoDelivery } from '../../src/ai/demo/send';
import { laneExtensions } from '../../src/index';
import type { SendPort } from '../../src/ports/engine';
import type { SubmissionPayload } from '../../src/ports/provider';
import { openStore } from '../../src/store';
import { ACCOUNT, T0, accountWrite, tempDb } from '../store/helpers';

/** ai-2: demo sends are filed in the demo account's own Sent folder; every other account reaches the real port. */

function world() {
  const file = tempDb();
  const db = file.open();
  const store = openStore(db, { now: () => T0, extensions: laneExtensions() });
  store.commit({ opId: 'real', origin: 'sync', writes: [{ ...accountWrite }] });
  loadDemo(store, 'demo-load', T0, demoWrites);
  const fields = {
    accountId: 'demo-work',
    mode: 'new',
    to: [{ address: 'reader@verification.example', name: 'Reader' }],
    cc: [],
    bcc: [{ address: 'hidden@verification.example' }],
    subject: 'Local demo send',
    html: '<p>Original <b>synthetic</b> text.</p>',
    attachments: [],
    signature: false,
  };
  db.prepare(
    'INSERT INTO drafts(id, account_id, revision, data, updated_at) VALUES(?, ?, 1, ?, ?)',
  ).run('draft-1', 'demo-work', JSON.stringify(fields), T0);
  db.exec(
    `INSERT INTO submissions(id, draft_id, account_id, internet_id, not_before, state)
     VALUES('sub-1', 'draft-1', 'demo-work', '<sub-1@demo.example>', 0, 'sending')`,
  );
  const inner: string[] = [];
  const real: SendPort = {
    admission: account => (inner.push(`admission ${account}`), { ok: true }),
    send: async account => (inner.push(`send ${account}`), { acceptedAt: 1 }),
    findSent: async account => (
      inner.push(`findSent ${account}`),
      { kind: 'absent', checkedAt: 1 }
    ),
  };
  const port = withDemoDelivery(real, store, () => T0 + 5_000);
  const payload: SubmissionPayload = {
    submissionId: 'sub-1',
    internetId: '<sub-1@demo.example>',
    mime: new TextEncoder().encode('synthetic'),
    envelope: { from: 'alex@studio.example', rcpt: ['reader@verification.example'] },
  };
  return {
    store,
    port,
    inner,
    payload,
    cleanup: () => {
      store.close();
      file.cleanup();
    },
  };
}

test('a demo send is admitted and filed once in Sent as a complete thread; findSent finds it', async () => {
  const w = world();
  try {
    assert.deepEqual(w.port.admission('demo-work'), { ok: true });
    assert.equal(
      (await w.port.findSent('demo-work', w.payload.internetId, T0)).kind,
      'absent',
      'nothing is found before the send',
    );
    const receipt = await w.port.send('demo-work', w.payload);
    assert.deepEqual(receipt, {
      remoteMessageId: demoSentId('sub-1'),
      remoteThreadId: demoSentId('sub-1'),
      acceptedAt: T0 + 5_000,
    });
    // A retry after an uncertain attempt finds the copy it wrote; it never files a second one.
    assert.deepEqual(await w.port.send('demo-work', w.payload), receipt);
    const rows = w.store.read(q =>
      q.all<{ subject: string; snippet: string; complete: number; folder: string }>(
        `SELECT m.subject, m.snippet, t.complete, f.remote_id AS folder FROM messages m
         JOIN threads t ON t.id = m.thread_id
         JOIN message_folders mf ON mf.message_id = m.id JOIN folders f ON f.id = mf.folder_id
         WHERE m.internet_id = ?`,
        w.payload.internetId,
      ),
    );
    assert.deepEqual(
      rows.map(row => ({ ...row })),
      [
        {
          subject: 'Local demo send',
          snippet: 'Original synthetic text.',
          complete: 1,
          folder: 'SENT',
        },
      ],
    );
    assert.deepEqual(await w.port.findSent('demo-work', w.payload.internetId, T0), {
      kind: 'found',
      remoteMessageId: demoSentId('sub-1'),
      remoteThreadId: demoSentId('sub-1'),
    });
    assert.deepEqual(w.inner, [], 'a demo account never reaches the real port');
  } finally {
    w.cleanup();
  }
});

test('a reply from a demo account joins the thread it continues', async () => {
  const w = world();
  try {
    await w.port.send('demo-work', { ...w.payload, remoteThreadId: 'design' });
    const threads = w.store.read(q =>
      q.all<{ remote_id: string; n: number; complete: number }>(
        `SELECT t.remote_id, t.complete, count(m.id) AS n FROM threads t JOIN messages m ON m.thread_id = t.id
         WHERE t.account_id = 'demo-work' AND t.remote_id = 'design' GROUP BY t.id`,
      ),
    );
    assert.equal(threads.length, 1);
    assert.equal(threads[0].complete, 1);
    assert.ok(threads[0].n >= 2, 'the sent reply is in the design thread');
  } finally {
    w.cleanup();
  }
});

test('a real account goes to the real send port unchanged', async () => {
  const w = world();
  try {
    w.port.admission(ACCOUNT);
    await w.port.send(ACCOUNT, w.payload);
    await w.port.findSent(ACCOUNT, w.payload.internetId, T0);
    assert.deepEqual(w.inner, [`admission ${ACCOUNT}`, `send ${ACCOUNT}`, `findSent ${ACCOUNT}`]);
  } finally {
    w.cleanup();
  }
});
