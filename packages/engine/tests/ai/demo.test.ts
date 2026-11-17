import test from 'node:test';
import assert from 'node:assert/strict';
import type { LogRecord } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { DEMO_ACCOUNTS } from '../../src/ai/demo/data';
import { DEMO_ACCOUNT_IDS } from '../../src/ai/demo/load';
import { accountIds } from '../../src/sync/account-read';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import type { Caller } from '../../src/methods/types';
import { openStore, StoreError, type StorePort } from '../../src/store';
import { manualClock, silentDeadlines } from '../runtime.helpers';
import { ACCOUNT, T0, accountWrite, folderWrites, msg, tempDb } from '../store/helpers';

/**
 * ai-2's `Demo/*` over the real store. Every call goes through the engine's dispatch as a window caller,
 * the way the real transports do; the raw SQLite handle only ever plants a `submissions` row for the
 * refused-while-sending check.
 */

async function demoEngine(wrapStore: (store: StorePort) => StorePort = s => s) {
  const file = tempDb();
  const db = file.open();
  const store = wrapStore(openStore(db, { now: () => T0, extensions: laneExtensions() }));
  const clock = manualClock();
  const records: LogRecord[] = [];
  const log = createLogger({ sink: { write: r => records.push(r) }, salt: 'demo-test', clock });
  // The queue's own deadline never fires on its own here: demo-load's ingest-queued summary jobs stay queued,
  // so commit and seq counts are deterministic.
  const engine = await createEngine({ store, clock, log, ports: { deadlines: silentDeadlines() } });
  return {
    engine,
    store,
    db,
    window: () => engine.connect(),
    session: (caller: Caller) => engine.connect(caller),
    async cleanup() {
      await engine.close();
      store.close();
      file.cleanup();
    },
  };
}

const count = (store: StorePort, sql: string, ...params: (string | number)[]) =>
  store.read(q => q.get<{ n: number }>(sql, ...params)!.n);

/** Threads a folder lists (the `mailbox`/label views' source). */
const inFolder = (store: StorePort, accountId: string, remoteId: string) =>
  count(
    store,
    `SELECT count(*) AS n FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id
    WHERE f.account_id = ? AND f.remote_id = ?`,
    accountId,
    remoteId,
  );

const inStatus = (store: StorePort, accountId: string, status: string) =>
  count(
    store,
    `SELECT count(*) AS n FROM thread_workflow w JOIN threads t ON t.id = w.thread_id
    WHERE w.account_id = ? AND w.status = ?`,
    accountId,
    status,
  );

/** Every stored row of one account in the main tables, as comparable text ("byte-identical"). */
function rowsOf(store: StorePort, accountId: string) {
  return store.read(q => {
    const rows = (sql: string) => q.all(sql, accountId).map(r => JSON.stringify(r));
    return {
      threads: rows('SELECT * FROM threads WHERE account_id = ? ORDER BY id'),
      messages: rows('SELECT * FROM messages WHERE account_id = ? ORDER BY id'),
      folders: rows('SELECT * FROM folders WHERE account_id = ? ORDER BY id'),
      message_folders: q
        .all(
          `SELECT mf.* FROM message_folders mf JOIN messages m ON m.id = mf.message_id
          WHERE m.account_id = ? ORDER BY mf.message_id, mf.folder_id`,
          accountId,
        )
        .map(r => JSON.stringify(r)),
      bodies: q
        .all(
          `SELECT b.* FROM bodies b JOIN messages m ON m.id = b.message_id
          WHERE m.account_id = ? ORDER BY b.message_id`,
          accountId,
        )
        .map(r => JSON.stringify(r)),
      thread_workflow: rows(
        'SELECT * FROM thread_workflow WHERE account_id = ? ORDER BY thread_id',
      ),
      attachments: q
        .all(
          `SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
          WHERE m.account_id = ? ORDER BY a.id`,
          accountId,
        )
        .map(r => JSON.stringify(r)),
      correspondents: rows('SELECT * FROM correspondents WHERE account_id = ? ORDER BY address'),
      thread_folders: q
        .all(
          `SELECT tf.* FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id
          WHERE f.account_id = ? ORDER BY tf.folder_id, tf.last_date, tf.thread_id`,
          accountId,
        )
        .map(r => JSON.stringify(r)),
      // `draft`/`remoteDraft` and `submission` are eng-time kinds and its commit extension is not
      // registered yet, so no write can plant these rows today; hashed anyway, empty for now.
      drafts: rows('SELECT * FROM drafts WHERE account_id = ? ORDER BY id'),
      ops: rows('SELECT * FROM ops WHERE account_id = ? ORDER BY seq'),
      submissions: rows('SELECT * FROM submissions WHERE account_id = ? ORDER BY id'),
      sync_state: rows('SELECT * FROM sync_state WHERE account_id = ? ORDER BY scope'),
      sender_rules: rows('SELECT * FROM sender_rules WHERE account_id = ? ORDER BY id'),
    };
  });
}

