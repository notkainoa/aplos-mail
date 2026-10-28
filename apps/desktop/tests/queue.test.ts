import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, AppState, Draft, Thread } from '@aplos/contract/legacy/types';
import type { SyncResult } from '@aplos/engine/legacy/provider';
import { createGoogle, GoogleError } from '../src/main/google';
import { createGroq } from '../src/main/groq';
import { createService } from '../src/main/service';

const account: Account = {
  id: 'g1',
  name: 'Alex',
  email: 'alex@example.test',
  provider: 'google',
  connected: true,
  color: '#aaa',
};
const remote = (id: string, patch: Partial<Thread> = {}): Thread => ({
  id: `g1:${id}`,
  remoteId: id,
  accountId: 'g1',
  subject: `Thread ${id}`,
  summary: '',
  date: '2026-10-14T10:00:00Z',
  unread: true,
  status: 'new',
  importance: 'important',
  bookmarked: false,
  replyStatus: 'none',
  labels: ['INBOX', 'UNREAD'],
  messages: [
    {
      id: `${id}-1`,
      from: 'sam@example.test',
      fromName: 'Sam',
      to: [account.email],
      date: '2026-10-14T10:00:00Z',
      text: 'Hello',
      attachments: [],
    },
  ],
  ...patch,
});
const offline = () =>
  new GoogleError('Google could not be reached. Check your internet connection.', undefined, true);
const settle = async (fn: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail('Timed out waiting');
};

