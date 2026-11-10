import assert from 'node:assert/strict';
import test from 'node:test';
import { listenerCaller } from '@aplos/contract/access';
import type { EngineMethodName, Input, Output } from '@aplos/contract';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import type { BlobFiles, BlobHeader } from '../../src/ports';
import { openStore, type StorePort } from '../../src/store';
import { manualClock } from '../runtime.helpers';
import { tempDb } from './helpers';

/**
 * `Data/export` on the real engine (eng-store). The export is the owner's own data as JSON; the rules that
 * matter are FR-6's: `uiOnly` keeps it off the listener entirely and the blob it returns is bound to the
 * calling principal, so a read-scoped MCP or socket client can neither ask for it nor read it after.
 */

function memoryFiles() {
  const stored = new Map<string, { header: BlobHeader; bytes: Uint8Array }>();
  const files: BlobFiles = {
    async put(id, header, bytes) {
      stored.set(id, { header: { ...header }, bytes: bytes.slice() });
    },
    async get(id) {
      const entry = stored.get(id);
      return entry && { header: { ...entry.header }, bytes: entry.bytes.slice() };
    },
    async remove(id) {
      stored.delete(id);
    },
    async list() {
      return [...stored].map(([id, entry]) => ({ id, header: entry.header, mtimeMs: 0 }));
    },
    async usage() {
      return [...stored.values()].reduce((n, e) => n + e.bytes.byteLength, 0);
    },
  };
  return { files, stored };
}

/** A token hash that must never reach an export. */
const TOKEN_CANARY = 'hash-of-deadbeef-token';

async function world() {
  const file = tempDb();
  const clock = manualClock();
  const store: StorePort = openStore(file.open(), {
    now: () => clock.now(),
    extensions: laneExtensions(),
  });
  const log = createLogger({ sink: { write: () => undefined }, salt: 'export-test', clock });
  const blobs = memoryFiles();
  const engine = await createEngine({ store, clock, log, ports: { blobFiles: blobs.files } });
  const db = file.open();
  const session = engine.connect();
  const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
    session.call(method, args) as Promise<Output<M>>;
  const asClient = (id: string, scopes: string[]) =>
    engine.connect(listenerCaller({ id, kind: 'cli', scopes }, 'socket') as never);
  return { engine, store, clock, db, call, asClient };
}

interface Exported {
  format: string;
  version: number;
  exportedAt: number;
  settings: Record<string, unknown>;
  accounts: Record<string, unknown>[];
  workflow: Record<string, unknown>[];
  drafts: { data: Record<string, unknown> }[];
  conversations: Record<string, unknown>[];
}

function seed(db: ReturnType<ReturnType<typeof tempDb>['open']>) {
  db.prepare(
    `INSERT INTO accounts(id, provider, address, display_name, capabilities, granted_scopes, status,
       ai_allowed, settings, created_at, updated_at)
     VALUES('a1', 'google', 'owner@mail.example', 'The Owner', '{"labels":true}', '["scope.a"]',
       'ok', 1, '{"signature":"mine"}', 10, 11)`,
  ).run();
  db.prepare('INSERT INTO settings(id, data) VALUES(1, ?)').run('{"ui":{"theme":"paper"}}');
  db.prepare(
    `INSERT INTO threads(id, account_id, remote_id, subject, last_date, msg_count, unread_count,
       flagged, has_attach, complete, rev)
     VALUES(7, 'a1', 't-remote-7', 'Hello', 20, 1, 0, 0, 0, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO thread_workflow(thread_id, account_id, sync_key, status, lane, importance, due_band,
       reminder_at, last_date)
     VALUES(7, 'a1', 'thread:t-remote-7', 'later', 'do', 'normal', 3, 1_900_000_000_000, 20)`,
  ).run();
  db.prepare(
    `INSERT INTO drafts(id, account_id, thread_id, revision, data, updated_at)
     VALUES('d1', 'a1', 7, 2, ?, 30)`,
  ).run('{"to":["friend@mail.example"],"subject":"hi","body":"draft text"}');
  db.prepare(
    `INSERT INTO conversations(id, pos, data) VALUES('conv-1', 1, '{"turns":[{"role":"user","text":"q?"}]}')`,
  ).run();
  // Planted rows the export must NOT carry: a client token hash, audit targets, message content tables.
  db.prepare(
    `INSERT INTO clients(id, name, kind, token_hash, scopes, created_at) VALUES('c1', 'tool', 'cli', ?, '[]', 1)`,
  ).run(TOKEN_CANARY);
  // Credential-adjacent account fields the column list deliberately excludes.
  db.prepare('UPDATE accounts SET oauth_client = ?, status_detail = ? WHERE id = ?').run(
    'oauth-client-secret-canary',
    'provider said: refresh canary-token refused',
    'a1',
  );
  db.prepare(
    `INSERT INTO messages(id, account_id, thread_id, remote_id, subject, date, internal_date, flags,
       first_seen_seq, rev) VALUES(5, 'a1', 7, 'm5', 'mail subject stays', 20, 20, 0, 1, 1)`,
  ).run();
}