/** The contract ids of an account's threads, folders and messages (`accountId:remoteId`). */
function contractIds(store: StorePort, accountId: string) {
  const ids = (sql: string) =>
    store.read(q => q.all<{ id: string }>(sql, accountId).map(r => r.id));
  return {
    accounts: store.read(q =>
      q.all<{ id: string }>('SELECT id FROM accounts WHERE id = ?', accountId).map(r => r.id),
    ),
    folders: ids(
      "SELECT account_id || ':' || remote_id AS id FROM folders WHERE account_id = ? ORDER BY id",
    ),
    threads: ids(
      "SELECT account_id || ':' || remote_id AS id FROM threads WHERE account_id = ? ORDER BY id",
    ),
    messages: ids(
      "SELECT account_id || ':' || remote_id AS id FROM messages WHERE account_id = ? ORDER BY id",
    ),
  };
}

/** A real (google) account with a few messages across folders, two bodies and a workflow edit. */
function plantReal(store: StorePort) {
  const important = {
    kind: 'folder' as const,
    accountId: ACCOUNT,
    remoteId: 'IMPORTANT',
    name: 'Important',
    role: 'important' as const,
    folderKind: 'system' as const,
  };
  store.commit({
    opId: 'real',
    origin: 'sync',
    writes: [
      accountWrite,
      ...folderWrites,
      important,
      msg('r1', 'rt1', 0, { folders: [{ folder: 'INBOX' }, { folder: 'IMPORTANT' }] }),
      msg('r2', 'rt1', 1, {
        folders: [{ folder: 'INBOX' }, { folder: 'Label_1' }],
        flags: { seen: true, flagged: true, draft: false, fromMe: false },
      }),
      msg('r3', 'rt2', 2, { folders: [{ folder: 'TRASH' }] }),
      msg('r4', 'rt3', 3, { folders: [{ folder: 'INBOX' }] }),
      { kind: 'body', accountId: ACCOUNT, remoteId: 'r1', body: { text: 'Real body one' } },
      { kind: 'body', accountId: ACCOUNT, remoteId: 'r2', body: { text: 'Real body two' } },
      {
        kind: 'workflow',
        accountId: ACCOUNT,
        remoteThreadId: 'rt1',
        patch: { status: 'done', todo: 'A real todo' },
      },
      {
        kind: 'attachments',
        accountId: ACCOUNT,
        remoteId: 'r1',
        list: [
          {
            remotePart: 'att-1',
            name: 'real-notes.txt',
            mime: 'text/plain',
            size: 64,
            inline: false,
          },
        ],
      },
      {
        kind: 'syncState',
        accountId: ACCOUNT,
        scope: 'mail',
        cursor: 'real-cursor',
        generation: 1,
      },
      {
        kind: 'op',
        opId: 'real-op-1',
        accountId: ACCOUNT,
        opKind: 'flag',
        targets: [`${ACCOUNT}:r4`],
        payload: '{}',
        effect: [{ kind: 'flags' as const, target: { remoteId: 'r4' }, flagged: true }],
        scope: 'triage',
      },
      // A rule on a domain none of the planted senders uses: the row exists without touching workflow.
      {
        kind: 'senderRule',
        op: 'put' as const,
        accountId: ACCOUNT,
        match: '@real-rules.example',
        action: 'block' as const,
      },
    ],
  });
}

