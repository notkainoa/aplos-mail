import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, AppState, Thread } from '@aplos/contract/legacy/types';
import type { AppDataRecord, MailProvider, SyncResult } from '@aplos/engine/legacy/provider';
import { createGroq } from '../src/main/groq';
import { createService } from '../src/main/service';

/** One mailbox at a host, with the hidden app-data copy every device reads and writes. */
function mailbox() {
  const account: Account = {
    id: 'jmap-1',
    name: 'Riley',
    email: 'riley@fastmail.test',
    provider: 'jmap',
    connected: true,
    color: '#888',
    calendarConnected: false,
  };
  const thread: Thread = {
    id: 'jmap-1:t1',
    remoteId: 't1',
    accountId: 'jmap-1',
    subject: 'Quarterly plan',
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
        id: 'm1',
        internetId: '<plan@example.test>',
        from: 'sam@example.test',
        fromName: 'Sam',
        to: [account.email],
        date: '2026-10-14T10:00:00Z',
        text: 'Plan?',
        attachments: [],
      },
    ],
  };
  let seq = 0;
  const box = {
    copies: [] as AppDataRecord[],
    writes: 0,
    get blob() {
      return box.copies[0]?.data;
    },
  };
  const device = (): MailProvider => {
    let first = true;
    return {
      kind: 'jmap',
      available: true,
      capabilities: () => ({
        labels: false,
        importance: false,
        aliases: false,
        signatures: false,
        calendar: false,
        serverSearch: false,
      }),
      connect: async () => ({ ...account }),
      disconnect: async () => {},
      sync: async (): Promise<SyncResult> => {
        const result: SyncResult = {
          threads: first ? [structuredClone(thread)] : [],
          flags: [],
          removed: [],
          reset: first,
          cursor: 'c',
        };
        first = false;
        return result;
      },
      search: async () => [],
      updateThread: async () => {},
      findSent: async () => undefined,
      send: async () => ({}),
      attachment: async (_a, _t, file) => file,
      readAppData: async () => structuredClone(box.copies),
      writeAppData: async (_a, data, replaces) => {
        box.copies = [
          { id: `copy${++seq}`, data },
          ...box.copies.filter(c => !replaces.includes(c.id)),
        ];
        box.writes++;
      },
      close: async () => {},
    };
  };
  return { box, device };
}
/** A reversible stand-in for the keychain so the credential vault works in tests. */
const keychain = {
  encrypt: (v: string) => Buffer.from(`kc:${v}`),
  decrypt: (b: Buffer) => b.toString().slice(3),
};

async function open(dir: string, provider: MailProvider) {
  const service = await createService({
    dataDir: dir,
    providers: { jmap: provider },
    groq: createGroq({ apiKey: '' }),
    autoSyncMs: 0,
    ...keychain,
  });
  await service.invoke('account.connect', {
    provider: 'jmap',
    email: 'riley@fastmail.test',
    secret: 'token',
  });
  return service;
}
const find = (state: AppState) => state.threads.find(t => t.id === 'jmap-1:t1')!;

test('Done, Later and todos follow the user between devices through encrypted app data', async () => {
  const dirs = await Promise.all(
    ['a', 'b', 'c'].map(name => mkdtemp(join(tmpdir(), `aplos-device-${name}-`))),
  );
  const host = mailbox();
  const a = await open(dirs[0], host.device()),
    b = await open(dirs[1], host.device());
  let c: Awaited<ReturnType<typeof open>> | undefined;
  try {
    assert.equal((await a.invoke('workflow.status')).enabled, false);
    const { code } = (await a.invoke('workflow.enable')) as { code: string };
    assert.match(code, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/);
    await a.invoke('sync');
    await a.invoke('thread.update', {
      ids: ['jmap-1:t1'],
      patch: { status: 'done', todo: 'Send the budget' },
    });
    await a.invoke('sync');
    assert.equal(host.box.writes, 1);
    assert.ok(host.box.blob && !host.box.blob.includes('budget'), 'the host only sees ciphertext');

    // The second device joins with the code (typed loosely) and takes on the first device's triage.
    await b.invoke('workflow.enable', { code: code.toLowerCase().replace(/-/g, ' ') });
    let state = (await b.invoke('sync')) as AppState;
    assert.equal(find(state).status, 'done');
    assert.equal(find(state).todo, 'Send the budget');

    // An edit on the second device flows back; a round with nothing new writes nothing.
    await b.invoke('thread.update', {
      ids: ['jmap-1:t1'],
      patch: { status: 'later', dueDate: '2026-10-20' },
    });
    await b.invoke('sync');
    const writes = host.box.writes;
    state = (await a.invoke('sync')) as AppState;
    assert.equal(find(state).status, 'later');
    assert.equal(find(state).dueDate, '2026-10-20');
    await a.invoke('sync');
    assert.equal(host.box.writes, writes, 'unchanged logs are not rewritten');

    // A device with a different code reports the mismatch and never overwrites the shared data.
    c = await open(dirs[2], host.device());
    await c.invoke('workflow.enable');
    const blob = host.box.blob;
    state = (await c.invoke('sync')) as AppState;
    assert.match(state.sync.error ?? '', /does not match/);
    assert.equal(host.box.blob, blob);
    assert.equal(host.box.copies.length, 1);
    assert.equal(find(state).status, 'new');

    await a.invoke('workflow.disable');
    assert.equal((await a.invoke('workflow.status')).enabled, false);
    await assert.rejects(a.invoke('workflow.code'), /off/);
  } finally {
    await Promise.all([a.close(), b.close(), c?.close()]);
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  }
});

test('device sync needs the desktop credential vault', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-device-web-'));
  const service = await createService({
    dataDir: dir,
    groq: createGroq({ apiKey: '' }),
    autoSyncMs: 0,
  });
  try {
    assert.equal((await service.invoke('workflow.status')).available, false);
    await assert.rejects(service.invoke('workflow.enable'), /desktop app/);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
