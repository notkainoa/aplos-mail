import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, Thread } from '@aplos/contract/legacy/types';
import type { AppDataRecord, MailProvider, ProviderMemory } from '@aplos/engine/legacy/provider';
import { createWorkflowSync } from '../src/main/workflow-sync';
import { openWorkflow, sealWorkflow } from '../src/main/workflow-crypto';

const T0 = Date.parse('2026-10-20T12:00:00Z');
const account: Account = {
  id: 'acct',
  name: 'Alex',
  email: 'alex@example.test',
  provider: 'google',
  connected: true,
  color: '#888',
};
const thread = (remoteId: string, patch: Partial<Thread> = {}): Thread => ({
  id: `acct:${remoteId}`,
  accountId: 'acct',
  remoteId,
  subject: 'Hello',
  summary: '',
  date: '2026-10-01T10:00:00Z',
  messages: [
    {
      id: `${remoteId}-1`,
      from: 'sam@example.test',
      fromName: 'Sam',
      to: [account.email],
      date: '2026-10-01T10:00:00Z',
      text: 'Hi',
      attachments: [],
    },
  ],
  unread: false,
  status: 'new',
  importance: 'important',
  bookmarked: false,
  replyStatus: 'none',
  ...patch,
});
const keychain = {
  encrypt: (v: string) => Buffer.from(`kc:${v}`),
  decrypt: (b: Buffer) => b.toString().slice(3),
};

/** Provider memory whose writes inside a round are staged and kept only when the caller commits, like the service does. */
const scope = new AsyncLocalStorage<Map<string, string | undefined>>();
function memoryStore(): ProviderMemory & { commit(staged: Map<string, string | undefined>): void } {
  const data = new Map<string, string>(),
    k = (a: string, key: string) => `${a}\u0000${key}`;
  const put = (key: string, value: string | undefined) => {
    if (value === undefined) data.delete(key);
    else data.set(key, value);
  };
  return {
    get: (a, key) => {
      const o = scope.getStore();
      return o?.has(k(a, key)) ? o.get(k(a, key)) : data.get(k(a, key));
    },
    set: (a, key, value) => {
      const o = scope.getStore();
      if (o) o.set(k(a, key), value);
      else put(k(a, key), value);
    },
    clear: a => {
      for (const key of [...data.keys()]) if (key.startsWith(`${a}\u0000`)) data.delete(key);
    },
    commit: staged => {
      for (const [key, value] of staged) put(key, value);
    },
  };
}

/** The account's hidden storage: every copy, newest first, with a hook to interleave other work after a read. */
function host() {
  let seq = 0;
  const h = {
    copies: [] as AppDataRecord[],
    writes: [] as string[][],
    afterRead: undefined as undefined | (() => Promise<void> | void),
    provider: {
      readAppData: async () => {
        const copies = structuredClone(h.copies),
          hook = h.afterRead;
        h.afterRead = undefined;
        await hook?.();
        return copies;
      },
      writeAppData: async (_a: Account, data: string, replaces: string[]) => {
        h.copies.unshift({ id: `c${++seq}`, data });
        h.writes.push(replaces);
        h.copies = h.copies.filter(c => !replaces.includes(c.id));
      },
    } as unknown as MailProvider,
  };
  return h;
}

const dirs: string[] = [];
test.after(() => Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))));
async function device(
  h: ReturnType<typeof host>,
  clock: { now: number },
  threads: Thread[],
  code?: string,
) {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-workflow-'));
  dirs.push(dir);
  const memory = memoryStore(),
    sync = await createWorkflowSync({
      dataDir: dir,
      memory,
      now: () => new Date(clock.now),
      ...keychain,
    });
  const d = {
    sync,
    threads,
    code: await sync.enable(code),
    get: (remoteId: string) => d.threads.find(t => t.remoteId === remoteId)!,
    /** A user edit, saved on its own and not inside any round that is running. */
    edit(remoteId: string, patch: Partial<Thread>) {
      d.threads = d.threads.map(t => (t.remoteId === remoteId ? { ...t, ...patch } : t));
      scope.exit(() => sync.noteEdits([d.get(remoteId)]));
    },
    /** One round; `discard` drops its memory writes and patches, as the service does when it cannot keep them. */
    async round(discard = false) {
      const staged = new Map<string, string | undefined>();
      const patches = await scope.run(staged, () =>
        sync.round(account, h.provider, () => d.threads),
      );
      if (discard) return patches;
      memory.commit(staged);
      d.threads = d.threads.map(t => ({ ...t, ...patches.find(p => p.threadId === t.id)?.patch }));
      return patches;
    },
  };
  return d;
}
const entries = (h: ReturnType<typeof host>, code: string) =>
  h.copies.map(c => openWorkflow(c.data, code).entries);

