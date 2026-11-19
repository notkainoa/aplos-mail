import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, AppState, CalendarEvent, Thread } from '@aplos/contract/legacy/types';
import {
  ProviderError,
  type MailProvider,
  type ProviderEnvironment,
  type SyncResult,
} from '@aplos/engine/legacy/provider';
import { createGroq } from '../src/main/groq';
import { createService } from '../src/main/service';
import { createStagedMemory } from '../src/main/memory-stage';

const account: Account = {
  id: 'j1',
  name: 'Alex',
  email: 'alex@example.test',
  provider: 'jmap',
  connected: true,
  color: '#aaa',
  calendarConnected: true,
};
const thread = (id: string): Thread => ({
  id: `j1:${id}`,
  remoteId: id,
  accountId: 'j1',
  subject: `Thread ${id}`,
  summary: '',
  date: '2026-10-14T10:00:00Z',
  unread: true,
  status: 'new',
  importance: 'important',
  bookmarked: false,
  replyStatus: 'none',
  labels: ['INBOX'],
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
});
const event = (id: string, start: string): CalendarEvent => ({
  id,
  accountId: 'j1',
  calendarId: 'cal',
  title: 'Weekly',
  start,
  end: start.replace('T10', 'T11'),
  allDay: false,
  location: '',
  description: '',
  guests: [],
  remoteId: 'series.ics',
});

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-safety-'));
  const control = {
    syncs: 0,
    fail: false,
    hold: undefined as Promise<void> | undefined,
    started: undefined as (() => void) | undefined,
    events: [] as CalendarEvent[],
    env: undefined as ProviderEnvironment<Buffer> | undefined,
    next: {
      threads: [thread('a')],
      flags: [],
      removed: [],
      reset: true,
      cursor: 'c1',
    } as SyncResult,
  };
  const fake = (env: ProviderEnvironment<Buffer>): MailProvider => {
    control.env = env;
    return {
      kind: 'jmap',
      available: true,
      capabilities: () => ({
        labels: false,
        importance: false,
        aliases: false,
        signatures: false,
        calendar: true,
        serverSearch: false,
      }),
      connect: async () => account,
      disconnect: async () => {},
      async sync(a) {
        const n = ++control.syncs;
        env.memory!.set(a.id, 'index', `sync-${n}`);
        control.started?.();
        await control.hold;
        if (control.fail) throw new ProviderError('The host did not answer.', 503, true);
        return structuredClone(control.next);
      },
      listEvents: async () => structuredClone(control.events),
      search: async () => [],
      updateThread: async () => {},
      findSent: async () => undefined,
      send: async () => ({}),
      attachment: async (_a, _t, x) => x,
      close() {},
    };
  };
  const service = await createService({
    dataDir,
    providers: { jmap: fake },
    groq: createGroq({ apiKey: '' }),
    autoSyncMs: 0,
  });
  await service.invoke('account.connect', { provider: 'jmap' });
  const db = () => {
    const d = new DatabaseSync(join(dataDir, 'aplos.db'));
    try {
      return {
        index: d
          .prepare("SELECT value FROM provider_memory WHERE account_id='j1' AND key='index'")
          .get()?.value as string | undefined,
        cursor: d.prepare("SELECT cursor FROM sync_cursors WHERE account_id='j1'").get()?.cursor as
          string | undefined,
      };
    } finally {
      d.close();
    }
  };
  return {
    dataDir,
    control,
    service,
    db,
    async cleanup() {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('a failed sync leaves the provider index as it was; a good one saves index, mail and cursor together', async () => {
  const h = await harness();
  try {
    assert.deepEqual(h.db(), { index: 'sync-1', cursor: 'c1' });
    h.control.fail = true;
    await h.service.invoke('sync');
    assert.deepEqual(
      h.db(),
      { index: 'sync-1', cursor: 'c1' },
      'the index write of a failed sync is dropped',
    );
    h.control.fail = false;
    h.control.next = { threads: [thread('b')], flags: [], removed: [], reset: false, cursor: 'c2' };
    const state = (await h.service.invoke('sync')) as AppState;
    assert.ok(state.threads.some(t => t.id === 'j1:b'));
    assert.deepEqual(h.db(), { index: 'sync-3', cursor: 'c2' });
  } finally {
    await h.cleanup();
  }
});

test('a sync answered after the account was disconnected adds nothing back', async () => {
  const h = await harness();
  try {
    let release!: () => void, started!: () => void;
    h.control.hold = new Promise(r => {
      release = r;
    });
    const began = new Promise<void>(r => {
      started = r;
    });
    h.control.started = started;
    h.control.next = {
      threads: [thread('late')],
      flags: [],
      removed: [],
      reset: false,
      cursor: 'c9',
    };
    const running = h.service.invoke('sync');
    await began;
    await h.service.invoke('account.disconnect', { id: 'j1' });
    release();
    await running;
    const state = (await h.service.invoke('state.get')) as AppState;
    assert.equal(
      state.threads.some(t => t.accountId === 'j1'),
      false,
    );
    assert.deepEqual(
      h.db(),
      { index: undefined, cursor: undefined },
      'neither the index nor the cursor of the old account returns',
    );
  } finally {
    await h.cleanup();
  }
});

test('a sync whose index was changed underneath it is fetched again instead of saved', async () => {
  const h = await harness();
  try {
    let release!: () => void, started!: () => void;
    h.control.hold = new Promise(r => {
      release = r;
    });
    const began = new Promise<void>(r => {
      started = r;
    });
    h.control.started = started;
    h.control.next = { threads: [thread('c')], flags: [], removed: [], reset: false, cursor: 'c5' };
    const running = h.service.invoke('sync');
    await began;
    // Another operation (a move, say) rewrites the same key while the sync is out.
    h.control.env!.memory!.set('j1', 'index', 'from-update');
    h.control.started = undefined;
    release();
    await running;
    assert.equal(h.control.syncs, 3, 'the stale result is dropped and the sync runs again');
    assert.deepEqual(h.db(), { index: 'sync-3', cursor: 'c5' });
  } finally {
    await h.cleanup();
  }
});

test('occurrences of one recurring event are all kept', async () => {
  const h = await harness();
  try {
    h.control.events = [
      event('j1:cal:series:1', '2026-10-20T10:00:00Z'),
      event('j1:cal:series:2', '2026-10-27T10:00:00Z'),
    ];
    const state = (await h.service.invoke('sync')) as AppState;
    assert.equal(state.events.filter(e => e.remoteId === 'series.ics').length, 2);
  } finally {
    await h.cleanup();
  }
});

test('staged memory: reads see the stage, other writers make it stale, discarded writes never land', () => {
  const rows = new Map<string, string>();
  const base = {
    get: (a: string, k: string) => rows.get(`${a}/${k}`),
    set: (a: string, k: string, v: string | undefined) => {
      if (v === undefined) rows.delete(`${a}/${k}`);
      else rows.set(`${a}/${k}`, v);
    },
    clear: (a: string) => {
      for (const k of [...rows.keys()]) if (k.startsWith(`${a}/`)) rows.delete(k);
    },
  };
  const { memory, stage } = createStagedMemory(base);
  const s = stage();
  s.run(() => {
    memory.set('a', 'k', 'staged');
    assert.equal(memory.get('a', 'k'), 'staged');
  });
  assert.equal(memory.get('a', 'k'), undefined, 'outside the stage nothing changed yet');
  assert.deepEqual(s.writes(), [{ accountId: 'a', key: 'k', value: 'staged' }]);
  memory.set('a', 'k', 'direct');
  assert.equal(s.writes(), undefined, 'a direct write to a staged key makes the stage stale');
  s.discard();
  s.run(() => memory.set('a', 'k', 'late'));
  assert.equal(memory.get('a', 'k'), 'late', 'a closed stage passes writes straight through');
});
