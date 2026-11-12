import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogRecord } from '@aplos/contract';
import { laneExtensions } from '@aplos/engine';
import { MAIL_HTML_VERSION, mailHtml } from '@aplos/mail-html';
import { openStore, type StoreWrite } from '@aplos/engine/store';
import { composeEngineHost, type ComposeOptions } from '../../src/host/compose';
import { openSqlite } from '../../src/host/sqlite';
import { realComposeOptions, realHostPorts } from '../../src/main/engine-utility';
import { fakeClock, memoryVault, T0 } from './rig';

// fix-bodies (2026-11-11), the owner's release blocker: on the packaged real engine every HTML letter took long and then
// showed "Couldn't load this email.", with nothing in the log. `realComposeOptions` never gave the engine its mail
// sanitiser (`html`) or image proxy (`images`), so `MessageBody/get` fetched the body and then answered `unavailable`.
// Every engine test injects its own `mailHtml`, so nothing caught it. These pin the production port set and open an
// HTML letter through the composed host the way the reader does, with no network and no provider.

const ACCOUNT = 'acct-demo';
const LETTER = `${ACCOUNT}:msg-redact-1`;

function seedWrites(): StoreWrite[] {
  return [
    {
      kind: 'account',
      id: ACCOUNT,
      provider: 'demo',
      address: 'owner@demo.example',
      capabilities: { labels: true, drafts: true },
      status: { state: 'ok' },
    },
    {
      kind: 'folder',
      accountId: ACCOUNT,
      remoteId: 'INBOX',
      name: 'Inbox',
      role: 'inbox',
      folderKind: 'system',
    },
    {
      kind: 'message',
      accountId: ACCOUNT,
      remoteId: 'msg-redact-1',
      remoteThreadId: 'thr-redact-1',
      from: { address: 'sender@demo.example', name: 'Sender' },
      to: [{ address: 'owner@demo.example' }],
      cc: [],
      subject: 'Weekly notes',
      snippet: 'Hello',
      date: T0,
      internalDate: T0,
      flags: { seen: false, flagged: false, draft: false, fromMe: false },
      folders: [{ folder: 'INBOX' }],
    },
    {
      kind: 'body',
      accountId: ACCOUNT,
      remoteId: 'msg-redact-1',
      body: {
        html: '<table width="600"><tr><td><h1>Weekly notes</h1><p>Hello <b>there</b>.</p></td></tr></table>',
        text: 'Weekly notes\nHello there.',
        cidMap: {},
      },
    },
  ] as StoreWrite[];
}

/** A temp data folder whose `mail.db` already holds one HTML letter. */
function seededFolder(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'aplos-realports-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openSqlite(join(dir, 'mail.db'));
  const store = openStore(db, { now: () => T0, extensions: laneExtensions() });
  store.commit({ opId: 'seed', origin: 'sync', writes: seedWrites() });
  store.close();
  return dir;
}

/** Compose options with no network; `ports` as the real path would pass them (or not). */
function options(
  dir: string,
  records: LogRecord[],
  ports?: ComposeOptions['ports'],
): ComposeOptions {
  return {
    dataDir: dir,
    fetch: async () => {
      throw new Error('no network in this test');
    },
    clock: fakeClock(T0),
    logSink: { write: record => void records.push(record) },
    deviceId: 'mac-realports',
    power: new EventEmitter(),
    vault: memoryVault(),
    openExternal: async () => undefined,
    googleClient: () => ({ env: {}, bundled: {} }),
    postNotification: async () => 'dropped' as const,
    ...(ports ? { ports } : {}),
  };
}

async function openLetter(t: TestContext, ports?: ComposeOptions['ports']) {
  const records: LogRecord[] = [];
  const host = await composeEngineHost(options(seededFolder(t), records, ports));
  t.after(() => host.close());
  return { session: host.engine.connect(), records };
}