test('the first device shares its existing state; joining devices take the shared log and apply it', async () => {
  const h = host(),
    clock = { now: T0 };
  const a = await device(h, clock, [
    thread('x', { status: 'later', todo: 'Call Sam' }),
    thread('y', { status: 'done' }),
    thread('z'),
  ]);
  await a.round();
  assert.deepEqual(
    Object.keys(entries(h, a.code)[0]),
    ['t:x'],
    'Later and its todo are seeded; a plain archive is not',
  );
  // The second device has its own (AI-set) reply state on z, which does not override anything: it joins.
  const b = await device(
    h,
    clock,
    [thread('x'), thread('y'), thread('z', { replyStatus: 'needs-reply' })],
    a.code,
  );
  assert.deepEqual(await b.round(), [
    { threadId: 'acct:x', patch: { status: 'later', todo: 'Call Sam' } },
  ]);
  assert.equal(h.writes.length, 1, 'nothing new to write');
  assert.deepEqual(await b.round(), [], 'applied once');
});

test('concurrent writers replace only what they read, so neither device loses its edits', async () => {
  const h = host(),
    clock = { now: T0 };
  const a = await device(h, clock, [thread('x'), thread('y')]),
    b = await device(h, clock, [thread('x'), thread('y')], a.code);
  a.edit('x', { status: 'later' });
  await a.round();
  b.edit('y', { todo: 'Pay' });
  a.edit('x', { todo: 'Reply' });
  // A reads the shared copy; before it writes, B reads the same copy and writes its own.
  h.afterRead = () => b.round().then(() => {});
  await a.round();
  assert.equal(h.copies.length, 2, 'both new copies are kept');
  await b.round();
  assert.equal(h.copies.length, 1, 'the next round merges and consolidates them');
  assert.deepEqual([b.get('x').status, b.get('x').todo], ['later', 'Reply']);
  await a.round();
  assert.equal(a.get('y').todo, 'Pay');
});

test('an edit made while a round runs is neither overwritten by a remote entry nor lost', async () => {
  const h = host(),
    clock = { now: T0 };
  const a = await device(h, clock, [thread('x')]),
    b = await device(h, clock, [thread('x')], a.code);
  b.edit('x', { status: 'done' });
  await b.round();
  clock.now += 1000;
  h.afterRead = () => {
    a.edit('x', { status: 'later', todo: 'Today' });
  };
  assert.deepEqual(await a.round(), [], 'the remote Done does not replace the edit just made');
  assert.equal(a.get('x').status, 'later');
  assert.equal(a.sync.hasEdits('acct'), true, 'still waiting to be shared');
  await a.round();
  assert.equal(a.sync.hasEdits('acct'), false);
  await b.round();
  assert.deepEqual([b.get('x').status, b.get('x').todo], ['later', 'Today']);
  assert.deepEqual(await a.round(), []);
});

