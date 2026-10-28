import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, AppState, Thread } from '@aplos/contract/legacy/types';
import type { SyncResult } from '@aplos/engine/legacy/provider';
import { createMailStore } from '@aplos/engine/legacy/store';
import { applySync, mergeStatus } from '@aplos/engine/legacy/merge';
import { createGate } from '@aplos/engine/legacy/gate';
import { createStore, openDatabase } from '../src/main/store';
import { createDemo, defaultSettings } from '../src/main/demo';
import { createGoogle } from '../src/main/google';
import { createGroq } from '../src/main/groq';
import { createService } from '../src/main/service';

const temp = (name: string) => mkdtemp(join(tmpdir(), `aplos-${name}-`));
const message = (id: string, from = 'sam@example.test', sent = false) => ({
  id,
  from,
  fromName: 'Sam',
  to: ['alex@example.test'],
  date: '2026-10-14T10:00:00Z',
  text: `Message ${id} about the studio budget`,
  attachments: [],
  sent,
});
const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({
  id,
  accountId: 'g',
  subject: 'Studio budget',
  summary: '',
  messages: [message(`${id}-m1`)],
  date: '2026-10-14T10:00:00Z',
  unread: true,
  status: 'new',
  importance: 'important',
  bookmarked: false,
  replyStatus: 'none',
  remoteId: id.split(':')[1],
  labels: ['INBOX', 'UNREAD'],
  ...patch,
});
const empty = (patch: Partial<SyncResult> = {}): SyncResult => ({
  threads: [],
  flags: [],
  removed: [],
  reset: false,
  ...patch,
});

