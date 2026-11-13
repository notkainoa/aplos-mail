import test from 'node:test';
import assert from 'node:assert/strict';
import type { FolderList, PlannedStep, ProviderAdapter, StepResult, SyncState } from '../src/ports';
import { FOLDER_REFETCH_MS } from '../src/sync/host-read';
import {
  ACCOUNT,
  FakeAdapter,
  disk,
  fact,
  messagesIn,
  settle,
  stateOf,
  until,
  world,
} from './sync-actor-helpers';

/*
 * `sync_scope = 'lazy'` folders (Spam, Trash, Starred, user labels) were never fetched: the 2026-11-12 packaged
 * build showed "Spam is empty" for folders that held mail, and Starred listed nothing. `ProviderPort.listFolder`
 * is the open-time fetch the engine calls from `View/watch` on a label or mailbox spec. These tests cover the
 * host half: the fetch commits real placements (origin 'sync', so they count in views), the `folder:<id>` state
 * throttles re-opens, and a successful mail step marks `Account` so `lastSyncAt` reaches the UI (bug: Settings >
 * Accounts showed "synced at" nine hours stale).
 */

/** A step that always succeeds and changes nothing, so the actor's commit can be inspected. */
const idleStep: PlannedStep = {
  scope: 'window:inbox',
  lane: 'incremental',
  origin: 'incremental',
  trigger: 'poll',
};

const done = (state: SyncState) => async (): Promise<StepResult> => ({
  nextStates: [{ ...state, phase: 'done' }],
  done: true,
  costUnits: 5,
});