const is = (type: string) => (e: unknown) => e instanceof ContractError && e.type === type;

// ------------------------------------------------------------ the empty start and Demo/load

test('a fresh store has zero accounts and no demo data, and nothing loads by itself', async () => {
  const t = await demoEngine();
  try {
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM accounts'), 0);
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM threads'), 0);
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM messages'), 0);
    assert.equal(count(t.store, "SELECT count(*) AS n FROM accounts WHERE provider = 'demo'"), 0);
    const gone = (await t.window().call('Demo/remove', {})) as { opId: string };
    assert.equal(gone.opId, 'demo-remove-noop', 'removing an absent demo commits nothing');
    assert.equal(t.store.seq(), 0, 'no commit was written');
  } finally {
    await t.cleanup();
  }
});

test('the fixed demo ids in load.ts match the dataset, which is only read when Demo/load runs', async () => {
  assert.deepEqual(
    DEMO_ACCOUNTS.map(account => account.id),
    [...DEMO_ACCOUNT_IDS],
    'load.ts keeps the ids so the dataset module can stay lazy',
  );
  // A first run: the lazily loaded dataset still shows the whole demo mailbox.
  const t = await demoEngine();
  try {
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM threads'), 0);
    await t.window().call('Demo/load', {});
    assert.ok(
      count(t.store, 'SELECT count(*) AS n FROM threads') >= 18,
      'the demo mailbox is there',
    );
    assert.equal(count(t.store, "SELECT count(*) AS n FROM accounts WHERE provider = 'demo'"), 2);
  } finally {
    await t.cleanup();
  }
});

test('Demo/load commits two demo accounts and about 18 threads across every place', async () => {
  const t = await demoEngine();
  try {
    const out = (await t.window().call('Demo/load', {})) as { accountIds: string[] };
    assert.deepEqual(out.accountIds, [...DEMO_ACCOUNT_IDS]);
    const [work, personal] = DEMO_ACCOUNT_IDS;
    for (const id of DEMO_ACCOUNT_IDS) {
      assert.equal(
        count(t.store, 'SELECT count(*) AS n FROM threads WHERE account_id = ?', id) > 0,
        true,
      );
    }
    // Every place: inbox, sent, done, later, starred, trash, spam, archive and a user label.
    assert.equal(inFolder(t.store, work, 'INBOX'), 3);
    assert.equal(inFolder(t.store, personal, 'INBOX'), 5);
    assert.equal(inFolder(t.store, work, 'SENT'), 1);
    assert.equal(inStatus(t.store, work, 'done'), 2);
    assert.equal(inStatus(t.store, personal, 'done'), 2);
    assert.equal(inStatus(t.store, work, 'later'), 3);
    assert.equal(inStatus(t.store, personal, 'later'), 1);
    assert.equal(
      count(t.store, 'SELECT count(*) AS n FROM threads WHERE flagged = 1'),
      3,
      'starred',
    );
    assert.equal(inFolder(t.store, work, 'TRASH'), 1);
    assert.equal(inFolder(t.store, personal, 'SPAM'), 1);
    assert.equal(inFolder(t.store, personal, 'ARCHIVE'), 1);
    assert.equal(inFolder(t.store, work, 'label-projects'), 4);
    assert.equal(inFolder(t.store, personal, 'label-friends'), 3);
    assert.equal(inFolder(t.store, work, 'IMPORTANT'), 1);
    assert.equal(inFolder(t.store, personal, 'IMPORTANT'), 1);
    // Read and unread, bodies, attachments and the one draft.
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM threads WHERE unread_count > 0'), 10);
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM messages'), 20);
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM bodies'), 20);
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM attachments'), 2);
    assert.equal(
      count(t.store, 'SELECT count(*) AS n FROM messages WHERE (flags & 8) <> 0'),
      1,
      'the draft message',
    );
    assert.equal(
      count(
        t.store,
        `SELECT count(*) AS n FROM message_folders mf JOIN folders f ON f.id = mf.folder_id
        WHERE f.remote_id = 'DRAFTS'`,
      ),
      1,
    );
  } finally {
    await t.cleanup();
  }
});

