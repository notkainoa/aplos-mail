import test from 'node:test';
import assert from 'node:assert/strict';
import type { EngineServices } from '../../src/runtime/services';
import type { StorePort, StoreWrite } from '../../src/store';
// What `views/module.ts` loads at engine start: installs the row builder `indexWritten` calls.
import {
  FTS_BATCH,
  FTS_BODY_CAP,
  FTS_HTML_SCAN,
  htmlText,
  indexBacklog,
} from '../../src/store/fts-indexer';
import { openStore } from '../../src/store';
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb, withStore } from './helpers';

/*
 * The search index (fix-search, 2026-11-12). Before this, no commit wrote `messages_fts`, so every word search on the
 * real engine answered nothing. Each commit now indexes what it writes; mail stored before that is the backlog that
 * `ftsIndex` writes index in batches.
 */

let n = 0;
const commit = (store: StorePort, writes: StoreWrite[], origin: 'sync' | 'system' = 'sync') =>
  store.commit({ opId: `fts-${++n}`, origin, writes });
const setup = (store: StorePort) => commit(store, [accountWrite, ...folderWrites], 'system');
const rows = (store: StorePort) =>
  store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM messages_fts_docsize')!.n);
const bits = (store: StorePort) =>
  store.read(
    q => q.get<{ n: number }>('SELECT count(*) AS n FROM messages WHERE (parts & 8) <> 0')!.n,
  );
const hits = (store: StorePort, match: string) =>
  store.read(q =>
    q
      .all<{ remote_id: string }>(
        `SELECT m.remote_id FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ?
        ORDER BY m.remote_id`,
        match,
      )
      .map(r => r.remote_id),
  );

test('a message is indexed in the commit that stores it: subject, people and snippet', () => {
  withStore(store => {
    setup(store);
    commit(store, [
      msg('m1', 't1', 1, {
        subject: 'Reservation confirmed',
        from: { address: 'automated@airbnb.example', name: 'Airbnb' },
        cc: [{ address: 'friend@mail.example', name: 'Robin Lee' }],
        snippet: 'Check-in is at three',
      }),
    ]);
    assert.equal(rows(store), 1);
    assert.equal(bits(store), 1);
    assert.deepEqual(hits(store, 'reservation'), ['m1']);
    assert.deepEqual(
      hits(store, 'people : airbnb'),
      ['m1'],
      'the sender address, split at @ and dots',
    );
    assert.deepEqual(hits(store, 'people : robin'), ['m1'], 'cc names');
    assert.deepEqual(
      hits(store, 'body : "check-in"'),
      ['m1'],
      'the snippet stands in for the body',
    );
  });
});

test('a body replaces the snippet in the index; an HTML-only body is indexed as its visible text', () => {
  withStore(store => {
    setup(store);
    commit(store, [msg('m1', 't1', 1), msg('m2', 't2', 2)]);
    commit(store, [
      {
        kind: 'body',
        accountId: ACCOUNT,
        remoteId: 'm1',
        body: { text: 'The pineapple order shipped' },
      },
      {
        kind: 'body',
        accountId: ACCOUNT,
        remoteId: 'm2',
        body: { html: '<style>.mango{}</style><p>Your <b>papaya</b>&nbsp;box</p>' },
      },
    ]);
    assert.equal(rows(store), 2, 'one row per message, never a second');
    assert.deepEqual(hits(store, 'pineapple'), ['m1']);
    assert.deepEqual(hits(store, 'Snippet'), [], 'the snippet row was replaced');
    assert.deepEqual(hits(store, 'papaya'), ['m2']);
    assert.deepEqual(hits(store, 'mango'), [], 'style text is not indexed');
  });
});

