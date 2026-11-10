import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDiagnosticsBundle } from '@aplos/contract';
import type { DiagnosticsBundle, EngineMethodName, Input, Output } from '@aplos/contract';
import { listenerCaller } from '@aplos/contract/access';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import type { BlobFiles, BlobHeader } from '../../src/ports';
import { openStore, type StorePort } from '../../src/store';
import { manualClock } from '../runtime.helpers';
import { tempDb } from '../store/helpers';

/**
 * `Diagnostics/preview|export|verbose` on the real engine (eng-host). The whole point of the bundle is redaction:
 * these tests seed canaries shaped like mail text, addresses and provider keys into every field the builder could
 * touch, and assert none survive — a leak here is exactly the failure FR-32 froze the strict schema for.
 */

/** An in-memory `BlobFiles` with the host's contract: a copy in, a fresh copy out per `get`. */
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

const CANARY = {
  address: 'secret.person@private.example',
  subject: 'CANARY-SUBJECT-8f31b2',
  key: 'gsk_canaryKEYabc123456789',
  token: 'ya29.canaryTOKENxyz987654',
};

async function world() {
  const file = tempDb();
  const clock = manualClock();
  const store: StorePort = openStore(file.open(), {
    now: () => clock.now(),
    extensions: laneExtensions(),
  });
  const log = createLogger({ sink: { write: () => undefined }, salt: 'diag-test', clock });
  const blobs = memoryFiles();
  const engine = await createEngine({
    store,
    clock,
    log,
    ports: { blobFiles: blobs.files },
    host: {
      appVersion: '9.9.9-test',
      device: { id: 'dev-1', name: 'Test Mac' },
      resident: false,
      capabilities: {},
    },
  });
  const db = file.open();
  const window = engine.connect();
  const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
    window.call(method, args) as Promise<Output<M>>;
  const asClient = (id: string, scopes: string[]) =>
    engine.connect(listenerCaller({ id, kind: 'cli', scopes }, 'http') as never);
  return { engine, store, clock, db, blobs, call, asClient };
}

/** Seeds an account whose every free field is a canary, plus mail content and a poison row. */
function seedCanaries(db: ReturnType<ReturnType<typeof tempDb>['open']>) {
  db.prepare(
    `INSERT INTO accounts(id, provider, address, display_name, capabilities, status, status_reason,
       status_reason_code, status_detail, refresh_expires_at, created_at, updated_at)
     VALUES('a-canary', 'google', ?, ?, '{}', 'paused', ?, 'auth.adminPolicy', ?, ?, 1, 1)`,
  ).run(CANARY.address, CANARY.subject, CANARY.subject, `oauth ${CANARY.token}`, 1_900_000_000_000);
  db.prepare(
    `INSERT INTO governor_state(account_id, budget, target, cooldown_until, daily_block_until, updated_at)
     VALUES('a-canary', 'gmail', 100, 1_800_000_000_000, 1_700_000_000_000, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO sync_state(account_id, scope, cursor, phase, generation, updated_at)
     VALUES('a-canary', 'mail', 'cur-1', 'incremental', 1, 1_500_000_000_000)`,
  ).run();
  db.prepare(
    `INSERT INTO sync_failures(account_id, item, attempts, next_retry_at, last_reason)
     VALUES('a-canary', ?, 3, 0, ?)`,
  ).run(`item ${CANARY.subject}`, `provider refused ${CANARY.key}`);
  db.prepare(
    `INSERT INTO ops(op_id, account_id, kind, target, payload, state, attempts, created_seq, scope)
     VALUES('op-c', 'a-canary', 'flags', ?, ?, 'failed', 2, 1, 'triage')`,
  ).run(CANARY.subject, `{"subject":"${CANARY.subject}"}`);
}

test('preview builds a bundle the strict host check accepts, with no canary in any field', async () => {
  const w = await world();
  try {
    seedCanaries(w.db);
    const bundle = await w.call('Diagnostics/preview', {});
    // The production check the host runs before preview, save or copy (FR-32).
    const strict: DiagnosticsBundle = parseDiagnosticsBundle(bundle);
    const text = JSON.stringify(bundle);
    for (const leak of Object.values(CANARY))
      assert.equal(text.includes(leak), false, `canary leaked: ${leak}`);
    // The account is present, but only as a 16-hex hash of its id.
    assert.equal(strict.accounts.length, 1);
    assert.match(strict.accounts[0]!.accountHash, /^[0-9a-f]{16}$/);
    assert.equal(strict.accounts[0]!.provider, 'google');
    assert.equal(strict.accounts[0]!.state, 'paused');
    assert.equal(strict.accounts[0]!.reasonCode, 'auth.adminPolicy');
    assert.equal(strict.accounts[0]!.reconnectBy, 1_900_000_000_000);
    assert.equal(strict.accounts[0]!.lastSyncAt, 1_500_000_000_000);
    assert.equal(strict.accounts[0]!.cursorAgeMs, Math.max(0, w.clock.now() - 1_500_000_000_000));
    assert.deepEqual(strict.accounts[0]!.budgets, [
      {
        budget: 'gmail',
        target: 100,
        cooldownUntil: 1_800_000_000_000,
        dailyBlockUntil: 1_700_000_000_000,
      },
    ]);
    assert.equal(strict.queues.failed, 1, 'the failed op is counted, its payload is not');
    assert.equal(strict.versions.app, '9.9.9-test');
    assert.equal(strict.engine.state, 'ready');
  } finally {
    await w.engine.close();
  }
});