test('the demo accounts list in one stable order, each with a colour tag the app draws', async () => {
  const t = await demoEngine();
  try {
    await t.window().call('Demo/load', {});
    assert.deepEqual(
      accountIds(t.store),
      [...DEMO_ACCOUNT_IDS],
      'creation order, not alphabetical',
    );
    assert.deepEqual(
      DEMO_ACCOUNTS.map(a => a.colorTag),
      ['sky', 'sand'],
    );
  } finally {
    await t.cleanup();
  }
});

test('Demo/load is idempotent: a second call adds nothing and bumps nothing', async () => {
  const t = await demoEngine();
  try {
    const s = t.window();
    const first = (await s.call('Demo/load', {})) as {
      accountIds: string[];
      receipt: { opId: string };
    };
    assert.equal(
      count(t.store, 'SELECT count(*) AS n FROM commits WHERE op_id = ?', first.receipt.opId),
      1,
      'the receipt names the commit that applied the load',
    );
    const seq = t.store.seq();
    const counts = Object.fromEntries(
      ['accounts', 'folders', 'threads', 'messages', 'bodies', 'attachments'].map(table => [
        table,
        count(t.store, `SELECT count(*) AS n FROM ${table}`),
      ]),
    );
    const second = (await s.call('Demo/load', {})) as {
      accountIds: string[];
      receipt: { opId: string };
    };
    assert.deepEqual(second.accountIds, first.accountIds);
    assert.equal(second.receipt.opId, 'demo-load-noop', 'a no-op load names no commit');
    assert.equal(t.store.seq(), seq, 'a no-op call writes no commit');
    for (const [table, n] of Object.entries(counts))
      assert.equal(count(t.store, `SELECT count(*) AS n FROM ${table}`), n, table);
  } finally {
    await t.cleanup();
  }
});

test('Demo/load refuses while a real account holds a fixed demo id, leaving it unchanged', async () => {
  const t = await demoEngine();
  try {
    const id = DEMO_ACCOUNT_IDS[0];
    t.store.commit({
      opId: 'real-takes-demo-id',
      origin: 'sync',
      writes: [
        {
          kind: 'account',
          id,
          provider: 'google',
          address: 'real-owner@mail.example',
          capabilities: { labels: true },
          status: { state: 'ok' },
        },
      ],
    });
    await assert.rejects(t.window().call('Demo/load', {}), is('conflict'));
    const row = t.store.read(q =>
      q.get<{ provider: string; address: string }>(
        'SELECT provider, address FROM accounts WHERE id = ?',
        id,
      ),
    );
    assert.equal(row?.provider, 'google');
    assert.equal(row?.address, 'real-owner@mail.example');
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM accounts'), 1, 'no demo landed');
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM threads'), 0);
  } finally {
    await t.cleanup();
  }
});

test('Demo/load repairs a partial demo: survivors are replaced and the full set returns', async () => {
  const t = await demoEngine();
  try {
    await t.window().call('Demo/load', {});
    t.store.commit({
      opId: 'drop-personal',
      origin: 'local',
      writes: [{ kind: 'accountRemove', accountId: DEMO_ACCOUNT_IDS[1] }],
    });
    assert.equal(
      count(t.store, "SELECT count(*) AS n FROM accounts WHERE provider = 'demo'"),
      1,
      'one demo account is gone',
    );
    const out = (await t.window().call('Demo/load', {})) as { accountIds: string[] };
    assert.deepEqual(out.accountIds, [...DEMO_ACCOUNT_IDS]);
    assert.equal(
      count(t.store, 'SELECT count(*) AS n FROM threads WHERE account_id = ?', DEMO_ACCOUNT_IDS[0]),
      9,
    );
    assert.equal(
      count(t.store, 'SELECT count(*) AS n FROM threads WHERE account_id = ?', DEMO_ACCOUNT_IDS[1]),
      10,
    );
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM messages'), 20);
  } finally {
    await t.cleanup();
  }
});

