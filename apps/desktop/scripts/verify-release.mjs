import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, open, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

// Exercise the shipped renderer, preload, main process and engine with original demo data only.
// No automation dependency or debug endpoint is included in the release bundle.
const executable = resolve('release/mac-arm64/Aplos Mail.app/Contents/MacOS/Aplos Mail');
const dataDir = await mkdtemp(join(tmpdir(), 'aplos-release-'));
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
    result.error ? entry.reject(new Error(result.error.message)) : entry.resolve(result.result);
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
  return {
    send,
    evaluate,
    invoke: (method, payload) =>
      evaluate(`window.aplos.invoke(${JSON.stringify(method)},${JSON.stringify(payload ?? {})})`),
  };
}
async function launch() {
  const listener = createServer();
  await new Promise(r => listener.listen(0, '127.0.0.1', r));
  port = listener.address().port;
  await new Promise(r => listener.close(r));
  const log = await open(join(dataDir, 'desktop.log'), 'a');
  // This suite drives the legacy engine (`state.get`), no longer the default: pinned until the legacy code goes.
  const env = { ...process.env, APLOS_DATA_DIR: dataDir, APLOS_ENGINE: 'legacy' };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(
    executable,
    [
      `--user-data-dir=${join(dataDir, 'chromium')}`,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
    ],
    { env, detached: process.argv.includes('--keep-open'), stdio: ['ignore', log.fd, log.fd] },
  );
  child.on('error', () => {});
  // 78 is the ADR 40-6 debug guard in src/main/security.ts: a release build refuses --remote-debugging-port.
  child.on('exit', code => {
    if (code !== 78) return;
    console.error(
      'verify-release: the app refused --remote-debugging-port, so it was built with APLOS_RELEASE_BUILD=1. Run this against a local build instead: npm run package -w @aplos/desktop',
    );
    process.exit(1);
  });
  await log.close();
  const target = await until(async () => {
    if (child.exitCode !== null) throw new Error('Desktop exited');
    return (await targets()).find(t => t.type === 'page' && t.url.startsWith('file:'));
  }, 'desktop launch');
  const client = await connect(target);
  await until(
    () => client.evaluate('Boolean(window.aplos&&document.querySelector("main"))'),
    'rendered desktop',
  );
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
      console.error('verify-release: app ignored SIGTERM for 60 s; killing it');
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
  const initial = await client.invoke('state.get');
  assert.ok(
    initial.accounts.every(a => a.provider === 'demo'),
    'Refusing to test a real account',
  );
  await check('packaged UI, preload and secure engine start', async () => {
    assert.equal(initial.accounts.length, 2);
    assert.equal(initial.threads.length, 18);
    assert.ok(
      await client.evaluate('document.querySelector("main").getBoundingClientRect().width>0'),
    );
    assert.equal(await client.evaluate('typeof window.require'), 'undefined');
  });
  await check('first run opens the welcome flow', async () => {
    assert.equal(initial.settings.onboardingDone, false);
    await until(
      () =>
        client.evaluate(
          '!!document.querySelector(\'[role="dialog"][aria-label="Welcome to Aplos Mail"]\')',
        ),
      'welcome dialog',
    );
  });
  await client.invoke('settings.update', { patch: { onboardingDone: true } });
  // A synthetic key only; it is never sent anywhere (Test is not run) and is removed again.
  await check('AI keys save encrypted and reveal only their last four characters', async () => {
    const fake = 'release-synthetic-key-0000-wxyz';
    const listed = await client.invoke('ai.keys');
    assert.equal(listed.secure, true);
    assert.deepEqual(await client.invoke('ai.key.set', { provider: 'gemini', key: fake }), {
      source: 'saved',
      last4: 'wxyz',
    });
    const after = await client.invoke('ai.keys');
    assert.ok(!JSON.stringify(after).includes(fake));
    const files = (await import('node:fs')).readdirSync(dataDir);
    assert.ok(files.includes('ai-keys.enc.json'));
    for (const name of files.filter(n => n.endsWith('.json') || n.endsWith('.db')))
      assert.ok(!(await readFile(join(dataDir, name))).includes(fake), name);
    await client.invoke('ai.key.delete', { provider: 'gemini' });
    assert.notEqual((await client.invoke('ai.keys')).providers.gemini.source, 'saved');
  });
  await check('paged reads and indexed search', async () => {
    const page = await client.invoke('state.get', { threadLimit: 4 });
    assert.equal(page.threads.length, 4);
    assert.equal(page.threadCount, 18);
    const last = page.threads.at(-1);
    const next = await client.invoke('threads.page', {
      before: { date: last.date, id: last.id },
      limit: 4,
    });
    assert.equal(next.threads.length, 4);
    assert.equal(new Set([...page.threads, ...next.threads].map(t => t.id)).size, 8);
    assert.ok(
      (await client.invoke('search', { query: 'gard has:attachment' })).some(
        t => t.id === 'garden',
      ),
    );
  });
  await check('triage and Undo reach the renderer as changes', async () => {
    await client.evaluate(
      'window.releaseEvents=[];window.aplos.subscribe(e=>{if(e.type==="changes")window.releaseEvents.push(e.payload)})',
    );
    await client.invoke('thread.update', { ids: ['garden'], patch: { status: 'done' } });
    assert.equal(
      (await client.invoke('state.get')).threads.find(t => t.id === 'garden').status,
      'done',
    );
    assert.ok(
      await client.evaluate(
        'window.releaseEvents.some(e=>e.threads?.put.some(t=>t.id==="garden"&&t.status==="done"))',
      ),
    );
    await client.invoke('thread.undo');
    assert.equal(
      (await client.invoke('state.get')).threads.find(t => t.id === 'garden').status,
      'new',
    );
  });
  await check('attachment bytes cross the packaged bridge', async () => {
    const a = await client.invoke('attachment.get', {
      threadId: 'garden',
      attachmentId: 'att-notes',
    });
    assert.match(Buffer.from(a.data, 'base64').toString(), /Community garden/);
  });
  const draft = {
    id: 'release-draft',
    accountId: 'work',
    to: 'reader@verification.example',
    cc: '',
    bcc: '',
    subject: 'Release smoke message',
    html: '<p>Original synthetic release verification.</p>',
    attachments: [],
    mode: 'new',
    signature: false,
    updatedAt: new Date().toISOString(),
    revision: 0,
  };
  await check('draft save, delayed send, Undo and local delivery', async () => {
    await client.invoke('draft.save', { draft });
    await client.invoke('settings.update', { patch: { undoSeconds: 10 } });
    await client.invoke('draft.send', { id: draft.id });
    assert.ok((await client.invoke('state.get')).drafts.find(d => d.id === draft.id).pendingSendAt);
    await client.invoke('draft.undoSend', { id: draft.id });
    assert.equal(
      (await client.invoke('state.get')).drafts.find(d => d.id === draft.id).pendingSendAt,
      undefined,
    );
    await client.invoke('settings.update', { patch: { undoSeconds: 0 } });
    await client.invoke('draft.send', { id: draft.id });
    await until(
      async () => !(await client.invoke('state.get')).drafts.some(d => d.id === draft.id),
      'local send',
    );
    assert.ok(
      (await client.invoke('state.get')).threads.some(
        t => t.subject === draft.subject && t.messages.some(m => m.sent),
      ),
    );
  });
  await check('calendar save, duplicate protection and removal', async () => {
    const event = {
      id: 'release-event',
      accountId: 'work',
      calendarId: 'demo-work',
      title: 'Synthetic release review',
      start: '2026-11-02T15:00:00Z',
      end: '2026-11-02T16:00:00Z',
      allDay: false,
      location: 'Local demo',
      description: 'No external calendar',
      guests: [],
    };
    await client.invoke('calendar.save', { event });
    assert.equal(
      (await client.invoke('calendar.save', { event: { ...event, id: 'duplicate' } })).id,
      event.id,
    );
    await client.invoke('calendar.delete', { id: event.id });
    assert.ok(!(await client.invoke('state.get')).events.some(e => e.id === event.id));
  });
  await check('popout ownership and save-before-close', async () => {
    const saved = await client.invoke('draft.save', {
      draft: { ...draft, id: 'release-popout', subject: 'Release persistent draft' },
    });
    await client.invoke('window.claim', { draftId: saved.id });
    await client.invoke('window.compose', { draftId: saved.id });
    const target = await until(
      async () =>
        (await targets()).find(t => t.type === 'page' && t.url.includes('draft=release-popout')),
      'compose popout',
    );
    const popout = await connect(target);
    await until(
      () =>
        popout.evaluate(
          `document.querySelector('[aria-label="Message body"]')?.innerHTML===${JSON.stringify(draft.html)}`,
        ),
      'popout editor',
    );
    await assert.rejects(
      client.invoke('draft.save', { draft: { ...saved, subject: 'Stale parent' } }),
      /another window/,
    );
    await popout.send('Page.bringToFront');
    await popout.evaluate(
      `(()=>{const e=document.querySelector('[aria-label="Message body"]');e.focus();const r=document.createRange();r.selectNodeContents(e);getSelection().removeAllRanges();getSelection().addRange(r);})()`,
    );
    await popout.send('Input.insertText', { text: 'Saved immediately before native close.' });
    assert.match(
      await popout.evaluate(`document.querySelector('[aria-label="Message body"]').innerHTML`),
      /Saved immediately before native close/,
      'Editor must contain the typed text before closing',
    );
    await popout.evaluate('window.close()').catch(error => {
      if (error.message !== 'Debug target closed') throw error;
    });
    await until(async () => !(await targets()).some(t => t.id === target.id), 'popout close');
    assert.match(
      (await client.invoke('state.get')).drafts.find(d => d.id === saved.id).html,
      /Saved immediately before native close/,
    );
  });
  await check('invalid requests fail without damaging stored mail', async () => {
    await assert.rejects(
      client.invoke('settings.update', { patch: { undoSeconds: -1 } }),
      /between/,
    );
    await assert.rejects(client.invoke('not.allowed'), /Unsupported/);
    assert.equal((await client.invoke('state.get')).accounts.length, 2);
  });
  await client.invoke('settings.update', { patch: { theme: 'dark' } });
  await check('engine crash restarts and keeps persisted changes', async () => {
    const before = await client.invoke('state.get');
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
      const s = await client.invoke('state.get');
      return s.epoch !== before.epoch && s;
    }, 'engine restart');
    assert.equal((await client.invoke('state.get')).settings.theme, 'dark');
    await until(
      () => client.evaluate('document.documentElement.dataset.theme==="dark"'),
      'renderer resync after restart',
    );
  });
  await check('desktop restart preserves drafts, settings and sent mail', async () => {
    await stop();
    client = await launch();
    const s = await client.invoke('state.get');
    assert.equal(s.settings.theme, 'dark');
    assert.match(
      s.drafts.find(d => d.id === 'release-popout').html,
      /Saved immediately before native close/,
    );
    assert.ok(s.threads.some(t => t.subject === draft.subject));
  });
  const capabilities = await client.invoke('capabilities.get');
  await check('missing OAuth setup fails clearly without connecting', async () => {
    if (!capabilities.google)
      await assert.rejects(
        client.invoke('account.connect', { provider: 'google' }),
        /sign-in isn’t available in this build/,
      );
    if (!capabilities.microsoft)
      await assert.rejects(
        client.invoke('account.connect', { provider: 'microsoft' }),
        /sign-in isn’t available in this build/,
      );
    assert.equal((await client.invoke('state.get')).accounts.length, 2);
  });
  if (process.argv.includes('--live-ai')) {
    assert.ok(
      capabilities.groq,
      'Live AI verification requires GROQ_API_KEY in the backend environment',
    );
    await check('live Groq summary and classification on original demo mail', async () => {
      const t = await client.invoke('ai.summarize', { threadId: 'garden' });
      assert.ok(t.summary.length > 10);
      assert.ok(['important', 'low'].includes(t.importance));
    });
    await check('live Groq proofreading and reviewable draft proposal', async () => {
      const polished = await client.invoke('ai.polish', {
        html: '<p>Thank you for youre help with the synthetic demo.</p>',
      });
      assert.ok(polished.html.length > 10);
      const before = (await client.invoke('state.get')).drafts;
      const proposal = await client.invoke('ai.draft', {
        instruction:
          'Write a short thank-you note to reader@verification.example about the garden. Do not send it.',
      });
      assert.ok(proposal.html.length > 10);
      assert.deepEqual((await client.invoke('state.get')).drafts, before);
    });
    await check('live Groq Ask, scoped citations and calendar extraction', async () => {
      const conversation = await client.invoke('ai.ask', {
        message:
          'What does Maya need help with in the community garden? Cite the relevant message.',
        accountId: 'personal',
      });
      const answer = conversation.messages.at(-1);
      assert.ok(answer.content.length > 10);
      assert.ok(answer.citations.includes('garden'));
      const events = await client.invoke('calendar.extract', { threadId: 'review' });
      assert.ok(Array.isArray(events));
    });
    await check('live Groq transcription of generated synthetic speech', async () => {
      const audioPath = join(dataDir, 'synthetic-voice.aiff');
      const wavPath = join(dataDir, 'synthetic-voice.wav');
      execFileSync('/usr/bin/say', [
        '-o',
        audioPath,
        'Please draft a short note thanking the team for helping in the garden.',
      ]);
      execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', audioPath, wavPath]);
      const result = await client.invoke('ai.transcribe', {
        audio: (await readFile(wavPath)).toString('base64'),
        mimeType: 'audio/wav',
      });
      assert.match(result.text, /garden|team/i);
    });
  }
  const report = {
    date: new Date().toISOString(),
    checks,
    capabilities,
    liveMailboxVerified: false,
    dataDir,
    port,
    pid: child.pid,
  };
  await writeFile(join(dataDir, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes('--keep-open')) {
    for (const ws of sockets) ws.close();
    child.unref();
    child = undefined;
  }
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
if (stopError && failure)
  console.error('verify-release: cleanup also failed:', stopError?.message ?? stopError);
if (failure) throw failure;
if (stopError) throw stopError;
