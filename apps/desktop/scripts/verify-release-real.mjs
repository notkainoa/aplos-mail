import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

// The new-engine twin of verify-release.mjs: exercises the shipped renderer, preload, main process and the NEW engine
// (the default in every build) on a packaged build, with a throwaway data folder and the original demo mail only.
// It adds no account and sends nothing outside the folder: the demo accounts deliver locally (to their own Sent). verify-release.mjs stays
// pinned to the legacy engine until that code is deleted.
//
// The app runs in test mode (APLOS_TEST=1): windows load but are never shown, no Dock icon, nothing system-wide, so it is
// safe beside other agents. Run it against a local package, not a release build (a release build refuses
// --remote-debugging-port and ignores APLOS_TEST):
//   npm run package -w @aplos/desktop && npm run verify:release:real
const executable = resolve(
  process.argv.find(a => a.endsWith('.app'))
    ? resolve(
        process.argv.find(a => a.endsWith('.app')),
        'Contents/MacOS/Aplos Mail',
      )
    : 'release/mac-arm64/Aplos Mail.app/Contents/MacOS/Aplos Mail',
);
if (!existsSync(executable)) {
  console.error(
    `verify-release-real: no executable at ${executable}. Build one first: npm run package -w @aplos/desktop`,
  );
  process.exit(2);
}
const dataDir = await mkdtemp(join(tmpdir(), 'aplos-release-real-'));
const checks = [];
const sockets = new Set();
let child, port;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(150);
  }
  throw new Error('Timed out: ' + label + (last ? ' (' + last.message + ')' : ''));
}
async function targets() {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  sockets.add(ws);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const result = JSON.parse(event.data);
    const entry = pending.get(result.id);
    if (!entry) return;
    pending.delete(result.id);
    clearTimeout(entry.timer);
    if (result.error) entry.reject(new Error(result.error.message));
    else entry.resolve(result.result);
  });
  ws.addEventListener('close', () => {
    sockets.delete(ws);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Debug target closed'));
    }
    pending.clear();
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error('Timed out: ' + method));
      }, 30000);
      pending.set(key, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: key, method, params }));
    });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text,
      );
    return result.result.value;
  };
  // A call down the new engine's port, from the page, the way the app's own renderer makes it. The page answers
  // `{ ok }` or `{ error }` so a refusal keeps its type and message.
  const settle = (method, args) =>
    evaluate(
      `window.aplosEngine.call(${JSON.stringify(method)},${JSON.stringify(args ?? {})}).then(` +
        `ok=>({ok}),error=>({error:{type:error?.type,message:error?.message}}))`,
    );
  return {
    send,
    evaluate,
    settle,
    call: async (method, args) => {
      const answer = await settle(method, args);
      if (answer.error)
        throw new Error(`${method}: ${answer.error.type ?? 'error'}: ${answer.error.message}`);
      return answer.ok;
    },
  };
}
let opCount = 0;
const opId = tag => `verify-${tag}-${process.pid}-${++opCount}`;
async function launch() {
  const listener = createServer();
  await new Promise(r => listener.listen(0, '127.0.0.1', r));
  port = listener.address().port;
  await new Promise(r => listener.close(r));
  const log = await open(join(dataDir, 'desktop.log'), 'a');
  // Pinned to the new engine, so a future change to the default can't turn this into a second legacy run.
  const env = {
    ...process.env,
    APLOS_TEST: '1',
    APLOS_DATA_DIR: dataDir,
    APLOS_ENGINE: 'real',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(
    executable,
    [`--user-data-dir=${join(dataDir, 'chromium')}`, `--remote-debugging-port=${port}`],
    { env, stdio: ['ignore', log.fd, log.fd] },
  );
  child.on('error', () => {});
  // 78 is the ADR 40-6 debug guard in src/main/security.ts: a release build refuses --remote-debugging-port.
  child.on('exit', code => {
    if (code !== 78) return;
    console.error(
      'verify-release-real: the app refused --remote-debugging-port, so it was built with APLOS_RELEASE_BUILD=1. Run this against a local build instead: npm run package -w @aplos/desktop',
    );
    process.exit(1);
  });
  await log.close();
  // The first page that has the new engine's bridge: the mail window, or the welcome window on a first run.
  const client = await until(async () => {
    if (child.exitCode !== null) throw new Error('Desktop exited');
    for (const target of (await targets()).filter(
      t => t.type === 'page' && t.url.startsWith('file:'),
    )) {
      const candidate = await connect(target);
      if (await candidate.evaluate('typeof window.aplosEngine==="object"')) return candidate;
    }
  }, 'a window with the new engine bridge');
  await until(() => client.evaluate('document.body.innerText.trim().length>0'), 'rendered desktop');
  return client;
}
async function stop() {
  for (const ws of sockets) ws.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    // A graceful quit (quit warning, window save-before-close, engine drain) can run past 30 s
    // on a heavily loaded Mac; the SIGKILL floor below still bounds it.
    const exited = until(() => child.exitCode !== null, 'desktop exit', 60000).then(
      () => true,
      () => false,
    );
    if (!(await exited)) {
      console.error('verify-release-real: app ignored SIGTERM for 60 s; killing it');
      child.kill('SIGKILL');
      await until(() => child.exitCode !== null, 'desktop kill', 10000);
    }
  }
}
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log('PASS ' + name);
}
let client;
let failure;
try {
  client = await launch();
  const session = await client.call('Session/get');
  await check('packaged UI, preload and the new engine start on a fresh folder', async () => {
    assert.equal(session.engine.state, 'ready');
    assert.equal(session.hasAccounts, false, 'a throwaway folder starts with no account');
    const files = readdirSync(dataDir);
    assert.ok(files.includes('mail.db'), 'the new engine keeps its mail in mail.db');
    assert.ok(!files.includes('aplos.db'), 'the legacy store was never created');
    const body = await client.evaluate('document.body.innerText');
    assert.doesNotMatch(body, /Aplos needs a moment|can’t reach its mail engine/i);
    assert.equal(await client.evaluate('typeof window.require'), 'undefined');
  });
  let accountIds;
  await check('demo mail loads into the new engine and nothing else is added', async () => {
    const loaded = await client.call('Demo/load', {});
    accountIds = loaded.accountIds;
    assert.equal(accountIds.length, 2);
    const after = await client.call('Session/get');
    assert.equal(after.hasAccounts, true);
    const accounts = (await client.call('Account/get', {})).list;
    assert.equal(accounts.length, 2);
    assert.ok(
      accounts.every(a => a.demo === true),
      'Refusing to test a real account',
    );
  });
  const inbox = { kind: 'mailbox', role: 'inbox' };
  const inboxIds = async () => (await client.call('View/query', { spec: inbox })).ids;
  const first = (await inboxIds())[0];
  await check('demo mail is readable: counts, the inbox view and thread rows', async () => {
    assert.ok(first, 'the inbox has demo threads');
    const counts = await client.call('Counts/get');
    assert.ok(JSON.stringify(counts).length > 2);
    const rows = (await client.call('Thread/get', { ids: [first] })).list;
    assert.equal(rows.length, 1);
    assert.ok(rows[0].subject.length > 0);
  });
  await check('triage and Undo change the view and come back', async () => {
    const before = await inboxIds();
    const act = opId('done');
    const receipt = await client.call('Thread/act', {
      opId: act,
      ids: [first],
      action: { type: 'done' },
    });
    assert.ok(receipt);
    assert.ok(!(await inboxIds()).includes(first), 'a done thread leaves the inbox');
    await client.call('Operation/undo', { opId: act, undoOpId: opId('undo') });
    // The undo is the contract's own call: the thread is back where it was.
    assert.deepEqual(await inboxIds(), before);
  });
  await check(
    'a demo thread opens complete, lists its messages and a message reads back',
    async () => {
      // The reader's own call when a thread opens (ReaderLetter.tsx). A demo thread is complete locally, so this asks no
      // provider; it used to answer `internal`, which the reader swallowed.
      const opened = await client.call('Thread/open', { threadId: first });
      assert.equal(opened.complete, true, 'a demo thread opens complete');
      const ids = (await client.call('View/query', { spec: { kind: 'thread', threadId: first } }))
        .ids;
      assert.ok(ids.length > 0);
      const message = (await client.call('Message/get', { ids: [ids[0]] })).list[0];
      assert.ok(message && message.subject.length > 0);
    },
  );
  const fields = subject => ({
    accountId: accountIds[0],
    mode: 'new',
    to: [{ address: 'reader@verification.example', name: 'Reader' }],
    cc: [],
    bcc: [],
    subject,
    html: '<p>Original synthetic release verification.</p>',
    attachments: [],
    signature: false,
  });
  const sentIds = async () =>
    (await client.call('View/query', { spec: { kind: 'mailbox', role: 'sent' } })).ids;
  const submit = async (d, notBefore) =>
    (
      await client.call('Submission/set', {
        opId: opId('send'),
        action: { type: 'send', draftId: d.id, revision: d.revision, notBefore },
      })
    ).submission;
  let draft;
  let submissionId;
  await check(
    'draft save, send later, Undo, then a demo send reaches sent and is filed in Sent',
    async () => {
      const smoke = (
        await client.call('Draft/set', {
          opId: opId('draft'),
          fields: fields('Release smoke message'),
        })
      ).draft;
      assert.equal(smoke.subject, 'Release smoke message');
      const queued = await submit(smoke, Date.now() + 60_000);
      assert.ok(['queued', 'scheduled'].includes(queued.state), `state ${queued.state}`);
      const undone = (
        await client.call('Submission/set', {
          opId: opId('unsend'),
          action: { type: 'undo', submissionId: queued.id },
        })
      ).submission;
      assert.ok(['cancelled', 'undone'].includes(undone.state), `state ${undone.state}`);
      // Demo accounts deliver locally (packages/engine/src/ai/demo/send.ts): the send settles `sent` and the message is
      // filed in the account's own Sent folder. Nothing leaves the Mac.
      const before = await sentIds();
      const now = await submit(smoke, Date.now());
      const sent = await until(async () => {
        const row = (await client.call('Submission/get', { ids: [now.id] })).list[0];
        assert.ok(
          row && !['failed', 'suspended', 'uncertain'].includes(row.state),
          `state ${row?.state}`,
        );
        return row.state === 'sent' && row;
      }, 'the demo send reaching sent');
      assert.equal(sent.state, 'sent');
      const added = (await sentIds()).filter(id => !before.includes(id));
      assert.equal(added.length, 1, 'the sent message is in Sent');
      assert.equal(
        (await client.call('Thread/get', { ids: added })).list[0]?.subject,
        'Release smoke message',
      );
      assert.equal((await client.call('Thread/open', { threadId: added[0] })).complete, true);
      // A second draft held for an hour: the queued send has to survive a restart, as a user's queued mail does.
      draft = (
        await client.call('Draft/set', {
          opId: opId('draft'),
          fields: fields('Release queued message'),
        })
      ).draft;
      const later = await submit(draft, Date.now() + 3_600_000);
      assert.ok(['queued', 'scheduled'].includes(later.state), `state ${later.state}`);
      submissionId = later.id;
    },
  );
  const settings = await client.call('Settings/get');
  const wanted = settings.ui.density === 'roomy' ? 'compact' : 'roomy';
  await check('settings save and invalid requests fail without damaging stored mail', async () => {
    await client.call('Settings/set', {
      opId: opId('settings'),
      patch: { ui: { density: wanted } },
    });
    assert.equal((await client.call('Settings/get')).ui.density, wanted);
    const bad = await client.settle('Settings/set', {
      opId: opId('bad'),
      patch: { ui: { density: 'enormous' } },
    });
    assert.ok(bad.error, 'an invalid setting is refused');
    const unknown = await client.settle('Not/allowed', {});
    assert.ok(unknown.error, 'an unknown method is refused');
    assert.equal((await client.call('Account/get', {})).list.length, 2);
    assert.equal((await client.call('Settings/get')).ui.density, wanted);
  });
  await check('engine crash restarts and keeps persisted changes', async () => {
    const before = await client.call('Session/get');
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split(
      '\n',
    );
    const row = rows.find(row => {
      const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return (
        match &&
        Number(match[2]) === child.pid &&
        match[3].includes('--type=utility') &&
        match[3].includes('node.mojom.NodeService')
      );
    });
    assert.ok(row, 'Mailbox utility process not found');
    process.kill(Number(row.trim().match(/^\d+/)[0]), 'SIGKILL');
    await until(async () => {
      const answer = await client.settle('Session/get', {});
      return answer.ok?.engine.state === 'ready' && answer.ok;
    }, 'engine restart');
    assert.equal((await client.call('Settings/get')).ui.density, wanted);
    assert.ok((await inboxIds()).includes(first), 'the demo mail survived the crash');
    assert.ok(before.dbEpoch);
  });
  await check(
    'desktop restart preserves mail, settings, the draft and the queued send',
    async () => {
      await stop();
      child = undefined;
      client = await launch();
      const again = await client.call('Session/get');
      assert.equal(again.hasAccounts, true);
      assert.equal((await client.call('Settings/get')).ui.density, wanted);
      assert.ok((await inboxIds()).includes(first));
      const queued = (await client.call('Submission/get', { ids: [submissionId] })).list[0];
      assert.ok(
        queued && ['queued', 'scheduled'].includes(queued.state),
        'the queued send survived',
      );
      assert.equal(
        (await client.call('Draft/get', { ids: [draft.id] })).list[0]?.subject,
        'Release queued message',
      );
      assert.equal(readdirSync(dataDir).includes('aplos.db'), false);
    },
  );
  const report = {
    date: new Date().toISOString(),
    engine: 'real',
    checks,
    liveMailboxVerified: false,
    dataDir,
    port,
  };
  await writeFile(join(dataDir, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  failure = error;
}
let stopError;
try {
  await stop();
} catch (error) {
  // A stop() failure must not hide the check failure it runs after.
  stopError = error;
}
// The folder is throwaway: remove it after a pass, keep it (with desktop.log) to debug a failure.
if (!failure && !stopError && dataDir.includes('aplos-release-real-'))
  rmSync(dataDir, { recursive: true, force: true });
else console.error(`verify-release-real: kept ${dataDir} for inspection`);
if (stopError && failure)
  console.error('verify-release-real: cleanup also failed:', stopError?.message ?? stopError);
if (failure) throw failure;
if (stopError) throw stopError;