test('a stored status or reason outside the code shape degrades to unknown, never fails the parse', async () => {
  const w = await world();
  try {
    w.db
      .prepare(
        `INSERT INTO accounts(id, provider, address, capabilities, status, created_at, updated_at)
         VALUES('a-bad', 'google', ?, '{}', ?, 1, 1)`,
      )
      .run('owner@mail.example', 'weird status with spaces && symbols');
    w.db
      .prepare(`UPDATE accounts SET status_reason_code = ? WHERE id = 'a-bad'`)
      .run(`reason: ${CANARY.token}`);
    const bundle = parseDiagnosticsBundle(await w.call('Diagnostics/preview', {}));
    const row = bundle.accounts[0]!;
    assert.equal(row.state, 'unknown');
    assert.equal(row.reasonCode, 'unknown');
    assert.equal(JSON.stringify(bundle).includes(CANARY.token), false);
  } finally {
    await w.engine.close();
  }
});

test('export hands back a caller-bound blob of the same bundle; another principal gets notFound', async () => {
  const w = await world();
  try {
    seedCanaries(w.db);
    const out = await w.call('Diagnostics/export', {});
    assert.equal(out.name, 'aplos-diagnostics.json');
    assert.equal(out.size > 0, true);
    const mine = await w.call('Blob/get', { blobId: out.blobId });
    const parsed = parseDiagnosticsBundle(JSON.parse(new TextDecoder().decode(mine.bytes)));
    assert.equal(parsed.accounts.length, 1);
    assert.equal(JSON.stringify(parsed).includes(CANARY.address), false);
    // FR-6: a read-scoped listener client cannot read a blob the app made — the id is unguessable anyway.
    const tool = w.asClient('c1', ['read', 'draft']);
    await assert.rejects(
      tool.call('Blob/get', { blobId: out.blobId }),
      (e: { type?: string }) => e.type === 'notFound',
    );
    // A listener needs `admin` for Diagnostics/*: read-only is refused, an admin tool still gets only the
    // content-free bundle, and an export it makes is bound to ITS principal — the app cannot read that one either.
    const reader = w.asClient('c2', ['read']);
    await assert.rejects(
      reader.call('Diagnostics/preview', {}),
      (e: { type?: string }) => e.type === 'forbidden',
    );
    const admin = w.asClient('c3', ['read', 'admin']);
    const toolBundle = parseDiagnosticsBundle(await admin.call('Diagnostics/preview', {}));
    assert.equal(toolBundle.accounts.length, 1);
    const toolOut = (await admin.call('Diagnostics/export', {})) as { blobId: string };
    await assert.rejects(
      w.call('Blob/get', { blobId: toolOut.blobId }),
      (e: { type?: string }) => e.type === 'notFound',
      "a tool's own export does not reach the app either",
    );
  } finally {
    await w.engine.close();
  }
});

test('verbose writes the 15-minute flag the host reads, deletes it on off, survives the window closing', async () => {
  const w = await world();
  try {
    const flag = () =>
      w.db.prepare("SELECT value FROM meta WHERE key = 'verbose_until'").get() as
        { value: string } | undefined;
    assert.equal(flag(), undefined);
    const on = await w.call('Diagnostics/verbose', { on: true });
    assert.equal(on.until, w.clock.now() + 15 * 60_000);
    assert.equal(flag()!.value, String(on.until));
    const off = await w.call('Diagnostics/verbose', { on: false });
    assert.equal(off.until, undefined);
    assert.equal(flag(), undefined);
  } finally {
    await w.engine.close();
  }
});

test('the log level thunk turns debug on for exactly the verbose window', () => {
  const clock = manualClock();
  let verboseUntil = 0;
  const records: { event: string }[] = [];
  const log = createLogger({
    sink: { write: r => records.push(r as { event: string }) },
    salt: 's',
    clock,
    level: () => (verboseUntil > clock.now() ? 'debug' : 'info'),
  });
  // `governor.admitted` is info; a `sync.gmail.request` line is the debug-level protocol log.
  const debug = () => log.event('sync.gmail.request', { method: 'x', durationMs: 1 });
  debug();
  assert.equal(records.length, 0, 'debug stays off by default');
  verboseUntil = clock.now() + 15 * 60_000;
  debug();
  assert.equal(records.length, 1, 'debug writes inside the window');
  clock.advance(15 * 60_000 + 1);
  debug();
  assert.equal(records.length, 1, 'the window switches itself off');
  assert.equal(log.enabled('debug'), false);
});

test('a level thunk that answers garbage reads as info, never throws', () => {
  const clock = manualClock();
  const records: unknown[] = [];
  const log = createLogger({
    sink: { write: r => records.push(r) },
    salt: 's',
    clock,
    level: () => 'loud' as never,
  });
  log.event('sync.gmail.request', { method: 'x', durationMs: 1 });
  assert.equal(records.length, 0, 'an unknown level is info, so debug stays off');
});