test('the SQLite store round-trips state, writes only changed rows, searches by word prefix and keeps cursors', async () => {
  const dir = await temp('store');
  try {
    const db = openDatabase(join(dir, 'aplos.db'));
    let writes = 0,
      ftsDeletes = 0;
    const counting = {
      ...db,
      prepare(sql: string) {
        const statement = db.prepare(sql);
        return /^(INSERT|UPDATE|DELETE)/.test(sql)
          ? {
              ...statement,
              run: (...p: any[]) => {
                writes++;
                if (sql.startsWith('DELETE FROM thread_text')) ftsDeletes++;
                return statement.run(...p);
              },
            }
          : statement;
      },
    };
    const store = createMailStore(counting);
    const state = createDemo(new Date('2026-10-14T12:00:00Z'));
    store.save(state);
    assert.equal(
      ftsDeletes,
      0,
      'fresh ingestion never scans the existing FTS table to delete a nonexistent entry',
    );
    const first = writes;
    writes = 0;
    store.save(state);
    assert.equal(writes, 0, 'an unchanged snapshot writes nothing');
    const next = structuredClone(state);
    next.threads[0].unread = !next.threads[0].unread;
    next.settings.theme = 'dark';
    store.save(next);
    assert.equal(
      writes,
      2,
      'a flag-only edit writes its thread row and setting without rebuilding search',
    );
    assert.ok(first > writes);
    const loaded = store.load()!;
    assert.equal(loaded.threads.length, state.threads.length);
    assert.equal(loaded.settings.theme, 'dark');
    assert.deepEqual(loaded.accounts, state.accounts);
    assert.deepEqual(
      loaded.threads.map(t => t.date),
      [...loaded.threads.map(t => t.date)].sort().reverse(),
    );
    const garden = state.threads.find(t => t.id === 'garden')!;
    assert.ok(store.searchText('gard').includes('garden'), 'prefix of a word matches');
    assert.ok(
      store.searchText(garden.messages[0].fromName.split(' ')[0]).includes('garden'),
      'sender names are indexed',
    );
    assert.deepEqual(
      store.searchText('"gard" OR *'),
      store.searchText('gard OR'),
      'FTS syntax in user text is treated as words',
    );
    assert.equal(
      store
        .searchText('gard', garden.accountId === 'work' ? 'personal' : 'work')
        .includes('garden'),
      false,
      'account filter applies',
    );
    const edited = next.threads.find(t => t.id === 'garden')!;
    edited.subject = 'Needlefinch migration';
    edited.summary = '';
    edited.messages = edited.messages.map(m => ({ ...m, text: 'Replacement searchable content.' }));
    store.save(next);
    assert.ok(store.searchText('needlefinch').includes('garden'));
    assert.ok(
      !store.searchText('community garden').includes('garden'),
      'body edits replace stale search terms',
    );
    next.threads = next.threads.filter(t => t.id !== 'garden');
    store.save(next);
    assert.equal(
      store.searchText('gard').includes('garden'),
      false,
      'removed threads leave the index',
    );
    store.setCursor('g', '42');
    assert.equal(store.cursor('g'), '42');
    store.setCursor('g', undefined);
    assert.equal(store.cursor('g'), undefined);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an existing state.json is imported once and kept as a backup; damaged files are preserved', async () => {
  const dir = await temp('import');
  try {
    const legacy = createDemo(new Date('2026-10-14T12:00:00Z'));
    legacy.settings.theme = 'dark';
    await writeFile(join(dir, 'state.json'), JSON.stringify(legacy));
    const store = createStore(dir);
    const read = store.read()!;
    assert.equal(read.settings.theme, 'dark');
    assert.equal(read.threads.length, legacy.threads.length);
    assert.ok(!existsSync(join(dir, 'state.json')));
    assert.ok(existsSync(join(dir, 'state.json.imported')));
    store.close();
    const again = createStore(dir);
    assert.equal(again.read()!.settings.theme, 'dark');
    again.close();
    const broken = await temp('import-broken');
    try {
      await writeFile(join(broken, 'state.json'), '{not json');
      assert.throws(() => createStore(broken), /recovery copy/);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('status merge keeps Aplos triage, follows the host for trash, spam and archive, and returns threads on new mail', () => {
  const read = { doneAction: 'read', laterAction: 'read' } as const,
    archive = { doneAction: 'archive', laterAction: 'archive' } as const;
  assert.equal(
    mergeStatus('done', 'new', false, read),
    'done',
    'Done that only marks read keeps the inbox label',
  );
  assert.equal(
    mergeStatus('done', 'new', false, archive),
    'new',
    'moved back to the inbox elsewhere',
  );
  assert.equal(mergeStatus('later', 'done', false, archive), 'later');
  assert.equal(mergeStatus('later', 'new', true, read), 'new', 'a reply brings it back');
  assert.equal(mergeStatus('new', 'done', false, read), 'done', 'archived elsewhere');
  assert.equal(mergeStatus('done', 'trash', false, read), 'trash');
  assert.equal(mergeStatus('spam', 'new', false, read), 'new', 'marked not spam elsewhere');
  const state = {
    ...createDemo(new Date()),
    threads: [
      thread('g:a', {
        status: 'done',
        todo: 'Pay',
        labels: ['INBOX'],
        action: { kind: 'reply', label: 'Reply', prompt: 'Confirm the payment date' },
      }),
      thread('g:b'),
      thread('g:c'),
      thread('other:x', { accountId: 'other' }),
    ],
  } as AppState;
  state.settings = { ...defaultSettings, doneAction: 'read' };
  state.blockedSenders = ['spam@example.test'];
  const outcome = applySync(
    state,
    'g',
    empty({
      threads: [
        thread('g:a', {
          messages: [message('g:a-m1'), message('g:a-m2')],
          labels: ['INBOX', 'UNREAD'],
        }),
        thread('g:new', { messages: [message('n1', 'spam@example.test')] }),
      ],
      flags: [{ id: 'g:b', unread: false, bookmarked: true, status: 'done', labels: [] }],
      removed: ['g:c', 'other:x'],
    }),
  );
  const by = (id: string) => state.threads.find(t => t.id === id);
  assert.equal(by('g:a')!.status, 'new');
  assert.equal(by('g:a')!.todo, 'Pay', 'workflow fields survive');
  assert.equal(
    by('g:a')!.action?.prompt,
    'Confirm the payment date',
    'the suggested action survives sync',
  );
  assert.equal(by('g:b')!.unread, false);
  assert.equal(by('g:b')!.bookmarked, true);
  assert.equal(by('g:b')!.status, 'done');
  assert.equal(by('g:c'), undefined);
  assert.ok(by('other:x'), 'removals are scoped to the synced account');
  assert.equal(by('g:new')!.status, 'spam', 'blocked senders go to spam');
  assert.deepEqual(
    outcome.added.map(t => t.id),
    ['g:new'],
  );
  assert.ok(outcome.arrivals.some(t => t.id === 'g:a'));
  const sentOnly = applySync(
    state,
    'g',
    empty({
      threads: [
        thread('g:a', {
          messages: [...by('g:a')!.messages, message('mine', 'alex@example.test', true)],
        }),
      ],
    }),
  );
  assert.equal(sentOnly.arrivals.length, 0, 'your own reply is not new mail');
});

test('the sync gate runs one sync at a time per account, spaces automatic runs and backs off after failures', async () => {
  let clock = 0;
  const gate = createGate({
    now: () => clock,
    minIntervalMs: 15_000,
    backoffMs: 30_000,
    maxBackoffMs: 120_000,
  });
  let release!: () => void,
    calls = 0;
  const slow = gate.run('a', () => {
    calls++;
    return new Promise<void>(r => {
      release = r;
    });
  });
  assert.equal(gate.ready('a', true), false, 'even a manual sync waits for the running one');
  const joined = gate.run('a', async () => {
    calls++;
  });
  release();
  await Promise.all([slow, joined]);
  assert.equal(calls, 1);
  assert.equal(gate.ready('a'), false);
  assert.equal(gate.ready('a', true), true);
  assert.equal(gate.ready('b'), true);
  clock = 15_000;
  assert.equal(gate.ready('a'), true);
  for (const expected of [30_000, 60_000, 120_000, 120_000]) {
    await assert.rejects(
      gate.run('a', async () => {
        throw new Error('offline');
      }),
    );
    const failedAt = clock;
    clock = failedAt + expected - 1;
    assert.equal(gate.ready('a'), false);
    clock = failedAt + expected;
    assert.equal(gate.ready('a'), true);
  }
  await gate.run('a', async () => {});
  assert.equal(gate.failures('a'), 0);
});

const account: Account = {
  id: 'google-test',
  name: 'Alex',
  email: 'alex@example.test',
  provider: 'google',
  connected: true,
  color: '#aaa',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const encrypt = (text: string) => Buffer.from(text).reverse();
const decrypt = (buffer: Buffer) => Buffer.from(buffer).reverse().toString();
const gmailMessage = (id: string, labels: string[]) => ({
  id,
  threadId: id,
  internalDate: '1791972000000',
  labelIds: labels,
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'Subject', value: `Subject ${id}` },
      { name: 'From', value: 'Sam <sam@example.test>' },
    ],
    body: { data: Buffer.from(`Body ${id}`).toString('base64url') },
  },
});

test('Gmail follows history: label-only changes skip bodies, new mail is fetched, deleted threads are removed, expired cursors start fresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-history-'));
  await writeFile(
    join(dir, 'google-tokens.enc.json'),
    JSON.stringify({
      [account.id]: encrypt(
        JSON.stringify({ access_token: 't', expiresAt: Date.now() + 3600000 }),
      ).toString('base64'),
    }),
  );
  const requests: string[] = [];
  let expired = false;
  const google = await createGoogle({
    dataDir: dir,
    clientId: 'own-client',
    encrypt,
    decrypt,
    fetch: async input => {
      const url = new URL(String(input));
      requests.push(url.pathname + url.search);
      if (url.pathname.endsWith('/history')) {
        if (expired) return json({ error: { code: 404 } }, 404);
        if (!url.searchParams.get('pageToken'))
          return json({
            historyId: '210',
            nextPageToken: 'p2',
            history: [
              { labelsRemoved: [{ message: { id: 'known', threadId: 'known' } }] },
              { labelsAdded: [{ message: { id: 'old', threadId: 'old' } }] },
            ],
          });
        return json({
          historyId: '220',
          history: [
            { messagesAdded: [{ message: { id: 'fresh', threadId: 'fresh' } }] },
            { messagesDeleted: [{ message: { id: 'gone', threadId: 'gone' } }] },
            { labelsAdded: [{ message: { id: 'fresh', threadId: 'fresh' } }] },
          ],
        });
      }
      if (url.pathname.endsWith('/profile')) return json({ historyId: '500' });
      if (url.pathname.endsWith('/threads')) return json({ threads: [{ id: 'fresh' }] });
      const id = url.pathname.split('/').at(-1)!;
      if (id === 'gone') return json({ error: { code: 404 } }, 404);
      const labels =
        id === 'known' ? ['STARRED'] : id === 'old' ? ['CATEGORY_UPDATES'] : ['INBOX', 'UNREAD'];
      return json({ id, messages: [gmailMessage(id, labels)] });
    },
  });
  try {
    const has = (id: string) => ['google-test:known', 'google-test:gone'].includes(id);
    const result = await google.sync(account, '200', { has });
    assert.equal(result.cursor, '220');
    assert.equal(result.reset, false);
    assert.deepEqual(result.flags, [
      {
        id: 'google-test:known',
        unread: false,
        bookmarked: true,
        status: 'done',
        labels: ['STARRED'],
      },
    ]);
    assert.deepEqual(
      result.threads.map(t => t.id),
      ['google-test:fresh'],
      'an unknown thread outside the inbox is not pulled in',
    );
    assert.deepEqual(result.removed, ['google-test:gone']);
    assert.ok(requests.some(r => r.includes('/threads/known?format=minimal')));
    assert.ok(!requests.some(r => r.includes('/threads/known?format=full')));
    assert.ok(
      requests.some(
        r =>
          r.includes('/history?') &&
          r.includes('historyTypes=labelAdded') &&
          r.includes('startHistoryId=200'),
      ),
    );
    expired = true;
    requests.length = 0;
    const fresh = await google.sync(account, '200', { has });
    assert.equal(fresh.reset, true);
    assert.equal(fresh.cursor, '500');
    assert.deepEqual(
      fresh.threads.map(t => t.id),
      ['google-test:fresh'],
    );
    assert.ok(
      requests.findIndex(r => r.endsWith('/profile')) <
        requests.findIndex(r => r.includes('/threads?')),
      'the position is read before the window downloads',
    );
    assert.ok(
      requests.some(r => r.includes('maxResults=500') && r.includes('includeSpamTrash=true')),
    );
  } finally {
    google.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('service sync resumes from the stored cursor, keeps Done across syncs, notifies only real new mail and paces background syncs', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-incremental-'));
  const base = await createGoogle({ dataDir, clientId: '' });
  const cursors: (string | undefined)[] = [],
    notes: string[] = [];
  let next: SyncResult = empty({
    reset: true,
    cursor: '1',
    threads: [thread('g1:a', { accountId: 'g1' }), thread('g1:b', { accountId: 'g1' })],
  });
  const google = {
    ...base,
    available: true,
    connect: async () => ({ ...account, id: 'g1' }),
    getSendAs: async () => [],
    updateThread: async () => {},
    sync: async (_a: Account, cursor?: string) => {
      cursors.push(cursor);
      const value = structuredClone(next);
      next = empty({ cursor: String(Number(cursor ?? 0) + 1) });
      return value;
    },
  };
  let service = await createService({
    dataDir,
    google,
    groq: createGroq({ apiKey: '' }),
    autoSyncMs: 0,
  });
  service.subscribe(event => {
    if (event.type === 'notification') notes.push((event.payload as { threadId: string }).threadId);
  });
  try {
    await service.invoke('account.connect');
    await service.invoke('settings.update', { patch: { doneAction: 'read', notifications: true } });
    assert.equal(notes.length, 0, 'existing mail from a first sync is not announced');
    await service.invoke('thread.update', { ids: ['g1:a'], patch: { status: 'done' } });
    next = empty({
      cursor: '2',
      flags: [{ id: 'g1:a', unread: false, bookmarked: false, status: 'new', labels: ['INBOX'] }],
    });
    let state = (await service.invoke('sync')) as AppState;
    assert.deepEqual(cursors, [undefined, '1']);
    assert.equal(
      state.threads.find(t => t.id === 'g1:a')!.status,
      'done',
      'Done survives a sync that still sees the inbox label',
    );
    await service.invoke('sync', { auto: true });
    assert.equal(cursors.length, 2, 'a background sync right after another one waits');
    await service.close();
    service = await createService({
      dataDir,
      google,
      groq: createGroq({ apiKey: '' }),
      autoSyncMs: 0,
    });
    service.subscribe(event => {
      if (event.type === 'notification')
        notes.push((event.payload as { threadId: string }).threadId);
    });
    next = empty({
      cursor: '9',
      threads: [
        thread('g1:a', {
          accountId: 'g1',
          date: '2099-01-01T00:00:00Z',
          messages: [message('g1:a-m1'), message('g1:a-m2')],
        }),
      ],
    });
    state = (await service.invoke('sync', { auto: true })) as AppState;
    assert.equal(cursors.at(-1), '2', 'the cursor survives a restart');
    assert.equal(
      state.threads.find(t => t.id === 'g1:a')!.status,
      'new',
      'a reply returns it to Home',
    );
    assert.deepEqual(notes, ['g1:a']);
    assert.equal(state.sync.busy, false);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
