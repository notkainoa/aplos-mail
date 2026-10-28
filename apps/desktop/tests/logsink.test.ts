import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@aplos/engine/diag/log';
import { logEventSchema, LogRecordSchema } from '@aplos/contract';
import type { LogEventId, LogFieldSpec, LogRecord } from '@aplos/contract';
import { createLogSink, LOG_FILE, logDir } from '../src/host/logsink';
import { eventIds, sampleFields, validValue } from '../../../packages/engine/tests/diag/samples';

const scratch = () => mkdtempSync(join(tmpdir(), 'aplos-logsink-'));
const mode = (path: string) => statSync(path).mode & 0o777;
const lines = (dir: string, name = LOG_FILE) =>
  readFileSync(join(dir, name), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l) as LogRecord);
const record = (n: number): LogRecord => ({
  t: n,
  level: 'info',
  event: 'engine.stopping',
  data: { why: 'quit' },
});

test('the log folder: the macOS folder by default, and inside an isolated data dir when the caller has one', () => {
  assert.match(logDir(), /Library\/Logs\/Aplos Mail$/);
  assert.equal(logDir({ dataDir: '/tmp/aplos-test' }), '/tmp/aplos-test/logs');
});

test('files are 0600 in a 0700 folder, and pre-existing files and folders are fixed', () => {
  const root = scratch();
  try {
    const dir = join(root, 'logs');
    mkdirSync(dir, { mode: 0o755 });
    writeFileSync(join(dir, LOG_FILE), '', { mode: 0o644 });
    writeFileSync(join(dir, `${LOG_FILE}.1`), '', { mode: 0o666 });
    chmodSync(join(dir, `${LOG_FILE}.1`), 0o666);
    const sink = createLogSink({ dir });
    sink.write(record(1));
    sink.close();
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(join(dir, LOG_FILE)), 0o600);
    assert.equal(mode(join(dir, `${LOG_FILE}.1`)), 0o600);
    assert.deepEqual(lines(dir), [record(1)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rotation at a small injected cap keeps five files, newest first, all 0600', () => {
  const dir = join(scratch(), 'logs');
  try {
    const one = Buffer.byteLength(`${JSON.stringify(record(1000))}\n`);
    const sink = createLogSink({ dir, maxBytes: one * 3 });
    for (let i = 1000; i < 1020; i++) sink.write(record(i));
    sink.close();
    assert.deepEqual(readdirSync(dir).sort(), [
      LOG_FILE,
      `${LOG_FILE}.1`,
      `${LOG_FILE}.2`,
      `${LOG_FILE}.3`,
      `${LOG_FILE}.4`,
    ]);
    for (const name of readdirSync(dir)) {
      assert.equal(mode(join(dir, name)), 0o600, name);
      assert.ok(statSync(join(dir, name)).size <= one * 3, name);
    }
    assert.deepEqual(
      lines(dir).map(r => r.t),
      [1018, 1019],
    );
    assert.deepEqual(
      lines(dir, `${LOG_FILE}.1`).map(r => r.t),
      [1015, 1016, 1017],
    );
    assert.deepEqual(
      lines(dir, `${LOG_FILE}.4`).map(r => r.t),
      [1006, 1007, 1008],
      'older files are deleted',
    );
    assert.equal(sink.stats().rotations, 6);
    console.log(
      `rotation: ${readdirSync(dir)
        .sort()
        .map(n => `${n} ${statSync(join(dir, n)).size}B mode ${mode(join(dir, n)).toString(8)}`)
        .join('; ')}; folder mode ${mode(dir).toString(8)}`,
    );
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('a failing disk drops and counts lines, never throws, and says how many once it can write again', () => {
  const root = scratch();
  try {
    const dir = join(root, 'logs');
    writeFileSync(dir, 'a file where the folder should be');
    const sink = createLogSink({ dir, now: () => 42 });
    assert.doesNotThrow(() => {
      sink.write(record(1));
      sink.write(record(2));
    });
    assert.deepEqual(sink.stats(), { lines: 0, droppedLines: 2, rotations: 0 });
    rmSync(dir);
    sink.write(record(3));
    sink.close();
    assert.deepEqual(lines(dir), [
      { t: 42, level: 'warn', event: 'log.lines_dropped', data: { lines: 2, why: 'disk' } },
      record(3),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Canary test (plan 10 E0). Canaries ride in every place mail content or a credential could reach a call site:
 * subjects, bodies, tokens, keys, addresses, URLs, provider error text, JSON, nested `cause` chains, unlisted fields
 * and context. Every catalog event gets them in every field, at debug level, through the real file sink. A grep of the
 * log folder must find none. Canaries carry digits, as ids and keys do: the free-text redactor cannot tell a
 * digit-free word a provider echoes unquoted from its own prose (see the Logger's notes), the allowlist covers that.
 */
test('canaries in content, credentials, errors, causes and unlisted fields never reach the log folder', () => {
  const root = scratch();
  const dir = logDir({ dataDir: root });
  let n = 0;
  const canary = () => `CANARY-${String(++n).padStart(4, '0')}`;
  const shapes: (() => string)[] = [
    () => `Re: ${canary()} quarterly plan`,
    () => `Hi Bob,\n\nThe numbers are ${canary()}.\n\nThanks`,
    () => `ya29.${canary()}a0AfB_xyz`,
    () => `Bearer ${canary()}`,
    () => `1//${canary()}abcdefgh`,
    () => `gsk_${canary()}`,
    () => `sk-ant-${canary()}-abc`,
    () => `${canary()}@mail.example`,
    () => `"Bob ${canary()}" <bob@mail.example>`,
    () => `https://mail.example/search?q=${canary()}`,
    () => `https://mail.example/u/${canary()}/inbox`,
    () => `Message ${canary()} not found`,
    () => `Invalid label name "${canary()}"`,
    () => `invalid_grant: ${canary()}`,
    () => `{"subject":"${canary()}","body":"${canary()}"}`,
    () => `access_token=${canary()}&x=1`,
  ];
  let s = 0;
  const hostile = () => shapes[s++ % shapes.length]();
  const cause = () => ({
    subject: hostile(),
    cause: new Error(hostile(), { cause: { body: hostile(), token: hostile() } }),
  });
  const value = (spec: LogFieldSpec): unknown =>
    spec.kind === 'error'
      ? {
          class: hostile(),
          provider: 'google',
          method: hostile(),
          reason: hostile(),
          code: hostile(),
          status: 403,
          item: hostile(),
          missingScopes: [hostile(), hostile()],
          providerMessage: shapes.map(f => f()).join(' | '),
          cause: cause(),
          message: hostile(),
          stack: hostile(),
        }
      : hostile();
  try {
    const sink = createLogSink({ dir });
    const logger = createLogger({
      sink,
      salt: 'canary-salt',
      clock: { now: () => 1 },
      level: 'debug',
    });
    for (const id of eventIds) {
      for (let round = 0; round < shapes.length; round++) {
        const fields = {
          ...sampleFields(id, value),
          subject: hostile(),
          body: { html: hostile(), text: hostile() },
          headers: { Authorization: hostile() },
          cause: cause(),
        };
        logger
          .with({ account: hostile(), lane: hostile() })
          .event(id as LogEventId, fields as never);
        // The same unlisted payload riding next to valid fields.
        logger.event(id, {
          ...sampleFields(id, validValue),
          ...({ snippet: hostile(), url: hostile() } as object),
        } as never);
      }
    }
    sink.close();
    const written = readdirSync(dir)
      .map(name => readFileSync(join(dir, name), 'utf8'))
      .join('');
    assert.ok(n > 2000, `${n} canaries planted`);
    assert.ok(
      logger.stats().lines >= eventIds.length * shapes.length * 2,
      'every call wrote a line',
    );
    assert.equal(logger.stats().failures, 0);
    assert.deepEqual(written.match(/canary-\d{4}/gi) ?? [], []);
    // Hostile input still yields lines that pass the catalog's strict schemas: the Logger's kinds and the zod schemas agree.
    for (const line of written.trim().split('\n')) {
      const parsed = JSON.parse(line) as LogRecord;
      assert.ok(LogRecordSchema.safeParse(parsed).success, line);
      if (parsed.event !== 'log.lines_dropped')
        assert.ok(logEventSchema(parsed.event as LogEventId).safeParse(parsed.data).success, line);
    }
    // URL hosts and the word `Bearer` may stay; addresses, key prefixes and the secrets after `Bearer` may not.
    assert.doesNotMatch(
      written,
      /@mail\.example|bob@|ya29|gsk_|sk-ant|1\/\/|Bearer (?!\[secret\])/,
    );
    console.log(
      `canary: ${n} canaries, ${logger.stats().lines} lines, ${logger.stats().droppedFields} fields dropped, 0 found in ${dir.replace(root, '<tmp>')}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
