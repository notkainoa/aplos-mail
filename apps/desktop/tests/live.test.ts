import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import type { AppState, Thread } from '@aplos/contract/legacy/types';
import {
  applyChanges,
  createLiveState,
  threadOrder,
  type StateChanges,
  type ThreadPage,
} from '@aplos/contract/legacy/live';
import { createService } from '../src/main/service';
import { createGoogle } from '../src/main/google';
import { createGroq } from '../src/main/groq';
import { connectEngine, serveEngine, type Port } from '../src/main/engine-rpc';
import { createCipher, isSealed, loadDataKey, migrateCredentials } from '../src/main/keyring';
import { createVault } from '../src/main/vault';

const temp = (name: string) => mkdtemp(join(tmpdir(), `aplos-${name}-`));
async function service(dataDir: string) {
  return createService({
    dataDir,
    google: await createGoogle({ dataDir, clientId: '' }),
    groq: createGroq({ apiKey: '' }),
    autoSyncMs: 0,
  });
}
/** Every thread of a mailbox read the way a window does: the newest first, then the rest in pages. */
async function readPaged(
  invoke: (method: string, payload?: unknown) => Promise<unknown>,
  limit: number,
) {
  const first = (await invoke('state.get', { threadLimit: limit })) as AppState;
  const threads = [...first.threads];
  let next: { date: string; id: string } | undefined = [...first.threads].sort(threadOrder).at(-1);
  let pages = 0;
  while (next && first.threadCount) {
    const page = (await invoke('threads.page', { before: next, limit })) as ThreadPage;
    threads.push(...page.threads);
    next = page.next;
    pages++;
  }
  return { first, threads, pages };
}