// ------------------------------------------------------------ Demo/reset and Demo/remove

test('Demo/reset returns the same account and contract ids, Demo/remove deletes only demo rows', async () => {
  const t = await demoEngine();
  try {
    plantReal(t.store);
    const s = t.window();
    await s.call('Demo/load', {});
    const before = Object.fromEntries(DEMO_ACCOUNT_IDS.map(id => [id, contractIds(t.store, id)]));
    const reset = (await s.call('Demo/reset', {})) as { receipt: { opId: string } };
    assert.equal(
      count(t.store, 'SELECT count(*) AS n FROM commits WHERE op_id = ?', reset.receipt.opId),
      1,
      'the reset receipt names the reload commit',
    );
    for (const id of DEMO_ACCOUNT_IDS)
      assert.deepEqual(contractIds(t.store, id), before[id], `ids of ${id} stable`);
    const removed = (await s.call('Demo/remove', {})) as { opId: string };
    assert.equal(
      count(t.store, 'SELECT count(*) AS n FROM commits WHERE op_id = ?', removed.opId),
      1,
      'the remove receipt names its commit',
    );
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM accounts'), 1, 'only the real one');
    assert.equal(
      count(t.store, 'SELECT count(*) AS n FROM threads WHERE account_id = ?', ACCOUNT),
      3,
    );
    assert.equal(count(t.store, "SELECT count(*) AS n FROM accounts WHERE provider = 'demo'"), 0);
    // A fresh load after removal brings the demo back once.
    await s.call('Demo/load', {});
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM messages'), 20 + 4);
  } finally {
    await t.cleanup();
  }
});

test('Demo/reset is refused while a demo account has a send out, and works after it', async () => {
  const t = await demoEngine();
  try {
    await t.window().call('Demo/load', {});
    t.db.exec(
      `INSERT INTO submissions(id, draft_id, account_id, internet_id, not_before, state)
      VALUES('sub-1', 'draft-1', 'demo-work', '<x@demo.example>', 0, 'sending')`,
    );
    await assert.rejects(t.window().call('Demo/reset', {}), is('conflict'));
    assert.equal(
      count(t.store, 'SELECT count(*) AS n FROM threads WHERE account_id = ?', DEMO_ACCOUNT_IDS[0]),
      9,
      'nothing was removed',
    );
    t.db.exec("DELETE FROM submissions WHERE id = 'sub-1'");
    await t.window().call('Demo/reset', {});
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM messages'), 20);
  } finally {
    await t.cleanup();
  }
});

test('Demo/remove answers a typed conflict while a demo send is out, and the demo is untouched', async () => {
  const t = await demoEngine();
  try {
    await t.window().call('Demo/load', {});
    t.db.exec(
      `INSERT INTO submissions(id, draft_id, account_id, internet_id, not_before, state)
      VALUES('sub-1', 'draft-1', 'demo-work', '<x@demo.example>', 0, 'sending')`,
    );
    await assert.rejects(
      t.window().call('Demo/remove', {}),
      (e: unknown) =>
        e instanceof ContractError &&
        e.type === 'conflict' &&
        e.message === "Demo accounts can't be removed while a message is sending.",
    );
    assert.equal(
      count(t.store, "SELECT count(*) AS n FROM accounts WHERE provider = 'demo'"),
      2,
      'the demo was not removed',
    );
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM messages'), 20);
    t.db.exec("DELETE FROM submissions WHERE id = 'sub-1'");
    await t.window().call('Demo/remove', {});
    assert.equal(
      count(t.store, "SELECT count(*) AS n FROM accounts WHERE provider = 'demo'"),
      0,
      'the refusal was only while the send was out',
    );
  } finally {
    await t.cleanup();
  }
});