test('the real path gives the engine its mail sanitiser and image proxy', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aplos-realports-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bridge = { request: async () => undefined, power: new EventEmitter() };
  const composed = await realComposeOptions({ dataDir: dir, appVersion: '0.3.0-test' }, bridge);
  const html = composed.ports?.html;
  assert.equal(typeof html?.version, 'string', 'html port: a sanitiser with a version');
  assert.ok(html?.version, 'html port: the version is not empty');
  assert.equal(typeof html?.render, 'function', 'html port: render');
  assert.equal(typeof composed.ports?.images?.fetch, 'function', 'images port: fetch');
  assert.equal(html, mailHtml, 'the html port is the workspace @aplos/mail-html, not a stand-in');
  assert.equal(html?.version, MAIL_HTML_VERSION, 'the sanitiser reports its own version');
});

test('an HTML letter opens on the real port set: MessageBody/get and Mail/frame', async t => {
  const { session } = await openLetter(t, realHostPorts());
  const body = (await session.call('MessageBody/get', { messageId: LETTER })) as {
    bodyKind: string;
    text: string;
  };
  assert.equal(body.bodyKind, 'html');
  assert.match(body.text, /Weekly notes/);
  const frame = (await session.call('Mail/frame', { messageId: LETTER, imagePolicy: 'block' })) as {
    url: string;
    bodyKind: string;
  };
  assert.equal(frame.bodyKind, 'html');
  assert.match(frame.url, /^aplos-mail:\/\/m\/[0-9a-f]{32}\/$/);
});

test('without the sanitiser the letter fails and the log says why, with no mail content', async t => {
  const { session, records } = await openLetter(t);
  await assert.rejects(session.call('MessageBody/get', { messageId: LETTER }), (error: unknown) => {
    assert.equal((error as { body?: { type?: string } }).body?.type, 'unavailable');
    return true;
  });
  const failed = records.filter(
    r => r.event === 'rpc.failed' && /^(MessageBody|Mail)\//.test(String(r.data?.method)),
  );
  assert.deepEqual(
    failed.map(r => r.data),
    [{ method: 'MessageBody/get', reason: 'contract.unavailable' }],
  );
  const logged = JSON.stringify(records);
  for (const secret of ['Weekly notes', 'sender@demo.example', 'msg-redact-1', 'thr-redact-1'])
    assert.ok(!logged.includes(secret), `the log never carries ${secret}`);
});

/** The repo root, from this file's folder (`apps/desktop/tests/eng-contract`). */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** A workspace package's `dependencies`, by package name (`@aplos/engine` is `packages/engine`). */
function workspaceDeps(name: string): Record<string, string> {
  const folder = join(ROOT, 'packages', name.replace(/^@aplos\//, ''));
  const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return manifest.dependencies ?? {};
}

test('every third-party dependency of the bundled engine ships in the packaged app', () => {
  // `scripts/build-main.mjs` bundles `@aplos/*` into `dist/main/engine.cjs` and leaves every other package external,
  // so it must come from app.asar's node_modules, which holds only apps/desktop's own `dependencies`. The sanitiser's
  // parser was missing there, so wiring the `html` port alone stopped the packaged engine at start (MODULE_NOT_FOUND).
  const desktop = JSON.parse(readFileSync(join(ROOT, 'apps/desktop/package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const seen = new Set<string>();
  const missing: string[] = [];
  const walk = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const dep of Object.keys(workspaceDeps(name))) {
      if (dep.startsWith('@aplos/')) walk(dep);
      else if (!(dep in desktop.dependencies)) missing.push(`${name} -> ${dep}`);
    }
  };
  walk('@aplos/engine');
  walk('@aplos/mail-html');
  assert.ok(seen.has('@aplos/mail-html'), 'the sanitiser is part of the walk');
  assert.deepEqual(missing, [], 'add these to apps/desktop/package.json dependencies');
});

test("desktop ships the sanitiser's pins at the pinned versions", () => {
  // Presence is not enough: the packaged engine runs the desktop copies of the parser packages, so a version that
  // drifted from the pin `@aplos/mail-html` was tested against is the same failure as a missing one, subtler.
  const desktop = JSON.parse(readFileSync(join(ROOT, 'apps/desktop/package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const pins = workspaceDeps('@aplos/mail-html');
  assert.ok(Object.keys(pins).length > 0, 'the sanitiser pins its parser packages');
  const shipped = Object.fromEntries(
    Object.keys(pins).map(dep => [dep, desktop.dependencies[dep]]),
  );
  assert.deepEqual(shipped, pins, 'apps/desktop dependencies must equal the @aplos/mail-html pins');
});