test('commits reach windows as changes: only the touched thread, and nothing for a no-op', async () => {
  const dataDir = await temp('changes');
  const s = await service(dataDir);
  try {
    const events: StateChanges[] = [];
    s.subscribe(e => {
      if (e.type === 'changes') events.push(e.payload as StateChanges);
    });
    let copy = (await s.invoke('state.get')) as AppState;
    const target = copy.threads.find(t => t.status === 'new')!;
    await s.invoke('thread.update', { ids: [target.id], patch: { status: 'done' } });
    assert.equal(events.length, 1);
    assert.deepEqual(
      events[0].threads?.put.map(t => t.id),
      [target.id],
      'one thread row',
    );
    assert.equal(events[0].settings, undefined, 'unchanged settings are not resent');
    assert.equal(events[0].rev, (copy.rev ?? 0) + 1);
    await s.invoke('settings.update', { patch: { zen: copy.settings.zen } });
    assert.equal(events.length, 1, 'a change that saves nothing sends nothing');
    await s.invoke('settings.update', { patch: { zen: !copy.settings.zen } });
    assert.equal(events.length, 2);
    assert.equal(events[1].threads, undefined);
    assert.equal(events[1].settings?.zen, !copy.settings.zen);
    for (const e of events) copy = applyChanges(copy, e);
    const fresh = (await s.invoke('state.get')) as AppState;
    assert.deepEqual(copy, fresh, 'applying the changes reproduces the engine state');
  } finally {
    await s.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('paged reads return every thread exactly once, newest first', async () => {
  const dataDir = await temp('pages');
  const s = await service(dataDir);
  try {
    const all = ((await s.invoke('state.get')) as AppState).threads;
    const { first, threads, pages } = await readPaged(s.invoke, 4);
    assert.equal(first.threads.length, 4);
    assert.equal(first.threadCount, all.length);
    assert.ok(pages >= 2);
    assert.deepEqual(
      threads.map(t => t.id),
      [...all].sort(threadOrder).map(t => t.id),
    );
    const whole = (await s.invoke('state.get', { threadLimit: all.length })) as AppState;
    assert.equal(whole.threadCount, undefined, 'a limit at or above the total returns everything');
  } finally {
    await s.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

const thread = (id: string, date: string): Thread => ({
  id,
  accountId: 'a',
  subject: id,
  summary: '',
  messages: [],
  date,
  unread: false,
  status: 'new',
  importance: 'low',
  bookmarked: false,
  replyStatus: 'none',
});
const base = (threads: Thread[], rev = 1): AppState => ({
  version: 1,
  accounts: [],
  threads,
  drafts: [],
  events: [],
  conversations: [],
  settings: {} as AppState['settings'],
  selectedAccountId: 'all',
  sync: { busy: false },
  blockedSenders: [],
  epoch: 'e1',
  rev,
});

test('a window copy replays early changes, ignores old ones, resyncs on a gap and never restores removed threads', () => {
  const updates: AppState[] = [];
  let resyncs = 0;
  const live = createLiveState({ update: s => updates.push(s), resync: () => resyncs++ });
  // A change that arrives before the snapshot it follows is replayed onto it.
  live.apply({
    epoch: 'e1',
    rev: 2,
    threads: { put: [thread('new', '2026-10-15')], remove: ['b'] },
  });
  live.snapshot(base([thread('a', '2026-10-14'), thread('b', '2026-10-13')]));
  assert.deepEqual(
    live.state!.threads.map(t => t.id),
    ['a', 'new'],
  );
  assert.equal(live.state!.rev, 2);
  live.apply({ epoch: 'e1', rev: 2, selectedAccountId: 'x' });
  assert.equal(live.state!.selectedAccountId, 'all', 'an old change is ignored');
  // A page computed before 'b' was removed must not bring it back; known threads keep the newer copy.
  assert.equal(
    live.page({
      epoch: 'e1',
      rev: 1,
      threads: [
        thread('b', '2026-10-13'),
        { ...thread('a', '2026-10-14'), subject: 'stale' },
        thread('c', '2026-10-01'),
      ],
    }),
    true,
  );
  assert.deepEqual(
    live.state!.threads.map(t => t.id),
    ['a', 'new', 'c'],
  );
  assert.equal(live.state!.threads[0].subject, 'a');
  assert.equal(
    live.page({ epoch: 'other', rev: 1, threads: [thread('z', '2026-01-01')] }),
    false,
    'pages from another engine run are refused',
  );
  // A missed change asks for a fresh snapshot and holds later changes for it.
  live.apply({ epoch: 'e1', rev: 4, selectedAccountId: 'late' });
  assert.equal(resyncs, 1);
  assert.equal(live.state!.selectedAccountId, 'all');
  live.snapshot({ ...base([thread('a', '2026-10-14')]), rev: 3 });
  assert.equal(
    live.state!.selectedAccountId,
    'late',
    'held changes replay onto the fresh snapshot',
  );
  assert.equal(live.state!.rev, 4);
  // A restarted engine starts a new epoch; its changes need a snapshot first.
  live.apply({ epoch: 'e2', rev: 1, selectedAccountId: 'restarted' });
  assert.equal(resyncs, 2);
  const unchanged = live.state!.threads[0];
  live.snapshot({ ...base([unchanged]), epoch: 'e2', rev: 0 });
  assert.equal(live.state!.selectedAccountId, 'restarted');
  live.apply({ epoch: 'e2', rev: 2, threads: { put: [thread('d', '2026-10-16')], remove: [] } });
  assert.equal(live.state!.threads[0], unchanged, 'unchanged threads keep their identity');
});

test('a failed resync is retried with backoff until the copy catches up to the latest change', async () => {
  let calls = 0,
    latest = base([thread('a', '2026-10-14')], 3);
  const live = createLiveState(
    {
      update: () => {},
      resync: async () => {
        calls++;
        if (calls === 1) throw new Error('engine restarting');
        live.snapshot(latest);
      },
    },
    { minMs: 10, maxMs: 40 },
  );
  live.snapshot(base([thread('a', '2026-10-14')], 1));
  live.apply({ epoch: 'e1', rev: 3, selectedAccountId: 'gap' });
  assert.equal(calls, 1);
  live.apply({ epoch: 'e1', rev: 4, selectedAccountId: 'newest' });
  assert.equal(calls, 1, 'changes while a request is running do not start another');
  latest = { ...latest, selectedAccountId: 'gap' };
  for (let i = 0; i < 100 && live.state!.rev !== 4; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(calls, 2, 'the failed request was retried once');
  assert.equal(live.state!.rev, 4);
  assert.equal(
    live.state!.selectedAccountId,
    'newest',
    'buffered changes replay onto the retried snapshot',
  );
});

/** Two ends of an in-memory channel shaped like the utility process port. */
function channel(): [Port, Port, () => void] {
  const { port1, port2 } = new MessageChannel();
  const wrap = (port: typeof port1): Port => ({
    post: m => port.postMessage(m),
    listen: h => port.on('message', h),
  });
  return [
    wrap(port1),
    wrap(port2),
    () => {
      port1.close();
      port2.close();
    },
  ];
}

test('the engine runs behind a port: requests, errors, changes, calls into main and a clean close', async () => {
  const dataDir = await temp('rpc');
  const [engineSide, mainSide, closePorts] = channel();
  const opened: string[] = [];
  let exited = false;
  serveEngine(
    engineSide,
    async (init, call) => {
      const s = await service(init.dataDir);
      // Stand in for an adapter that opens a sign-in page through the main process.
      return {
        ...s,
        invoke: async (method: string, payload?: unknown) =>
          method === 'test.open'
            ? call('openExternal', 'https://example.test/login')
            : s.invoke(method, payload),
      };
    },
    () => {
      exited = true;
    },
  );
  const engine = connectEngine(mainSide, { dataDir }, async (method, args) => {
    opened.push(`${method} ${args[0]}`);
    return true;
  });
  try {
    await engine.started;
    const events: StateChanges[] = [];
    engine.subscribe(e => {
      if (e.type === 'changes') events.push(e.payload as StateChanges);
    });
    const { threads, first } = await readPaged(engine.invoke, 5);
    assert.equal(threads.length, first.threadCount);
    await assert.rejects(
      engine.invoke('thread.update', { ids: ['missing'], patch: { status: 'done' } }),
      /Message not found/,
    );
    await engine.invoke('thread.update', {
      ids: [threads[0].id],
      patch: { bookmarked: !threads[0].bookmarked },
    });
    for (let i = 0; i < 50 && !events.length; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(events[0]?.threads?.put[0].id, threads[0].id);
    assert.equal(await engine.invoke('test.open'), true);
    assert.deepEqual(opened, ['openExternal https://example.test/login']);
    await engine.close();
    assert.equal(exited, true);
    engine.fail(new Error('stopped'));
    await assert.rejects(
      engine.invoke('state.get'),
      /stopped/,
      'requests after the engine stops fail instead of hanging',
    );
  } finally {
    engine.fail(new Error('done'));
    closePorts();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the credential key is created once, never replaced, and old keychain-sealed credentials are re-sealed', async () => {
  const dataDir = await temp('keyring');
  try {
    // A stand-in keychain: reversible, and lockable like a real one.
    let locked = false;
    const keychain = {
      available: () => true,
      encrypt: (v: string) => Buffer.from(`kc:${v}`),
      decrypt: (b: Buffer) => {
        if (locked) throw new Error('locked');
        const v = b.toString();
        if (!v.startsWith('kc:')) throw new Error('bad');
        return v.slice(3);
      },
    };
    const key = await loadDataKey(dataDir, keychain);
    assert.deepEqual(await loadDataKey(dataDir, keychain), key, 'the same key on every start');
    const before = await readFile(join(dataDir, 'engine-key.bin'));
    locked = true;
    await assert.rejects(loadDataKey(dataDir, keychain), /Unlock/);
    assert.deepEqual(
      await readFile(join(dataDir, 'engine-key.bin')),
      before,
      'a locked keychain does not replace the key file',
    );
    locked = false;
    const cipher = createCipher(key);
    // A vault written the old way, with one entry the keychain can no longer open.
    const legacy = await createVault<string>({
      dataDir,
      encrypt: keychain.encrypt,
      decrypt: keychain.decrypt,
      file: 'imap-credentials.enc.json',
    });
    await legacy.set('acct', 'app-password');
    const raw = JSON.parse(await readFile(join(dataDir, 'imap-credentials.enc.json'), 'utf8'));
    raw.broken = Buffer.from('not openable').toString('base64');
    await writeFile(join(dataDir, 'imap-credentials.enc.json'), JSON.stringify(raw));
    assert.equal(await migrateCredentials(dataDir, keychain.decrypt, cipher), 1);
    const sealed = JSON.parse(await readFile(join(dataDir, 'imap-credentials.enc.json'), 'utf8'));
    assert.ok(isSealed(Buffer.from(sealed.acct, 'base64')));
    assert.equal(sealed.broken, raw.broken, 'unreadable entries are kept as they were');
    assert.equal(
      await migrateCredentials(dataDir, keychain.decrypt, cipher),
      0,
      'migration runs once',
    );
    const vault = await createVault<string>({
      dataDir,
      encrypt: cipher.encrypt,
      decrypt: cipher.decrypt,
      file: 'jmap-credentials.enc.json',
    });
    await vault.set('acct', 'token');
    const reopened = await createVault<string>({
      dataDir,
      encrypt: cipher.encrypt,
      decrypt: cipher.decrypt,
      file: 'jmap-credentials.enc.json',
    });
    assert.equal(reopened.get('acct'), 'token');
    const tampered = Buffer.from(sealed.acct, 'base64');
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() => cipher.decrypt(tampered));
    assert.ok(existsSync(join(dataDir, 'engine-key.bin')));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