/** A store whose `commit` throws on the next `armed.n` commits that are not the reset's remove commit. */
const bombLoad = (
  store: StorePort,
  armed: { n: number },
  fail: () => Error = () => new StoreError('invalid', 'planted reload failure'),
): StorePort => ({
  ...store,
  commit: input => {
    if (armed.n > 0 && input.writes.some(w => w.kind !== 'accountRemove')) {
      armed.n--;
      throw fail();
    }
    return store.commit(input);
  },
});

test('Demo/reset retries a failed reload once and still lands the demo', async () => {
  const armed = { n: 0 };
  const t = await demoEngine(store => bombLoad(store, armed));
  try {
    const s = t.window();
    await s.call('Demo/load', {});
    armed.n = 1;
    const reset = (await s.call('Demo/reset', {})) as { receipt: { opId: string } };
    assert.equal(armed.n, 0, 'the first reload failed');
    assert.equal(
      count(t.store, 'SELECT count(*) AS n FROM commits WHERE op_id = ?', reset.receipt.opId),
      1,
      'the receipt names the commit the retry landed',
    );
    assert.equal(count(t.store, "SELECT count(*) AS n FROM accounts WHERE provider = 'demo'"), 2);
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM messages'), 20);
  } finally {
    await t.cleanup();
  }
});

test('Demo/reset reports the empty demo when the reload keeps failing, and Demo/load restores it', async () => {
  const armed = { n: 0 };
  const t = await demoEngine(store => bombLoad(store, armed));
  try {
    const s = t.window();
    await s.call('Demo/load', {});
    armed.n = 2;
    await assert.rejects(
      s.call('Demo/reset', {}),
      (e: unknown) =>
        e instanceof ContractError &&
        e.type === 'internal' &&
        e.message === 'The demo is empty after a failed reset. Demo/load restores it.',
    );
    assert.equal(
      count(t.store, "SELECT count(*) AS n FROM accounts WHERE provider = 'demo'"),
      0,
      'the remove committed and both reloads failed: no demo accounts are left',
    );
    await s.call('Demo/load', {});
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM messages'), 20);
  } finally {
    await t.cleanup();
  }
});

test('Demo/reset does not retry what is not a failed commit: a refusal or a bug surfaces as itself', async () => {
  for (const planted of [
    new ContractError({ type: 'conflict', message: 'planted refusal' }),
    new TypeError('planted bug'),
  ]) {
    const armed = { n: 0 };
    const t = await demoEngine(store => bombLoad(store, armed, () => planted));
    try {
      const s = t.window();
      await s.call('Demo/load', {});
      armed.n = 5;
      await assert.rejects(s.call('Demo/reset', {}));
      assert.equal(armed.n, 4, `${planted.name}: the reload was attempted once, not retried`);
    } finally {
      await t.cleanup();
    }
  }
});

// ------------------------------------------------------------ demo touches real data

test('the demo never touches a real account: rows stay byte-identical across load, reset and remove', async () => {
  const t = await demoEngine();
  try {
    plantReal(t.store);
    const before = rowsOf(t.store, ACCOUNT);
    const s = t.window();
    await s.call('Demo/load', {});
    assert.deepEqual(rowsOf(t.store, ACCOUNT), before, 'after load');
    await s.call('Demo/reset', {});
    assert.deepEqual(rowsOf(t.store, ACCOUNT), before, 'after reset');
    await s.call('Demo/remove', {});
    assert.deepEqual(rowsOf(t.store, ACCOUNT), before, 'after remove');
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM accounts'), 1);
    await s.call('Demo/load', {});
    assert.deepEqual(rowsOf(t.store, ACCOUNT), before, 'after the reload');
  } finally {
    await t.cleanup();
  }
});

// ------------------------------------------------------------ data hygiene and access