test('a write that changes the subject re-indexes; one that changes nothing indexed keeps the row', () => {
  withStore(store => {
    setup(store);
    commit(store, [msg('m1', 't1', 1, { subject: 'Old words' })]);
    commit(store, [msg('m1', 't1', 1, { subject: 'New words' })]);
    assert.deepEqual(hits(store, 'old'), []);
    assert.deepEqual(hits(store, 'new'), ['m1']);
    assert.equal(rows(store), 1);
    commit(store, [
      msg('m1', 't1', 1, {
        subject: 'New words',
        flags: { seen: true, flagged: false, draft: false, fromMe: false },
      }),
    ]);
    assert.deepEqual(hits(store, 'new'), ['m1']);
    commit(store, [{ kind: 'messageDelete', accountId: ACCOUNT, remoteId: 'm1' }]);
    assert.equal(rows(store), 0, 'a deleted message leaves the index');
  });
});

/** A store on a temp file for an async test (`withStore` closes it when its callback returns). */
async function withAsyncStore(
  fn: (store: StorePort, file: ReturnType<typeof tempDb>) => Promise<void>,
) {
  const file = tempDb();
  const store = openStore(file.open());
  try {
    await fn(store, file);
  } finally {
    store.close();
    file.cleanup();
  }
}

/** The services the start-up backlog pass uses, with a log that records event names and reasons only. */
function backlogServices(store: StorePort, events: string[]) {
  return {
    store,
    clock: { sleep: async () => {} },
    randomBytes: (k: number) => globalThis.crypto.getRandomValues(new Uint8Array(k)),
    log: {
      event: (name: string, data: { reason?: string }) => events.push(`${name}:${data.reason}`),
    },
  } as unknown as EngineServices;
}
const pass = (store: StorePort, events: string[] = []) =>
  indexBacklog(backlogServices(store, events), new AbortController().signal);

/** The owner's store as the old engine left it: messages, no index rows, no bits. */
function stripIndex(file: ReturnType<typeof tempDb>) {
  const raw = file.open();
  raw.exec(
    "INSERT INTO messages_fts(messages_fts) VALUES('delete-all'); UPDATE messages SET parts = parts & ~8",
  );
  raw.close();
}

/** Indexing this message fails: setting its bit raises, after the indexer already inserted its FTS row. */
function failIndexing(file: ReturnType<typeof tempDb>, remoteId: string) {
  const raw = file.open();
  raw.exec(`CREATE TRIGGER fts_fails BEFORE UPDATE OF parts ON messages
    WHEN NEW.remote_id = '${remoteId}' AND (NEW.parts & 8) <> 0 BEGIN SELECT RAISE(ABORT, 'refused'); END`);
  raw.close();
}

const many = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    msg(`m${i}`, `t${i}`, i, { subject: `Order ${i} airbnb` }),
  );

test('the backlog pass indexes mail stored without index rows, a batch per commit, once', async () => {
  await withAsyncStore(async (store, file) => {
    setup(store);
    const count = FTS_BATCH + 7;
    commit(store, many(count));
    stripIndex(file);
    assert.equal(rows(store), 0);
    assert.deepEqual(hits(store, 'airbnb'), []);
    const seq = store.seq();
    const events: string[] = [];
    await pass(store, events);
    assert.equal(rows(store), count);
    assert.equal(bits(store), count);
    assert.equal(hits(store, 'airbnb').length, count);
    assert.equal(store.seq(), seq + 2, 'one commit per batch of FTS_BATCH');
    const marked = store.read(
      q =>
        q.get<{ n: number }>(
          "SELECT count(*) AS n FROM changes WHERE seq > ? AND type = 'Thread'",
          seq,
        )!.n,
    );
    assert.equal(marked, count, 'each thread is marked, so open search windows run again');
    assert.deepEqual(events, []);
    await pass(store, events);
    assert.equal(store.seq(), seq + 2, 'no backlog: no commit at all');
    assert.equal(rows(store), count, 'idempotent: no second row for any message');
  });
});

