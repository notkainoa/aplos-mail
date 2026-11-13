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

/** `Account` change rows above `base`: the only way `lastSyncAt` reaches the renderer. */
const accountMarks = (w: ReturnType<typeof world>, base: number) =>
  w.store.read(q =>
    q.all<{ type: string }>('SELECT type FROM changes WHERE seq > ? AND type = ?', base, 'Account'),
  );

test('a successful step marks Account, even when nothing about the row changed (lastSyncAt)', async () => {
  const d = disk();
  // `notBefore` schedules each step on the fake clock: the actor `clock.sleep`s to the due time, so `advance`
  // lands each step's commit in the display minute the test intends.
  const times: number[] = [];
  const adapter: FakeAdapter = new FakeAdapter(
    (): PlannedStep[] =>
      adapter.calls.length < times.length
        ? [{ ...idleStep, notBefore: times[adapter.calls.length] }]
        : [],
    { 'window:inbox': done({ scope: 'window:inbox', generation: 0, updatedAt: 0 }) },
  );
  const w = world(d, () => adapter);
  try {
    times.push(w.clock.now(), w.clock.now() + 60_001);
    await w.host.start(ACCOUNT);
    await until(() => adapter.calls.length >= 1, 'the first step to run');
    await settle();
    // The baseline sits after start: the status write there already marks Account, so a `seq > base` row can only
    // come from the step's own commit (the old code wrote none — Opus caught the baseline-before-start version
    // passing either way).
    const base = w.store.seq();
    await w.clock.advance(60_001);
    await until(() => adapter.calls.length >= 2, 'the second step to run');
    await settle();
    assert.deepEqual(
      accountMarks(w, base).map(m => m.type),
      ['Account'],
    );
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('the Account touch is once a display minute', async () => {
  const d = disk();
  const times: number[] = [];
  const adapter: FakeAdapter = new FakeAdapter(
    (): PlannedStep[] =>
      adapter.calls.length < times.length
        ? [{ ...idleStep, notBefore: times[adapter.calls.length] }]
        : [],
    { 'window:inbox': done({ scope: 'window:inbox', generation: 0, updatedAt: 0 }) },
  );
  const w = world(d, () => adapter);
  try {
    const t0 = w.clock.now();
    times.push(t0, t0 + 1, t0 + 60_001);
    await w.host.start(ACCOUNT);
    await until(() => adapter.calls.length >= 1, 'the first step to run');
    await settle();
    // Same display minute as the first step: no second touch — the Settings row cannot show it anyway.
    const base = w.store.seq();
    await w.clock.advance(1);
    await until(() => adapter.calls.length >= 2, 'the second step to run');
    await settle();
    assert.deepEqual(accountMarks(w, base), []);
    // The next display minute touches again.
    await w.clock.advance(60_001);
    await until(() => adapter.calls.length >= 3, 'the third step to run');
    await settle();
    assert.deepEqual(
      accountMarks(w, base).map(m => m.type),
      ['Account'],
    );
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('a failed step touches nothing', async () => {
  const d = disk();
  const adapter: FakeAdapter = new FakeAdapter(
    (): PlannedStep[] => (adapter.calls.length === 0 ? [idleStep] : []),
    {
      'window:inbox': async () => {
        throw new Error('down');
      },
    },
  );
  const w = world(d, () => adapter);
  try {
    await w.host.start(ACCOUNT);
    await until(() => adapter.calls.length >= 1, 'the step to run');
    await settle();
    const base = w.store.seq();
    await settle();
    assert.deepEqual(accountMarks(w, base), []);
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

test('listFolder fetches one page per open: a held token continues the walk, none re-reads the head', async () => {
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
    // Exactly one call per open (Opus: a head-plus-continuation open could bill ~5,000 quota units).
    assert.deepEqual(seen, [undefined, 'p2']);
    // The walk completed: the bookmark clears, so the next open re-reads the head.
    assert.equal(stateOf(w.store, 'folder:TRASH')?.page_token, null);
    assert.deepEqual(messagesIn(w.store, 'TRASH').sort(), ['trash-1', 'trash-2']);
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('a rejected walk token clears the bookmark; the next open re-reads the head', async () => {
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
    await assert.rejects(w.host.listFolder(ACCOUNT, 'TRASH'), /invalid pageToken/);
    // The token is cleared instead of wedging the folder.
    assert.deepEqual(seen, ['bad']);
    assert.equal(stateOf(w.store, 'folder:TRASH')?.page_token, null);
    await w.clock.advance(FOLDER_REFETCH_MS + 1);
    await w.host.listFolder(ACCOUNT, 'TRASH');
    assert.deepEqual(seen, ['bad', undefined]);
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
    // One call, then the row is stamped so the next open backs off.
    assert.deepEqual(seen, [undefined]);
    const state = stateOf(w.store, 'folder:TRASH');
    assert.ok(state, 'the backoff stamp is written');
    assert.equal(state!.page_token, null);
    await w.host.listFolder(ACCOUNT, 'TRASH');
    assert.deepEqual(seen, [undefined]);
    await w.clock.advance(FOLDER_REFETCH_MS + 1);
    await assert.rejects(w.host.listFolder(ACCOUNT, 'TRASH'), /offline/);
    assert.deepEqual(seen, [undefined, undefined]);
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('overlapping opens of one folder share the in-flight fetch, even across a commit', async () => {
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
    // A commit in between bumps the store seq; the second open still joins the first (the key holds no fence).
    w.store.commit({
      opId: 'between',
      origin: 'sync',
      writes: [
        {
          kind: 'syncState',
          accountId: ACCOUNT,
          scope: 'window:inbox',
          generation: 0,
          cursor: 'x',
        },
      ],
    });
    const b = w.host.listFolder(ACCOUNT, 'TRASH');
    release({ upserts: [] });
    await Promise.all([a, b]);
    assert.deepEqual(seen, [undefined]);
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('the folder page commits under the read fence (placements cannot outrun the mutation log)', async () => {
  const d = disk();
  const adapter = new FakeAdapter(() => [], {}) as FakeAdapter & ProviderAdapter;
  adapter.listFolder = async () => ({
    upserts: [fact('trash-1', 3, { placements: [{ folder: 'TRASH' }] })],
  });
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
    const commits: { fenceSeq?: number }[] = [];
    const orig = w.store.commit.bind(w.store);
    w.store.commit = ((input: Parameters<typeof orig>[0]) => {
      commits.push(input);
      return orig(input);
    }) as typeof orig;
    await w.host.listFolder(ACCOUNT, 'TRASH');
    const page = commits.find(c =>
      (c as { writes?: { kind: string }[] }).writes?.some(x => x.kind === 'message'),
    );
    assert.ok(page, 'the page commit ran through the store');
    assert.equal(typeof page!.fenceSeq, 'number', 'the commit carries the read fence');
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