test('every address and domain in the demo dataset is .example', async () => {
  const t = await demoEngine();
  try {
    await t.window().call('Demo/load', {});
    const texts = t.store.read(q =>
      [
        ...q
          .all<{ v: string }>(
            'SELECT address AS v FROM accounts UNION ALL SELECT display_name FROM accounts',
          )
          .map(r => r.v),
        ...q
          .all<{ v: string }>(
            `SELECT m.from_addr AS v FROM messages m UNION ALL SELECT m.to_json FROM messages m
            UNION ALL SELECT m.cc_json FROM messages m UNION ALL SELECT m.internet_id FROM messages m
            UNION ALL SELECT m.list_unsub FROM messages m`,
          )
          .map(r => r.v),
        ...q
          .all<{ v: Uint8Array | string }>(
            'SELECT b.data AS v FROM bodies b JOIN messages m ON m.id = b.message_id',
          )
          .map(r => (typeof r.v === 'string' ? r.v : Buffer.from(r.v).toString('utf8'))),
      ].join('\n'),
    );
    const domains = new Set(
      [...texts.matchAll(/@([a-z0-9.-]+\.[a-z]{2,})/gi)].map(m => m[1]!.toLowerCase()),
    );
    for (const d of domains) assert.ok(d.endsWith('.example'), `domain ${d}`);
    assert.ok(domains.size > 3, 'the scan really found addresses');
    const hosts = new Set(
      [...texts.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map(m => m[1]!.toLowerCase()),
    );
    for (const h of hosts) assert.ok(h.endsWith('.example'), `host ${h}`);
  } finally {
    await t.cleanup();
  }
});

test('Demo/load seeds a calendar per account and sample events across the next two weeks', async () => {
  const t = await demoEngine();
  try {
    await t.window().call('Demo/load', {});
    const { list: calendars } = (await t.window().call('Calendar/get', {})) as {
      list: { accountId: string; shown: boolean; readOnly: boolean }[];
    };
    assert.deepEqual(calendars.map(c => c.accountId).sort(), [...DEMO_ACCOUNT_IDS].sort());
    assert.ok(
      calendars.every(c => c.shown && c.readOnly),
      'shown, and read-only: nothing to write to',
    );
    const win = (await t.window().call('View/watch', {
      spec: { kind: 'events', from: T0 - 7 * 86_400_000, to: T0 + 15 * 86_400_000 },
    })) as {
      ids: string[];
    };
    type Time = { type: string; utc?: number };
    const { list: events } = (await t.window().call('Event/get', { ids: [...win.ids] })) as {
      list: { title: string; allDay: boolean; start: Time; end: Time }[];
    };
    assert.ok(events.length >= 6, 'events on this week and next week');
    assert.ok(
      events.some(e => e.allDay),
      'one all-day event',
    );
    const timed = events.filter(e => !e.allDay);
    const ms = (v: Time) => (v.type === 'utc' ? (v.utc ?? 0) : 0);
    const overlaps = timed.some(a =>
      timed.some(b => a !== b && ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end)),
    );
    assert.ok(overlaps, 'one overlapping pair');
    assert.ok(events.every(e => e.title.length > 0));
    await t.window().call('Demo/remove', {});
    assert.equal(
      count(t.store, 'SELECT count(*) AS n FROM events'),
      0,
      'removing the demo takes its events',
    );
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM calendars'), 0);
  } finally {
    await t.cleanup();
  }
});

test('a listener without admin scope is refused Demo/load through dispatch', async () => {
  const t = await demoEngine();
  try {
    const reader = t.session({ kind: 'listener', via: 'socket', clientId: 'c1', scopes: ['read'] });
    await assert.rejects(reader.call('Demo/load', {}), is('forbidden'));
    await assert.rejects(reader.call('Demo/remove', {}), is('forbidden'));
    const mcp = t.session({ kind: 'listener', via: 'mcp', clientId: 'c2', scopes: ['admin'] });
    await assert.rejects(mcp.call('Demo/load', {}), is('forbidden'));
    assert.equal(count(t.store, 'SELECT count(*) AS n FROM accounts'), 0, 'nothing ran');
  } finally {
    await t.cleanup();
  }
});