test('a successful step marks Account, even when nothing about the row changed (lastSyncAt)', async () => {
  const d = disk();
  const adapter = new FakeAdapter(
    input => (input.states.some(s => s.scope === 'window:inbox') ? [] : [idleStep]),
    { 'window:inbox': done({ scope: 'window:inbox', generation: 0, updatedAt: 0 }) },
  );
  const w = world(d, () => adapter);
  // The baseline is taken before start: the old code wrote no Account row at all, so a `seq > base` mark is new.
  const base = w.store.seq();
  try {
    await w.host.start(ACCOUNT);
    await until(() => adapter.calls.includes('window:inbox:'), 'the step to run');
    const marks = w.store.read(q =>
      q.all<{ type: string }>(
        'SELECT type FROM changes WHERE seq > ? AND type = ?',
        base,
        'Account',
      ),
    );
    assert.deepEqual(
      marks.map(m => m.type),
      ['Account'],
    );
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('listFolder commits the page as sync facts under the folder and stamps folder:<id>', async () => {
  const d = disk();
  const adapter = new FakeAdapter(() => [], {}) as FakeAdapter & ProviderAdapter;
  const seen: (string | undefined)[] = [];
  adapter.listFolder = async (folder: string, pageToken: string | undefined) => {
    seen.push(`${folder}:${pageToken ?? ''}`);
    return {
      upserts: [
        fact('spam-1', 3, { placements: [{ folder: 'SPAM' }] }),
        fact('spam-2', 4, { placements: [{ folder: 'SPAM' }] }),
      ],
    } satisfies FolderList;
  };
  const w = world(d, () => adapter);
  try {
    // The folder row, as a labels.list sync would write it.
    w.store.commit({
      opId: 'folders',
      origin: 'sync',
      writes: [
        {
          kind: 'folder',
          accountId: ACCOUNT,
          remoteId: 'SPAM',
          name: 'Spam',
          role: 'spam',
          folderKind: 'system',
        },
      ],
    });
    await w.host.start(ACCOUNT);
    await settle();
    await w.host.listFolder(ACCOUNT, 'SPAM');
    assert.deepEqual(seen, ['SPAM:']);
    assert.deepEqual(messagesIn(w.store, 'SPAM').sort(), ['spam-1', 'spam-2']);
    const state = stateOf(w.store, 'folder:SPAM');
    assert.ok(state, 'the folder scope is stamped fetched');
    assert.equal(state!.page_token, null);
    // A second open inside the throttle window makes no call.
    await w.host.listFolder(ACCOUNT, 'SPAM');
    assert.deepEqual(seen, ['SPAM:']);
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('listFolder re-reads the head every open and continues a held walk on top of it', async () => {
  const d = disk();
  const adapter = new FakeAdapter(() => [], {}) as FakeAdapter & ProviderAdapter;
  const seen: (string | undefined)[] = [];
  adapter.listFolder = async (_folder: string, pageToken: string | undefined) => {
    seen.push(pageToken);
    return pageToken === undefined
      ? {
          upserts: [fact('trash-1', 3, { placements: [{ folder: 'TRASH' }] })],
          nextPageToken: 'p2',
        }
      : { upserts: [fact('trash-2', 4, { placements: [{ folder: 'TRASH' }] })] };
  };
  const w = world(d, () => adapter);
  try {
    w.store.commit({
      opId: 'folders',
      origin: 'sync',
      writes: [
        {
          kind: 'folder',
          accountId: ACCOUNT,
          remoteId: 'TRASH',
          name: 'Trash',
          role: 'trash',
          folderKind: 'system',
        },
      ],
    });
    await w.host.start(ACCOUNT);
    await settle();
    await w.host.listFolder(ACCOUNT, 'TRASH');
    assert.equal(stateOf(w.store, 'folder:TRASH')?.page_token, 'p2');
    await w.clock.advance(FOLDER_REFETCH_MS + 1);
    await w.host.listFolder(ACCOUNT, 'TRASH');
    // Head first (fresh), then the held token: the walk completes and the head's remainder stays bookmarked.
    assert.deepEqual(seen, [undefined, undefined, 'p2']);
    assert.equal(stateOf(w.store, 'folder:TRASH')?.page_token, 'p2');
    await w.clock.advance(FOLDER_REFETCH_MS + 1);
    seen.length = 0;
    adapter.listFolder = async (_f: string, t: string | undefined) => {
      seen.push(t);
      return { upserts: [] };
    };
    await w.host.listFolder(ACCOUNT, 'TRASH');
    // The walk finished (no token anywhere): the bookmark clears, the next open is head-only.
    assert.deepEqual(seen, [undefined, 'p2']);
    assert.equal(stateOf(w.store, 'folder:TRASH')?.page_token, null);
    assert.deepEqual(messagesIn(w.store, 'TRASH').sort(), ['trash-1', 'trash-2']);
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('a rejected walk token is dropped and the fresh head page still commits', async () => {
  const d = disk();
  const adapter = new FakeAdapter(() => [], {}) as FakeAdapter & ProviderAdapter;
  const seen: (string | undefined)[] = [];
  let heads = 0;
  adapter.listFolder = async (_f: string, t: string | undefined) => {
    seen.push(t);
    if (t === 'bad') throw new Error('invalid pageToken');
    heads += 1;
    return {
      upserts: [fact('head-1', 2, { placements: [{ folder: 'TRASH' }] })],
      ...(heads === 1 ? { nextPageToken: 'bad' } : {}),
    };
  };
  const w = world(d, () => adapter);
  try {
    w.store.commit({
      opId: 'folders',
      origin: 'sync',
      writes: [
        {
          kind: 'folder',
          accountId: ACCOUNT,
          remoteId: 'TRASH',
          name: 'Trash',
          role: 'trash',
          folderKind: 'system',
        },
      ],
    });
    await w.host.start(ACCOUNT);
    await settle();
    await w.host.listFolder(ACCOUNT, 'TRASH');
    assert.equal(stateOf(w.store, 'folder:TRASH')?.page_token, 'bad');
    await w.clock.advance(FOLDER_REFETCH_MS + 1);
    seen.length = 0;
    await w.host.listFolder(ACCOUNT, 'TRASH');
    assert.deepEqual(seen, [undefined, 'bad']);
    // The token is cleared instead of wedging the folder; head mail still landed.
    assert.equal(stateOf(w.store, 'folder:TRASH')?.page_token, null);
    assert.deepEqual(messagesIn(w.store, 'TRASH'), ['head-1']);
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('a total listFolder failure stamps the backoff row and the next open waits', async () => {
  const d = disk();
  const adapter = new FakeAdapter(() => [], {}) as FakeAdapter & ProviderAdapter;
  const seen: (string | undefined)[] = [];
  adapter.listFolder = async (_f: string, t: string | undefined) => {
    seen.push(t);
    throw new Error('offline');
  };
  const w = world(d, () => adapter);
  try {
    w.store.commit({
      opId: 'folders',
      origin: 'sync',
      writes: [
        {
          kind: 'folder',
          accountId: ACCOUNT,
          remoteId: 'TRASH',
          name: 'Trash',
          role: 'trash',
          folderKind: 'system',
        },
      ],
    });
    await w.host.start(ACCOUNT);
    await settle();
    await assert.rejects(w.host.listFolder(ACCOUNT, 'TRASH'), /offline/);
    // One retry of the head page, then the row is stamped so the next open backs off.
    assert.deepEqual(seen, [undefined, undefined]);
    const state = stateOf(w.store, 'folder:TRASH');
    assert.ok(state, 'the backoff stamp is written');
    assert.equal(state!.page_token, null);
    await w.host.listFolder(ACCOUNT, 'TRASH');
    assert.deepEqual(seen, [undefined, undefined]);
    await w.clock.advance(FOLDER_REFETCH_MS + 1);
    await assert.rejects(w.host.listFolder(ACCOUNT, 'TRASH'), /offline/);
    assert.deepEqual(seen, [undefined, undefined, undefined, undefined]);
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('overlapping opens of one folder share the in-flight fetch', async () => {
  const d = disk();
  const adapter = new FakeAdapter(() => [], {}) as FakeAdapter & ProviderAdapter;
  const seen: (string | undefined)[] = [];
  let release!: (v: { upserts: [] }) => void;
  const gate = new Promise<{ upserts: [] }>(r => (release = r));
  adapter.listFolder = async (_f: string, t: string | undefined) => {
    seen.push(t);
    return gate;
  };
  const w = world(d, () => adapter);
  try {
    w.store.commit({
      opId: 'folders',
      origin: 'sync',
      writes: [
        {
          kind: 'folder',
          accountId: ACCOUNT,
          remoteId: 'TRASH',
          name: 'Trash',
          role: 'trash',
          folderKind: 'system',
        },
      ],
    });
    await w.host.start(ACCOUNT);
    await settle();
    const a = w.host.listFolder(ACCOUNT, 'TRASH');
    const b = w.host.listFolder(ACCOUNT, 'TRASH');
    release({ upserts: [] });
    await Promise.all([a, b]);
    assert.deepEqual(seen, [undefined]);
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('a provider without listFolder resolves having fetched nothing', async () => {
  const d = disk();
  const adapter = new FakeAdapter(() => [], {});
  const w = world(d, () => adapter);
  try {
    await w.host.start(ACCOUNT);
    await settle();
    await w.host.listFolder(ACCOUNT, 'SPAM');
    assert.equal(stateOf(w.store, 'folder:SPAM'), undefined);
  } finally {
    await w.kill();
    d.cleanup();
  }
});