async function harness(summarized?: string[]) {
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-queue-'));
  const base = await createGoogle({ dataDir, clientId: '' });
  const calls: Array<{ remoteId?: string; fromStatus: string; patch: Partial<Thread> }> = [],
    sends: Draft[] = [];
  const control = {
    online: true,
    writesDown: false,
    syncHold: undefined as Promise<void> | undefined,
    updateHold: undefined as Promise<void> | undefined,
    sendResult: undefined as { id?: string; threadId?: string } | undefined,
    fail404: new Set<string>(),
    sendError: undefined as Error | undefined,
    sent: new Map<string, { id: string; threadId: string }>(),
    next: {
      threads: [remote('a'), remote('b')],
      flags: [],
      removed: [],
      reset: true,
      cursor: '1',
    } as SyncResult,
  };
  const google = {
    ...base,
    available: true,
    connect: async () => account,
    disconnect: async () => {},
    getSendAs: async () => [],
    sync: async (_a: Account, cursor?: string) => {
      if (!control.online) throw offline();
      const value = structuredClone(control.next);
      await control.syncHold;
      control.next = {
        threads: [],
        flags: [],
        removed: [],
        reset: false,
        cursor: String(Number(cursor ?? 0) + 1),
      };
      return value;
    },
    updateThread: async (
      _a: Account,
      t: Pick<Thread, 'remoteId' | 'status' | 'labels'>,
      patch: Partial<Thread>,
    ) => {
      await control.updateHold;
      if (!control.online) throw offline();
      if (control.writesDown)
        throw new GoogleError('Google request failed (503). Please retry.', 503, true);
      if (control.fail404.has(t.remoteId!))
        throw new GoogleError('Google could not find this item.', 404);
      calls.push({ remoteId: t.remoteId, fromStatus: t.status, patch });
    },
    send: async (_a: Account, d: Draft) => {
      sends.push(structuredClone(d));
      if (control.sendError) throw control.sendError;
      const result = { id: 'sent-1', threadId: 'sent-thread' };
      control.sent.set(d.messageId!, result);
      return control.sendResult ?? result;
    },
    findSent: async (_a: Account, messageId: string) => control.sent.get(messageId),
  };
  const groq = createGroq({ apiKey: '' });
  const open = () =>
    createService({
      dataDir,
      google,
      groq: summarized
        ? {
            ...groq,
            available: true,
            summarize: async (t: Thread) => {
              summarized.push(t.id);
              return { summary: 'Original synthetic summary' };
            },
          }
        : groq,
      autoSyncMs: 0,
    });
  let service = await open();
  await service.invoke('account.connect');
  return {
    dataDir,
    control,
    calls,
    sends,
    get service() {
      return service;
    },
    async restart() {
      await service.close();
      service = await open();
    },
    async cleanup() {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
const get = async (h: { service: { invoke: (m: string, p?: unknown) => Promise<any> } }) =>
  (await h.service.invoke('state.get')) as AppState;

test('incoming exact copies archive the older inbox thread durably before notifications and classification', async () => {
  const summarized: string[] = [],
    h = await harness(summarized);
  try {
    await h.service.invoke('settings.update', { patch: { doneAction: 'unread' } });
    summarized.length = 0;
    const events: Array<{ type: string; payload?: any }> = [];
    h.service.subscribe(e => events.push(e));
    h.control.writesDown = true;
    const latest = remote('latest', { subject: 'Thread a', date: '2099-10-18T13:00:00Z' });
    latest.messages[0].date = latest.date;
    const middle = structuredClone(latest);
    middle.id = 'g1:middle';
    middle.remoteId = 'middle';
    middle.date = '2099-10-18T12:00:00Z';
    middle.messages[0].id = 'middle-1';
    middle.messages[0].date = middle.date;
    h.control.next = {
      threads: [latest, middle],
      flags: [],
      removed: [],
      reset: false,
      cursor: '3',
    };
    let state = (await h.service.invoke('sync')) as AppState;
    assert.deepEqual(
      state.threads
        .filter(t => t.accountId === 'g1' && t.status === 'new')
        .map(t => t.id)
        .sort(),
      ['g1:b', 'g1:latest'],
    );
    assert.equal(state.threads.find(t => t.id === 'g1:a')!.labels?.includes('INBOX'), false);
    assert.equal(
      state.threads.find(t => t.id === 'g1:a')!.unread,
      true,
      'archive preserves read state regardless of Done mapping',
    );
    assert.deepEqual(summarized, ['g1:latest']);
    assert.deepEqual(
      events.filter(e => e.type === 'notification').map(e => e.payload.threadId),
      ['g1:latest'],
    );
    await settle(async () => (await get(h)).sync.pending === 2);
    await h.restart();
    assert.equal((await get(h)).sync.pending, 2, 'both archives survive restart');
    h.control.next = {
      threads: [remote('a'), middle],
      flags: [],
      removed: [],
      reset: false,
      cursor: '4',
    };
    state = (await h.service.invoke('sync')) as AppState;
    assert.equal(
      state.threads.find(t => t.id === 'g1:a')!.status,
      'done',
      'stale host state cannot undo a queued archive',
    );
    h.control.writesDown = false;
    await h.service.invoke('sync');
    assert.equal((await get(h)).sync.pending, undefined);
    assert.deepEqual(h.calls.map(c => c.remoteId).sort(), ['a', 'middle']);
    assert.ok(
      h.calls.every(
        c =>
          c.patch.status === 'done' &&
          !c.patch.labels?.includes('INBOX') &&
          c.patch.unread === undefined,
      ),
    );
    assert.equal(
      (await get(h)).threads.filter(t => ['g1:a', 'g1:middle', 'g1:latest'].includes(t.id)).length,
      3,
      'archived copies remain in All mail',
    );
  } finally {
    await h.cleanup();
  }
});

test('triage works offline, survives a restart, and reaches the host in order once it is back', async () => {
  const h = await harness();
  try {
    h.control.online = false;
    await h.service.invoke('settings.update', { patch: { doneAction: 'archive' } });
    await h.service.invoke('thread.update', { ids: ['g1:a'], patch: { status: 'done' } });
    await h.service.invoke('thread.update', { ids: ['g1:a'], patch: { bookmarked: true } });
    let state = await get(h);
    assert.equal(
      state.threads.find(t => t.id === 'g1:a')!.status,
      'done',
      'the change is applied locally at once',
    );
    await settle(async () => (await get(h)).sync.pending === 2);
    await h.restart();
    assert.equal((await get(h)).sync.pending, 2, 'queued changes are persisted');
    h.control.online = true;
    h.control.next = {
      threads: [],
      flags: [
        { id: 'g1:a', unread: true, bookmarked: false, status: 'new', labels: ['INBOX', 'UNREAD'] },
      ],
      removed: [],
      reset: false,
      cursor: '5',
    };
    state = (await h.service.invoke('sync')) as AppState;
    assert.equal(state.sync.pending, undefined);
    assert.deepEqual(
      h.calls.map(c => [c.remoteId, c.fromStatus, Object.keys(c.patch).sort().join()]),
      [
        ['a', 'new', 'labels,status'],
        ['a', 'done', 'bookmarked'],
      ],
      'changes arrive in the order they were made',
    );
    assert.equal(
      h.calls[0].patch.labels?.includes('INBOX'),
      false,
      'archive removes the inbox label',
    );
  } finally {
    await h.cleanup();
  }
});

test('a sync cannot revert a change that has not reached the host; failed writes stay queued and gone threads are dropped', async () => {
  const h = await harness();
  try {
    h.control.fail404.add('b');
    await h.service.invoke('thread.update', { ids: ['g1:b'], patch: { unread: false } });
    await settle(async () => (await get(h)).sync.pending === undefined);
    assert.equal(h.calls.length, 0, 'a change for a thread the host no longer has is dropped');
    h.control.writesDown = true;
    await h.service.invoke('thread.update', {
      ids: ['g1:a'],
      patch: { unread: false, bookmarked: true },
    });
    await settle(async () => (await get(h)).sync.pending === 1);
    // Reads work but writes still fail, so the pull brings back the host's older copy of the thread.
    h.control.next = { threads: [remote('a')], flags: [], removed: [], reset: false, cursor: '7' };
    const state = (await h.service.invoke('sync')) as AppState,
      a = state.threads.find(t => t.id === 'g1:a')!;
    assert.equal(state.sync.pending, 1, 'the failed change stays queued');
    assert.equal(a.unread, false);
    assert.equal(a.bookmarked, true);
    h.control.writesDown = false;
    const manual = (await h.service.invoke('sync')) as AppState;
    assert.equal(manual.sync.pending, undefined, 'a manual sync retries at once');
    assert.equal(manual.threads.find(t => t.id === 'g1:a')!.bookmarked, true);
    assert.equal(h.calls.at(-1)?.patch.bookmarked, true);
  } finally {
    await h.cleanup();
  }
});

test('undo is queued like any change and restores trash with an untrash', async () => {
  const h = await harness();
  try {
    await h.service.invoke('thread.update', { ids: ['g1:a'], patch: { status: 'trash' } });
    await h.service.invoke('thread.undo');
    await settle(async () => (await get(h)).sync.pending === undefined && h.calls.length === 2);
    assert.deepEqual(
      h.calls.map(c => [c.fromStatus, c.patch.status]),
      [
        ['new', 'trash'],
        ['trash', 'new'],
      ],
    );
    assert.equal((await get(h)).threads.find(t => t.id === 'g1:a')!.status, 'new');
  } finally {
    await h.cleanup();
  }
});

const draft = (id: string): Draft => ({
  id,
  accountId: 'g1',
  to: 'reader@example.test',
  cc: '',
  bcc: '',
  subject: `Subject ${id}`,
  html: '<p>Hello</p>',
  attachments: [],
  mode: 'new',
  signature: false,
  updatedAt: new Date().toISOString(),
  revision: 0,
});

test('an uncertain send is confirmed from Sent mail; an unconfirmed one is never retried automatically', async () => {
  const h = await harness();
  try {
    await h.service.invoke('settings.update', { patch: { undoSeconds: 0 } });
    // The request reached Gmail but the answer was lost.
    h.control.sendError = offline();
    await h.service.invoke('draft.save', { draft: draft('d1') });
    await h.service.invoke('draft.send', { id: 'd1' });
    await settle(async () => {
      const s = await get(h);
      return (
        !s.drafts.some(d => d.id === 'd1' && !d.sendError) ||
        !!s.drafts.find(d => d.id === 'd1')?.sendError
      );
    });
    let state = await get(h);
    assert.equal(h.sends.length, 1);
    assert.match(state.drafts.find(d => d.id === 'd1')!.sendError!, /could not confirm/);
    assert.ok(
      /^<[0-9a-f-]+@example\.test>$/.test(h.sends[0].messageId!),
      'a stable Message-ID on the sender domain',
    );
    // A plain retry while the outcome is unknown checks Sent and stops: not finding it does not prove it was lost.
    await h.service.invoke('draft.save', {
      draft: {
        ...draft('d1'),
        subject: 'Edited after the failure',
        revision: state.drafts.find(d => d.id === 'd1')!.revision,
      },
    });
    await h.service.invoke('draft.send', { id: 'd1' });
    await settle(async () => {
      const d = (await get(h)).drafts.find(d => d.id === 'd1');
      return !!d?.sendError && !d.pendingSendAt;
    });
    assert.equal(
      h.sends.length,
      1,
      'an unresolved attempt is never resubmitted by an ordinary retry',
    );
    assert.match((await get(h)).drafts.find(d => d.id === 'd1')!.sendError!, /Send anyway/);
    // Only the explicit duplicate-risk choice submits again, with the same Message-ID.
    await h.service.invoke('draft.send', { id: 'd1', resend: true });
    await settle(
      async () =>
        h.sends.length === 2 &&
        !!(await get(h)).drafts.find(d => d.id === 'd1')?.sendError &&
        !(await get(h)).drafts.find(d => d.id === 'd1')?.pendingSendAt,
    );
    assert.equal(
      (await get(h)).drafts.find(d => d.id === 'd1')!.resendConfirmed,
      undefined,
      'the choice covers one attempt only',
    );
    assert.equal(
      h.sends[1].messageId,
      h.sends[0].messageId,
      'editing an unconfirmed draft keeps the Message-ID of the attempt',
    );
    // Now Gmail has it: the next retry finds it in Sent and does not submit again.
    h.control.sent.set(h.sends[0].messageId!, { id: 'm', threadId: 'found-thread' });
    await h.service.invoke('draft.send', { id: 'd1' });
    await settle(async () => !(await get(h)).drafts.some(d => d.id === 'd1'));
    state = await get(h);
    assert.equal(h.sends.length, 2, 'a message found in Sent is never submitted again');
    assert.ok(
      state.threads.some(t => t.remoteId === 'found-thread' && t.messages.some(m => m.sent)),
    );
    h.control.sendError = new GoogleError('Google request failed (400). Please retry.', 400);
    await h.service.invoke('draft.save', { draft: draft('d2') });
    await h.service.invoke('draft.send', { id: 'd2' });
    await settle(async () => !!(await get(h)).drafts.find(d => d.id === 'd2')?.sendError);
    assert.match(
      (await get(h)).drafts.find(d => d.id === 'd2')!.sendError!,
      /400/,
      'a definite rejection is reported as is',
    );
  } finally {
    await h.cleanup();
  }
});

test('a send interrupted by a crash is settled from Sent mail after restart and never sent twice', async () => {
  const h = await harness();
  try {
    await h.service.invoke('settings.update', { patch: { undoSeconds: 60 } });
    for (const id of ['crash-sent', 'crash-lost']) {
      await h.service.invoke('draft.save', { draft: draft(id) });
      await h.service.invoke('draft.send', { id });
    }
    await h.service.close();
    const db = new DatabaseSync(join(h.dataDir, 'aplos.db'));
    const ids: Record<string, string> = {};
    for (const id of ['crash-sent', 'crash-lost']) {
      const row = db.prepare('SELECT data FROM drafts WHERE id=?').get(id) as { data: string },
        d = JSON.parse(row.data) as Draft;
      d.pendingSendAt = new Date(Date.now() - 5_000).toISOString();
      d.sendAttemptAt = new Date(Date.now() - 4_000).toISOString();
      ids[id] = d.messageId!;
      db.prepare('UPDATE drafts SET data=? WHERE id=?').run(JSON.stringify(d), id);
    }
    db.close();
    h.control.sent.set(ids['crash-sent'], { id: 'm', threadId: 'recovered' });
    await h.restart();
    await settle(async () => {
      const s = await get(h);
      return (
        !s.drafts.some(d => d.id === 'crash-sent') &&
        !!s.drafts.find(d => d.id === 'crash-lost')?.sendError
      );
    });
    const state = await get(h);
    assert.equal(h.sends.length, 0, 'nothing is sent again');
    assert.ok(state.threads.some(t => t.remoteId === 'recovered'));
    const lost = state.drafts.find(d => d.id === 'crash-lost')!;
    assert.match(lost.sendError!, /Check Sent mail/);
    assert.equal(lost.pendingSendAt, undefined);
    assert.ok(
      lost.sendAttemptAt,
      'the unresolved attempt stays marked so a retry checks Sent first',
    );
  } finally {
    await h.cleanup();
  }
});

test('mail saved with Gmail-specific field names opens with provider-neutral ones', async () => {
  const h = await harness();
  try {
    await h.service.close();
    const db = new DatabaseSync(join(h.dataDir, 'aplos.db'));
    const row = db.prepare('SELECT data FROM threads WHERE id=?').get('g1:a') as { data: string },
      t = JSON.parse(row.data);
    delete t.remoteId;
    t.gmailId = 'a';
    t.messages[0].attachments = [
      {
        id: 'x',
        name: 'a.pdf',
        type: 'application/pdf',
        size: 1,
        gmailAttachmentId: 'att-1',
        messageId: 'a-1',
      },
    ];
    db.prepare('UPDATE threads SET data=? WHERE id=?').run(JSON.stringify(t), 'g1:a');
    db.close();
    await h.restart();
    const migrated = (await get(h)).threads.find(x => x.id === 'g1:a')!;
    assert.equal(migrated.remoteId, 'a');
    assert.equal((migrated as any).gmailId, undefined);
    assert.equal(migrated.messages[0].attachments[0].remoteId, 'att-1');
    await h.service.invoke('thread.update', { ids: ['g1:a'], patch: { bookmarked: true } });
    await settle(() => h.calls.length === 1);
    assert.equal(h.calls[0].remoteId, 'a', 'queued changes reach the host with the migrated ID');
  } finally {
    await h.cleanup();
  }
});

const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>(r => {
    open = r;
  });
  return { promise, open };
};

test('read-only triage keeps the thread in the host inbox', async () => {
  const h = await harness();
  try {
    await h.service.invoke('settings.update', {
      patch: { doneAction: 'read', laterAction: 'unread' },
    });
    await h.service.invoke('thread.update', { ids: ['g1:a'], patch: { status: 'done' } });
    await h.service.invoke('thread.update', { ids: ['g1:b'], patch: { status: 'later' } });
    await settle(() => h.calls.length === 2);
    for (const call of h.calls)
      assert.ok(
        call.patch.labels?.includes('INBOX'),
        'the host is told the thread stays in the inbox',
      );
  } finally {
    await h.cleanup();
  }
});

test('a sync answer read before a change reached the host cannot undo it', async () => {
  const h = await harness();
  try {
    await h.service.invoke('settings.update', { patch: { doneAction: 'archive' } });
    const hold = gate();
    h.control.syncHold = hold.promise;
    h.control.next = {
      threads: [],
      flags: [
        { id: 'g1:a', unread: true, bookmarked: false, status: 'new', labels: ['INBOX', 'UNREAD'] },
      ],
      removed: [],
      reset: false,
      cursor: '9',
    };
    const syncing = h.service.invoke('sync');
    await new Promise(r => setTimeout(r, 20));
    await h.service.invoke('thread.update', { ids: ['g1:a'], patch: { status: 'done' } });
    await settle(async () => h.calls.length === 1 && (await get(h)).sync.pending === undefined);
    hold.open();
    await syncing;
    assert.equal((await get(h)).threads.find(t => t.id === 'g1:a')!.status, 'done');
  } finally {
    h.control.syncHold = undefined;
    await h.cleanup();
  }
});

test('a change discarded by disconnect does not come back when the host answers late', async () => {
  const h = await harness();
  try {
    const hold = gate();
    h.control.updateHold = hold.promise;
    h.control.writesDown = true;
    await h.service.invoke('thread.update', { ids: ['g1:a'], patch: { bookmarked: true } });
    await new Promise(r => setTimeout(r, 20));
    await h.service.invoke('account.disconnect', { id: 'g1' });
    hold.open();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(
      (await get(h)).sync.pending,
      undefined,
      'nothing is queued for the removed account',
    );
    await h.restart();
    assert.equal((await get(h)).sync.pending, undefined);
  } finally {
    h.control.updateHold = undefined;
    await h.cleanup();
  }
});

test('a sent message the host gave no thread for is replaced by the host copy on the next sync', async () => {
  const h = await harness();
  try {
    await h.service.invoke('settings.update', { patch: { undoSeconds: 0 } });
    h.control.sendResult = {};
    await h.service.invoke('draft.save', { draft: draft('p1') });
    await h.service.invoke('draft.send', { id: 'p1' });
    await settle(async () => !(await get(h)).drafts.some(d => d.id === 'p1'));
    const local = (await get(h)).threads.find(t => t.subject === 'Subject p1')!;
    assert.equal(local.remoteId, undefined);
    const messageId = h.sends[0].messageId!;
    h.control.next = {
      threads: [
        remote('host-copy', {
          subject: 'Subject p1',
          status: 'done',
          unread: false,
          labels: ['SENT'],
          messages: [
            {
              id: 'hm',
              from: 'alex@example.test',
              fromName: 'Alex',
              to: ['reader@example.test'],
              date: '2026-10-14T11:00:00Z',
              text: 'Hello',
              attachments: [],
              sent: true,
              internetId: messageId,
            },
          ],
        }),
      ],
      flags: [],
      removed: [],
      reset: false,
      cursor: '7',
    };
    await h.service.invoke('sync');
    const copies = (await get(h)).threads.filter(t => t.subject === 'Subject p1');
    assert.deepEqual(
      copies.map(t => t.remoteId),
      ['host-copy'],
      'one thread, linked to the host',
    );
  } finally {
    await h.cleanup();
  }
});