test('a round whose results are discarded is done again: patches reapply and edits stay pending', async () => {
  const h = host(),
    clock = { now: T0 };
  const a = await device(h, clock, [thread('x'), thread('y')]),
    b = await device(h, clock, [thread('x'), thread('y')], a.code);
  a.edit('x', { status: 'later' });
  await a.round();
  b.edit('y', { todo: 'Pay' });
  assert.deepEqual(await b.round(true), [{ threadId: 'acct:x', patch: { status: 'later' } }]);
  assert.equal(b.sync.hasEdits('acct'), true);
  const writes = h.writes.length;
  assert.deepEqual(
    await b.round(),
    [{ threadId: 'acct:x', patch: { status: 'later' } }],
    'the remote entry was not marked applied',
  );
  assert.equal(
    h.writes.length,
    writes,
    'the edit already reached the host, so the redo writes nothing',
  );
  assert.equal(b.sync.hasEdits('acct'), false);
  await a.round();
  assert.equal(a.get('y').todo, 'Pay');
});

test('an entry for a thread this device downloads later still applies then', async () => {
  const h = host(),
    clock = { now: T0 };
  const a = await device(h, clock, [thread('x')]),
    b = await device(h, clock, [], a.code);
  a.edit('x', { status: 'later', dueDate: '2026-11-01' });
  await a.round();
  assert.deepEqual(await b.round(), []);
  b.threads = [thread('x')]; // arrives with a later mail sync, outside the inbox window before
  assert.deepEqual(await b.round(), [
    { threadId: 'acct:x', patch: { status: 'later', dueDate: '2026-11-01' } },
  ]);
});

test('conflicts go to the later edit, not the later sync', async () => {
  const h = host(),
    clock = { now: T0 };
  const a = await device(h, clock, [thread('x')]),
    b = await device(h, clock, [thread('x')], a.code);
  a.edit('x', { status: 'later' }); // first
  clock.now += 60_000;
  b.edit('x', { status: 'done', todo: 'Archive notes' });
  await b.round();
  clock.now += 60_000;
  assert.deepEqual(await a.round(), [
    { threadId: 'acct:x', patch: { status: 'done', todo: 'Archive notes' } },
  ]);
  assert.deepEqual(entries(h, a.code)[0]['t:x'].fields, {
    status: 'done',
    replyStatus: 'none',
    todo: 'Archive notes',
  });
});

test('copies with another code stop the round; damaged copies are replaced; unreadably large ones are kept', async () => {
  const h = host(),
    clock = { now: T0 };
  const a = await device(h, clock, [thread('x', { status: 'later' })]);
  h.copies.push({ id: 'broken', data: 'APLOS-WF1.AAAA.AAAA.AAAA.AAAA' });
  await a.round();
  assert.deepEqual(h.writes.at(-1), ['broken']);
  assert.deepEqual(
    h.copies.map(c => c.id),
    ['c1'],
  );
  h.copies.push({ id: 'huge', data: `APLOS-WF1.${'x'.repeat(2_000_001)}` });
  a.edit('x', { todo: 'More' });
  await a.round();
  assert.ok(
    h.copies.some(c => c.id === 'huge'),
    'possibly a newer device with larger limits: left alone',
  );
  assert.ok(!h.writes.at(-1)!.includes('huge'));
  const other = await device(h, clock, [thread('x')]);
  const before = structuredClone(h.copies);
  await assert.rejects(other.round(), /does not match/);
  assert.deepEqual(h.copies, before, 'nothing written or replaced');
});

test('a log too large for the host is trimmed to fit instead of failing every round', async () => {
  const h = host(),
    clock = { now: T0 };
  // Incompressible todos: 400 of them seal to well over the host limit.
  const threads = Array.from({ length: 400 }, (_, i) =>
    thread(`t${i}`, { status: 'later', todo: randomBytes(5000).toString('hex').slice(0, 10_000) }),
  );
  const a = await device(h, clock, threads);
  assert.throws(
    () =>
      sealWorkflow(
        {
          version: 1,
          entries: Object.fromEntries(
            threads.map((t, i) => [
              `t:${t.remoteId}`,
              {
                fields: { status: 'later', replyStatus: 'none', todo: t.todo },
                at: T0 + i,
                device: 'd',
              },
            ]),
          ),
        },
        a.code,
      ),
    /too large/,
  );
  await a.round();
  const kept = entries(h, a.code)[0];
  assert.ok(
    Object.keys(kept).length >= 100 && Object.keys(kept).length < 400,
    `kept ${Object.keys(kept).length}`,
  );
});