test('a message that cannot be indexed never fails its commit, and the backlog pass goes past it', async () => {
  await withAsyncStore(async (store, file) => {
    setup(store);
    failIndexing(file, 'bad');
    const done = commit(store, [msg('bad', 't-bad', 1), msg('good', 't-good', 2)]);
    assert.ok(done.changed > 0, 'the sync commit landed');
    const stored = store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM messages')!.n);
    assert.equal(stored, 2, 'both messages are stored');
    assert.equal(rows(store), 1, "the failed row's FTS insert was rolled back with it");
    assert.deepEqual(hits(store, 'subject'), ['good']);
    const bad = store.read(q =>
      q.get<{ parts: number }>("SELECT parts FROM messages WHERE remote_id = 'bad'"),
    );
    assert.equal(bad!.parts & 8, 0, 'its bit stays clear, so a later pass tries it again');

    commit(store, many(FTS_BATCH + 3));
    stripIndex(file);
    const events: string[] = [];
    await pass(store, events);
    assert.equal(rows(store), FTS_BATCH + 4, 'every other message is indexed');
    assert.deepEqual(events, ['rpc.failed:row'], 'logged once, by reason code only');
  });
});

test('a Bcc change re-indexes the message', () => {
  withStore(store => {
    setup(store);
    commit(store, [msg('m1', 't1', 1, { bcc: [{ address: 'quill@mail.example' }] })]);
    assert.deepEqual(hits(store, 'people : quill'), ['m1']);
    commit(store, [msg('m1', 't1', 1, { bcc: [{ address: 'heron@mail.example' }] })]);
    assert.deepEqual(hits(store, 'people : quill'), []);
    assert.deepEqual(hits(store, 'people : heron'), ['m1']);
    assert.equal(rows(store), 1);
  });
});

test('only the first 16 KB of a body is indexed', () => {
  withStore(store => {
    setup(store);
    commit(store, [msg('m1', 't1', 1)]);
    const text = `alpha ${'x '.repeat(FTS_BODY_CAP / 2)} zebra`;
    commit(store, [{ kind: 'body', accountId: ACCOUNT, remoteId: 'm1', body: { text } }]);
    assert.deepEqual(hits(store, 'alpha'), ['m1']);
    assert.deepEqual(hits(store, 'zebra'), [], 'past the cap');
  });
});

test('hostile HTML bodies index in linear time inside the commit', () => {
  withStore(store => {
    setup(store);
    const bodies = {
      lt: '<'.repeat(100_000),
      style: '<style '.repeat(20_000),
      script: `<script>${'<'.repeat(50_000)}`,
      huge: `<p>first</p>${'<b>x</b>'.repeat(300_000)}<p>last</p>`,
    };
    commit(
      store,
      Object.keys(bodies).map((k, i) => msg(k, `t-${k}`, i)),
    );
    for (const [remoteId, html] of Object.entries(bodies)) {
      const started = performance.now();
      commit(store, [{ kind: 'body', accountId: ACCOUNT, remoteId, body: { html } }]);
      const ms = performance.now() - started;
      assert.ok(ms < 500, `${remoteId}: ${Math.round(ms)} ms`);
    }
    assert.deepEqual(hits(store, 'first'), ['huge']);
    assert.deepEqual(hits(store, 'last'), [], 'past the HTML read bound');
  });
});

test('htmlText: tags, style and script content, entities, unclosed tails', () => {
  assert.equal(htmlText('<p>a&amp;b&nbsp;c &LT;d&gt;</p>').trim(), 'a&b c <d>');
  assert.equal(
    htmlText('x<style>.y{}</style>z<SCRIPT a>q()</SCRIPT >w').replace(/ +/g, ' '),
    'x z w',
  );
  assert.equal(htmlText('keep<style>never closed').trim(), 'keep');
  assert.equal(htmlText('keep <b unclosed tag').trim(), 'keep');
  assert.equal(htmlText(`a${' '.repeat(FTS_HTML_SCAN)}tail`).includes('tail'), false);
});
