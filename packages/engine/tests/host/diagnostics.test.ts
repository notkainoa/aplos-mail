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

test('a listener can switch verbose off but never on or extend', async () => {
  const w = await world();
  try {
    await w.call('Diagnostics/verbose', { on: true });
    const admin = w.asClient('c4', ['read', 'admin']);
    await assert.rejects(
      admin.call('Diagnostics/verbose', { on: true }),
      (e: { type?: string }) => e.type === 'forbidden',
      'a tool cannot open or stretch the noisy window',
    );
    // Off stays allowed for any admin listener — it only ever shrinks the log.
    await admin.call('Diagnostics/verbose', { on: false });
    const flag = w.db.prepare("SELECT value FROM meta WHERE key = 'verbose_until'").get() as
      { value: string } | undefined;
    assert.equal(flag, undefined);
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

test('checkBundle accepts a fully populated bundle and rejects smuggled fields', async () => {
  const { checkBundle } = await import('../../src/diag/bundle/build');
  const full = {
    generatedAt: 1,
    versions: {
      app: '0.1.0 (build 42)',
      api: 1,
      schema: 7,
      sqlite: '3.46',
      os: 'macOS 26',
      electron: '37',
    },
    engine: { state: 'ready', uptimeMs: 5, eventLoopP99Ms: 1.5, parkedReason: 'sleep' },
    accounts: [
      {
        accountHash: 'a'.repeat(16),
        provider: 'google',
        state: 'ok',
        reasonCode: 'auth.expired',
        cursorAgeMs: 10,
        lastSyncAt: 9,
        reconnectBy: 99,
        budgets: [
          {
            budget: 'google.rate',
            target: 2.5,
            unitsPerMinute: 55.5,
            cooldownUntil: 4,
            dailyBlockUntil: 6,
          },
        ],
      },
    ],
    queues: { ops: 1, jobs: 2, submissions: 3, failed: 4 },
    errors: [
      {
        at: 3,
        error: {
          class: 'permission',
          provider: 'google',
          method: 'sync.pull',
          reason: 'rate.limited',
          status: 429,
          code: 'quota',
          retryAfterMs: 30.5,
          resumeAt: 40.25,
          concurrency: true,
          uncertain: false,
          missingScopes: ['mail.read', 'calendar'],
        },
      },
    ],
    storage: { dbBytes: 1, walBytes: 2, ftsBacklog: 3, bodyBytes: 4, attachmentBytes: 5 },
    crashes: { count: 1, lastAt: 2 },
  };
  checkBundle(full as never); // every field the strict schema knows passes
  parseDiagnosticsBundle(full as never); // and the strict parse agrees
  const bad = (mutate: (b: Record<string, unknown>) => void) => {
    const copy = JSON.parse(JSON.stringify(full)) as Record<string, unknown>;
    mutate(copy);
    assert.throws(() => checkBundle(copy as never));
  };
  bad(b => ((b.engine as Record<string, unknown>).note = 'x'));
  bad(b => (((b.accounts as unknown[])[0] as Record<string, unknown>).email = 'a@b.c'));
  bad(b => (((b.accounts as unknown[])[0] as Record<string, unknown>).accountHash = 'not-hex!'));
  bad(b => ((b.storage as Record<string, unknown>).dbBytes = 1.5));
  bad(b => ((b.storage as Record<string, unknown>).dbBytes = -5));
  bad(b => ((b.crashes as Record<string, unknown>).count = -1));
  bad(b => ((b.engine as Record<string, unknown>).state = 'has space'));
  bad(
    b =>
      ((
        ((b.errors as unknown[])[0] as Record<string, unknown>).error as Record<string, unknown>
      ).providerMessage = 'provider said secret'),
  );
});

test('verbose with no argument reads the stored deadline — window and listener both', async () => {
  const w = await world();
  try {
    assert.deepEqual(await w.call('Diagnostics/verbose', {}), {}, 'unset reads empty');
    await w.call('Diagnostics/verbose', { on: true });
    const want = w.clock.now() + 15 * 60_000;
    assert.deepEqual(await w.call('Diagnostics/verbose', {}), { until: want });
    const admin = w.asClient('c5', ['read', 'admin']);
    assert.deepEqual(await admin.call('Diagnostics/verbose', {}), { until: want });
    // The read is a query, not a write — a listener reading must leave no audit row.
    const reads = w.db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE method = 'Diagnostics/verbose' AND client_id = 'c5'",
      )
      .get() as { n: number };
    assert.equal(reads.n, 0, 'a verbose read audits nothing');
    await w.call('Diagnostics/verbose', { on: false });
    assert.deepEqual(await w.call('Diagnostics/verbose', {}), {});
    // A planted deadline past the window reads as off, not as an impossible deadline.
    w.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('verbose_until', ?)")
      .run(String(w.clock.now() - 1));
    assert.deepEqual(await w.call('Diagnostics/verbose', {}), {}, 'expired reads off');
    w.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('verbose_until', ?)")
      .run(String(w.clock.now() + 60 * 60_000));
    assert.deepEqual(await w.call('Diagnostics/verbose', {}), {}, 'beyond the window reads off');
  } finally {
    await w.engine.close();
  }
});

test('a missing install salt refuses the bundle rather than emitting derivable hashes', async () => {
  const w = await world();
  try {
    w.db.prepare("DELETE FROM meta WHERE key = 'install_salt'").run();
    await assert.rejects(
      w.call('Diagnostics/preview', {}),
      (e: { type?: string }) => e.type === 'internal',
    );
  } finally {
    await w.engine.close();
  }
});