test('the export blob carries the owner data, parsed JSON columns and no credential or mail tables', async () => {
  const w = await world();
  try {
    seed(w.db);
    const out = await w.call('Data/export', {});
    assert.equal(out.name, 'aplos-data.json');
    const got = await w.call('Blob/get', { blobId: out.blobId });
    const doc = JSON.parse(new TextDecoder().decode(got.bytes)) as Exported;
    assert.equal(doc.format, 'aplos-data-export');
    assert.equal(doc.version, 1);
    assert.equal(doc.exportedAt, w.clock.now());
    assert.deepEqual(doc.settings, { ui: { theme: 'paper' } });
    assert.equal(doc.accounts.length, 1);
    assert.equal(doc.accounts[0]!.address, 'owner@mail.example');
    assert.deepEqual(doc.accounts[0]!.capabilities, { labels: true });
    assert.deepEqual(doc.accounts[0]!.granted_scopes, ['scope.a']);
    assert.equal(doc.workflow.length, 1);
    assert.equal(doc.workflow[0]!.thread_remote_id, 't-remote-7');
    assert.equal(doc.workflow[0]!.status, 'later');
    assert.equal(doc.drafts.length, 1);
    assert.deepEqual(doc.drafts[0]!.data.to, ['friend@mail.example']);
    assert.equal(doc.conversations.length, 1);
    const text = JSON.stringify(doc);
    assert.equal(text.includes(TOKEN_CANARY), false, 'a token hash reached the export');
    assert.equal(text.includes('mail subject stays'), false, 'message rows are not in the export');
    assert.equal(text.includes('token_hash'), false);
    assert.equal(text.includes('oauth-client-secret-canary'), false, 'oauth_client stayed out');
    assert.equal(text.includes('canary-token'), false, 'status_detail stayed out');
  } finally {
    await w.engine.close();
  }
});

test('a listener can neither call Data/export nor read the blob it made; an mcp client neither', async () => {
  const w = await world();
  try {
    seed(w.db);
    const out = await w.call('Data/export', {});
    for (const caller of [
      w.asClient('c1', ['read', 'draft', 'admin']),
      w.engine.connect(
        listenerCaller({ id: 'c2', kind: 'mcp', scopes: ['read', 'admin'] }, 'mcp') as never,
      ),
    ]) {
      await assert.rejects(
        caller.call('Data/export', {}),
        (e: { type?: string }) => e.type === 'forbidden',
        'uiOnly keeps the method off the listener whatever the grant',
      );
      await assert.rejects(
        caller.call('Blob/get', { blobId: out.blobId }),
        (e: { type?: string }) => e.type === 'notFound',
        'the export blob answers another principal like an unknown id',
      );
    }
  } finally {
    await w.engine.close();
  }
});

test('an export over the blob ceiling gzip-compresses into .json.gz and still round-trips', async () => {
  const w = await world();
  try {
    const big = 'x'.repeat(26 * 1024 * 1024);
    w.db
      .prepare(`INSERT INTO conversations(id, pos, data) VALUES('big', 2, ?)`)
      .run(JSON.stringify({ turns: [{ role: 'user', text: big }] }));
    const out = await w.call('Data/export', {});
    assert.equal(out.name, 'aplos-data.json.gz');
    const got = await w.call('Blob/get', { blobId: out.blobId });
    assert.ok(got.bytes.byteLength < 1024 * 1024, 'a repetitive export compresses hard');
    const doc = JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(
          await new Response(
            new Blob([got.bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
          ).arrayBuffer(),
        ),
      ),
    ) as Exported;
    assert.equal(doc.format, 'aplos-data-export');
    assert.equal(
      (doc.conversations[0]!.data as { turns: { text: string }[] }).turns[0]!.text.length,
      big.length,
    );
  } finally {
    await w.engine.close();
  }
});

test('account colour and notification switches ride along', async () => {
  const w = await world();
  try {
    w.db
      .prepare(
        `INSERT INTO accounts(id, provider, address, capabilities, status, color_tag, notifications,
           created_at, updated_at)
         VALUES('a2', 'google', 'owner@mail.example', '{}', 'ok', 'rose', 0, 1, 1)`,
      )
      .run();
    const out = await w.call('Data/export', {});
    const got = await w.call('Blob/get', { blobId: out.blobId });
    const doc = JSON.parse(new TextDecoder().decode(got.bytes)) as Exported;
    assert.equal(doc.accounts[0]!.color_tag, 'rose');
    assert.equal(doc.accounts[0]!.notifications, 0);
    assert.ok(Array.isArray((doc as { notes?: string[] }).notes));
  } finally {
    await w.engine.close();
  }
});

test('an empty store still exports a well-formed document', async () => {
  const w = await world();
  try {
    const out = await w.call('Data/export', {});
    const got = await w.call('Blob/get', { blobId: out.blobId });
    const doc = JSON.parse(new TextDecoder().decode(got.bytes)) as Exported;
    assert.deepEqual(doc.accounts, []);
    assert.deepEqual(doc.settings, {});
    assert.deepEqual(doc.workflow, []);
  } finally {
    await w.engine.close();
  }
});
