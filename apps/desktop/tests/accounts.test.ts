import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, AppState, Thread } from '@aplos/contract/legacy/types';
import type { ConnectRequest, MailProvider, SyncResult } from '@aplos/engine/legacy/provider';
import { createGroq } from '../src/main/groq';
import { createService } from '../src/main/service';

const settle = async (fn: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail('Timed out waiting');
};

/** A folder-based host: no labels, so archiving is a move out of the inbox. */
function folderHost() {
  const requests: ConnectRequest[] = [],
    updates: Array<{ status: string; labels?: string[]; patch: Partial<Thread> }> = [],
    cleared: string[] = [];
  const account: Account = {
    id: 'imap-1',
    name: 'Riley',
    email: 'riley@icloud.test',
    provider: 'imap',
    preset: 'icloud',
    connected: true,
    color: '#888',
    calendarConnected: false,
  };
  const thread: Thread = {
    id: 'imap-1:t1',
    remoteId: 't1',
    accountId: 'imap-1',
    subject: 'Lunch',
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
        from: 'sam@example.test',
        fromName: 'Sam',
        to: [account.email],
        date: '2026-10-14T10:00:00Z',
        text: 'Lunch?',
        attachments: [],
      },
    ],
  };
  let first = true;
  const provider: MailProvider = {
    kind: 'imap',
    available: true,
    capabilities: () => ({
      labels: false,
      importance: false,
      aliases: false,
      signatures: false,
      calendar: false,
      serverSearch: true,
    }),
    connect: async request => {
      requests.push(request);
      return { ...account };
    },
    disconnect: async id => {
      cleared.push(id);
    },
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
    updateThread: async (_a, t, patch) => {
      updates.push({ status: t.status, labels: t.labels, patch });
    },
    findSent: async () => undefined,
    send: async () => ({}),
    attachment: async (_a, _t, file) => file,
    close: async () => {},
  };
  return { provider, requests, updates, cleared };
}

/** DNS over HTTPS answers for one custom domain hosted at iCloud. */
const dohFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const name = url.searchParams.get('name')!,
    type = url.searchParams.get('type')!;
  const answers: Record<string, Array<{ type: number; data: string }>> = {
    'MX example.org': [{ type: 15, data: '10 mx01.mail.icloud.com.' }],
    'TXT example.org': [{ type: 16, data: '"v=spf1 include:icloud.com ~all"' }],
    'TXT icloud.com': [{ type: 16, data: '"v=spf1 ip4:17.0.0.0/8 ~all"' }],
    'TXT _dmarc.example.org': [
      { type: 16, data: '"v=DMARC1; p=quarantine; rua=mailto:d@example.org"' },
    ],
  };
  const found = answers[`${type} ${name}`];
  return new Response(JSON.stringify({ Status: 0, Answer: found ?? [] }), {
    headers: { 'content-type': 'application/dns-json' },
  });
}) as typeof fetch;

test('a folder-based account connects with its preset, archives by moving out of the inbox, and disconnects cleanly', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-accounts-'));
  const host = folderHost();
  const service = await createService({
    dataDir,
    providers: { imap: host.provider },
    groq: createGroq({ apiKey: '' }),
    autoSyncMs: 0,
    fetch: dohFetch,
  });
  try {
    await assert.rejects(
      service.invoke('account.connect', {
        provider: 'imap',
        preset: 'icloud',
        email: 'riley@icloud.test',
        secret: 'line\nbreak',
      }),
      /line breaks/,
    );
    let state = (await service.invoke('account.connect', {
      provider: 'imap',
      preset: 'icloud',
      email: 'Riley@iCloud.test',
      secret: 'abcd-efgh-ijkl-mnop',
    })) as AppState;
    assert.deepEqual(host.requests.at(-1), {
      provider: 'imap',
      preset: 'icloud',
      email: 'riley@icloud.test',
      secret: 'abcd-efgh-ijkl-mnop',
    });
    const added = state.accounts.find(a => a.id === 'imap-1')!;
    assert.equal(added.capabilities?.labels, false, 'capabilities come from the host');
    assert.equal(
      JSON.stringify(state).includes('abcd-efgh'),
      false,
      'the password never reaches app state',
    );
    assert.equal(state.threads.find(t => t.id === 'imap-1:t1')?.subject, 'Lunch');

    await service.invoke('settings.update', { patch: { doneAction: 'archive' } });
    await service.invoke('thread.update', { ids: ['imap-1:t1'], patch: { status: 'done' } });
    await settle(() => host.updates.length === 1);
    assert.equal(host.updates[0].status, 'new');
    assert.equal(host.updates[0].patch.status, 'done');
    assert.equal(
      host.updates[0].patch.labels?.includes('INBOX'),
      false,
      'the host is told the thread leaves the inbox',
    );

    await assert.rejects(
      service.invoke('account.connect', {
        provider: 'jmap',
        email: 'a@b.test',
        secret: 'x',
        sessionUrl: 'http://api.example.test/jmap',
      }),
      /HTTPS/,
    );
    await assert.rejects(
      service.invoke('account.connect', {
        provider: 'imap',
        preset: 'generic',
        email: 'a@b.test',
        secret: 'x',
        server: {
          imap: { host: 'imap.b.test', port: 993, secure: true },
          smtp: { host: 'smtp.b.test', port: 465, secure: true },
          caldav: 'http://dav.b.test',
        },
      }),
      /HTTPS/,
    );

    state = (await service.invoke('account.disconnect', { id: 'imap-1' })) as AppState;
    assert.deepEqual(host.cleared, ['imap-1']);
    assert.equal(
      state.accounts.some(a => a.id === 'imap-1'),
      false,
    );
    assert.equal(
      state.threads.some(t => t.accountId === 'imap-1'),
      false,
    );
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('address discovery and the domain checker answer through the backend', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-accounts-'));
  const service = await createService({
    dataDir,
    groq: createGroq({ apiKey: '' }),
    autoSyncMs: 0,
    fetch: dohFetch,
  });
  try {
    const known = await service.invoke('account.discover', { email: 'kim@outlook.com' });
    assert.equal(known.provider, 'microsoft');
    const custom = await service.invoke('account.discover', { email: 'kim@example.org' });
    assert.deepEqual([custom.provider, custom.preset, custom.confidence], ['imap', 'icloud', 'mx']);
    await assert.rejects(service.invoke('account.discover', { email: 'not an address' }));
    const report = await service.invoke('domain.check', { domain: 'example.org' });
    const status = Object.fromEntries(
      report.checks.map((c: { id: string; status: string }) => [c.id, c.status]),
    );
    assert.equal(status.mx, 'pass');
    assert.equal(status.spf, 'pass');
    assert.equal(status.dmarc, 'pass');
    await assert.rejects(
      service.invoke('domain.check', { domain: 'example.org', provider: 'carrier-pigeon' }),
      /Invalid option/,
    );
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
