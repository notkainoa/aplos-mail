import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../../../../../apps/desktop/src/host/sqlite';
import {
  openStore,
  StoreError,
  type CommitInput,
  type FolderRef,
  type MessageTarget,
  type StorePort,
  type StoreWrite,
} from '../../../src/store';
import { ACCOUNT, T0, accountWrite, folderWrites, msg } from '../helpers';
import { replay, snapshot, type Snapshot } from '../replay-helpers';

/*
 * The change-log property (ARCH 3.5, plan 10 E2, FR-15): a client holding snapshot(seqK) that applies every change row
 * after K, re-reading each `u` item and every item of a `*` type, ends with exactly snapshot(seqN). Any derived value
 * that moves without a change row (a label deleted under a message, a folder's unread count after a rollup) breaks it.
 */

/** mulberry32: small, seedable, good enough to shuffle a store. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return {
    next,
    int,
    pick: <T>(xs: readonly T[]) => xs[int(xs.length)],
    chance: (p: number) => next() < p,
  };
}

const MESSAGES = Array.from({ length: 12 }, (_, i) => `m${i}`);
const THREADS = ['t0', 't1', 't2', 't3', 't4'];
const FOLDERS = ['INBOX', 'TRASH', 'Label_1', 'Label_2', 'Label_3'];
const LABELS = ['Label_1', 'Label_2', 'Label_3'];

const CALENDARS = ['primary', 'team'];
const EVENTS = ['e0', 'e1', 'e2'];

const folderRefs = (r: ReturnType<typeof rng>): FolderRef[] =>
  FOLDERS.filter(() => r.chance(0.3)).map(folder => ({ folder }));
const target = (r: ReturnType<typeof rng>): MessageTarget =>
  r.chance(0.7) ? { remoteId: r.pick(MESSAGES) } : { remoteThreadId: r.pick(THREADS) };

/** Local commits also enqueue and settle ops; sync commits merge threads, address UIDs and write calendars. */
function randomSpecialWrite(r: ReturnType<typeof rng>, step: number, local: boolean): StoreWrite {
  if (local) {
    const opId = `op${r.int(6)}`;
    if (r.chance(0.6))
      return {
        kind: 'op',
        opId: `${opId}-${step}`,
        accountId: ACCOUNT,
        opKind: 'label',
        targets: [],
        payload: '{}',
        scope: 'triage',
        effect: r.chance(0.5)
          ? [
              {
                kind: 'placements',
                target: target(r),
                add: folderRefs(r),
                remove: FOLDERS.filter(() => r.chance(0.3)),
              },
            ]
          : [{ kind: 'flags', target: target(r), seen: r.chance(0.5) }],
      };
  }
  return randomSyncWrite(r, step);
}

/** Sync commits also merge threads, address UIDs and write calendars: after an op chance, 0..6. */
function randomSyncWrite(r: ReturnType<typeof rng>, step: number): StoreWrite {
  const roll = r.int(7);
  if (roll === 0)
    return {
      kind: 'threadMerge',
      accountId: ACCOUNT,
      from: [r.pick(THREADS)],
      into: r.pick(THREADS),
    };
  if (roll === 1)
    return {
      kind: 'flags',
      accountId: ACCOUNT,
      target: { folder: r.pick(FOLDERS), uid: 1 + r.int(MESSAGES.length) },
      flagged: r.chance(0.5),
    };
  if (roll === 2)
    return {
      kind: 'calendar',
      accountId: ACCOUNT,
      remoteId: r.pick(CALENDARS),
      name: `Cal ${r.int(3)}`,
      hidden: r.chance(0.2),
      readOnly: false,
      selected: r.chance(0.3) ? r.chance(0.5) : undefined,
    };
  if (roll === 3)
    return { kind: 'calendarDelete', accountId: ACCOUNT, remoteId: r.pick(CALENDARS) };
  if (roll === 4)
    return {
      kind: 'event',
      accountId: ACCOUNT,
      calendarRemoteId: r.pick(CALENDARS),
      remoteId: r.pick(EVENTS),
      rows: ['', 'r1', 'r2']
        .filter(() => r.chance(0.5))
        .map(id => ({
          recurrenceId: id || undefined,
          status: 'confirmed',
          allDay: false,
          startUtc: T0 + r.int(5),
          data: String(r.int(3)),
        })),
      seenGen: r.chance(0.7) ? step : undefined,
    };
  if (roll === 5)
    return {
      kind: 'eventSweep',
      accountId: ACCOUNT,
      calendarRemoteId: r.pick(CALENDARS),
      generation: step,
      from: r.chance(0.5) ? T0 + 2 : undefined,
    };
  return {
    kind: 'eventDelete',
    accountId: ACCOUNT,
    calendarRemoteId: r.pick(CALENDARS),
    remoteId: r.pick(EVENTS),
  };
}

/** The 0..99 dispatch: messages, placements, flags, deletes, folders, sweep, workflow, thread. */
function randomPlainWrite(r: ReturnType<typeof rng>, step: number): StoreWrite {
  const roll = r.int(100);
  if (roll < 30) {
    const id = r.pick(MESSAGES);
    return msg(
      id,
      r.chance(0.85) ? THREADS[MESSAGES.indexOf(id) % THREADS.length] : r.pick(THREADS),
      r.int(600),
      {
        flags: {
          seen: r.chance(0.5),
          flagged: r.chance(0.2),
          draft: r.chance(0.08),
          fromMe: r.chance(0.2),
        },
        folders: r.chance(0.8)
          ? folderRefs(r).map(f => (r.chance(0.3) ? { ...f, uid: 1 + MESSAGES.indexOf(id) } : f))
          : undefined,
        seenGen: r.chance(0.5) ? step : undefined,
        hasAttachments: r.chance(0.2),
      },
    );
  }
  if (roll < 45)
    return {
      kind: 'placements',
      accountId: ACCOUNT,
      target: target(r),
      add: folderRefs(r),
      remove: FOLDERS.filter(() => r.chance(0.25)),
    };
  if (roll < 60)
    return {
      kind: 'flags',
      accountId: ACCOUNT,
      target: target(r),
      seen: r.chance(0.5),
      flagged: r.chance(0.5) ? r.chance(0.5) : undefined,
    };
  if (roll < 66) return { kind: 'messageDelete', accountId: ACCOUNT, remoteId: r.pick(MESSAGES) };
  if (roll < 69)
    return { kind: 'threadDelete', accountId: ACCOUNT, remoteThreadId: r.pick(THREADS) };
  if (roll < 77)
    return {
      kind: 'folder',
      accountId: ACCOUNT,
      remoteId: r.pick(LABELS),
      name: `Label ${r.int(3)}`,
      role: r.pick([null, null, 'trash', 'spam'] as const),
      folderKind: 'label',
    };
  if (roll < 84) return { kind: 'folderDelete', accountId: ACCOUNT, remoteId: r.pick(LABELS) };
  if (roll < 90)
    return { kind: 'sweep', accountId: ACCOUNT, folder: r.pick(FOLDERS), generation: step };
  if (roll < 95)
    return {
      kind: 'workflow',
      accountId: ACCOUNT,
      remoteThreadId: r.pick(THREADS),
      patch: { status: r.pick(['new', 'done', 'later'] as const) },
    };
  return {
    kind: 'thread',
    accountId: ACCOUNT,
    remoteThreadId: r.pick(THREADS),
    complete: r.chance(0.5),
    remoteCount: r.int(9),
  };
}

function randomWrite(r: ReturnType<typeof rng>, step: number, local: boolean): StoreWrite {
  if (r.chance(0.25)) return randomSpecialWrite(r, step, local);
  return randomPlainWrite(r, step);
}

/** Compacts at random points: a small row limit, or an age limit against the clock the sequence advances. */
function maybeCompact(r: ReturnType<typeof rng>, store: StorePort, rate: number) {
  if (!r.chance(rate)) return;
  const options = r.chance(0.5)
    ? { maxRows: r.int(25), maxAgeMs: r.chance(0.3) ? r.int(60) * MINUTE : undefined }
    : { maxAgeMs: r.int(120) * MINUTE };
  const before = floorOf(store);
  const { floorSeq } = store.compact(options);
  assert.ok(floorSeq >= before && floorSeq <= store.seq(), `floor ${floorSeq} out of range`);
}

const MINUTE = 60_000;
const floorOf = (store: StorePort) =>
  store.read(q => Number(q.get("SELECT value FROM meta WHERE key = 'change_floor_seq'")!.value));

function commitRandom(r: ReturnType<typeof rng>, store: StorePort, i: number) {
  const origin = r.chance(0.3) ? 'local' : 'sync';
  const input: CommitInput = {
    opId: `c${i}`,
    origin,
    fenceSeq: origin === 'sync' && r.chance(0.3) ? r.int(store.seq() + 1) : undefined,
    changes: origin === 'sync' && r.chance(0.15) ? 'coarse' : 'fine',
    writes: Array.from({ length: 1 + r.int(4) }, () => randomWrite(r, i + 2, origin === 'local')),
  };
  // Settle some open op: drained, failed, retried or undone.
  const open = store.read(q => q.all<{ op_id: string }>('SELECT op_id FROM ops').map(o => o.op_id));
  if (open.length && r.chance(0.3))
    input.writes.push({
      kind: 'opSettle',
      opId: r.pick(open),
      state: r.pick(['inflight', 'failed', 'queued', 'synced', 'cancelled'] as const),
    });
  try {
    store.commit(input);
  } catch (error) {
    // A local edit of a missing item fails the whole commit; that is the store's rule, not a replay failure.
    if (!(error instanceof StoreError)) throw error;
  }
}

/** Above the floor: replay reaches the latest snapshot. Below it: the store refuses and names the floor. */
function checkSnapshots(seed: number, store: StorePort, snaps: Map<number, Snapshot>) {
  const latest = snapshot(store);
  const floorSeq = floorOf(store);
  for (const [seq, snap] of snaps) {
    if (seq < floorSeq) {
      assert.deepEqual(
        store.changesSince(seq),
        { status: 'cannotCalculateChanges', floorSeq, seq: store.seq() },
        `seed ${seed}: changesSince(${seq}) below floor ${floorSeq} was not refused`,
      );
      continue;
    }
    const got = replay(snap, store, seq, latest);
    const stale = [...new Set([...got.keys(), ...latest.keys()])].filter(
      k => got.get(k) !== latest.get(k),
    );
    assert.deepEqual(
      stale.map(k => k.replace('\0', ' ')),
      [],
      `seed ${seed}: snapshot(${seq}) + changes != snapshot(${store.seq()}) (floor ${floorSeq})`,
    );
  }
}

function runSequence(seed: number, commits: number) {
  const r = rng(seed);
  const clock = { now: T0 };
  const store = openStore(openSqlite(':memory:'), { now: () => clock.now });
  // A third of the sequences never compact, so the full log from seq 0 is still proved.
  const compactRate = r.pick([0, 0.1, 0.25]);
  try {
    store.commit({ opId: 'setup', origin: 'sync', writes: [accountWrite, ...folderWrites] });
    const snaps = new Map<number, Snapshot>([[store.seq(), snapshot(store)]]);
    for (let i = 0; i < commits; i++) {
      clock.now += r.int(10) * MINUTE;
      commitRandom(r, store, i);
      snaps.set(store.seq(), snapshot(store));
      maybeCompact(r, store, compactRate);
    }
    checkSnapshots(seed, store, snaps);
  } catch (error) {
    throw new Error(`replay failed for APLOS_REPLAY_SEED=${seed}`, { cause: error });
  } finally {
    store.close();
  }
}

// 80 sequences of 30 commits by default (about 10 s); APLOS_REPLAY_RUNS=1000 for the store-1 depth, APLOS_REPLAY_SEED to rerun.
test('snapshot(seqK) + changes == snapshot(seqN) over seeded random commit sequences (FR-15)', () => {
  const base = Number(process.env.APLOS_REPLAY_SEED ?? 1);
  const runs = Number(process.env.APLOS_REPLAY_RUNS ?? 80);
  for (let i = 0; i < runs; i++) runSequence(base + i, 30);
});

test('a deleted label changes its messages, and a read elsewhere changes the folder counts (FR-15)', () => {
  const store = openStore(openSqlite(':memory:'), { now: () => T0 });
  try {
    store.commit({ opId: 'setup', origin: 'sync', writes: [accountWrite, ...folderWrites] });
    store.commit({
      opId: 'page',
      origin: 'sync',
      writes: [msg('m1', 't1', 0, { folders: [{ folder: 'INBOX' }, { folder: 'Label_1' }] })],
    });
    const before = store.seq();
    store.commit({
      opId: 'gone',
      origin: 'sync',
      writes: [{ kind: 'folderDelete', accountId: ACCOUNT, remoteId: 'Label_1' }],
    });
    store.commit({
      opId: 'read',
      origin: 'sync',
      writes: [{ kind: 'flags', accountId: ACCOUNT, target: { remoteId: 'm1' }, seen: true }],
    });
    const page = store.changesSince(before);
    assert.ok(page.status === 'ok');
    assert.deepEqual(
      page.changes.map(c => `${c.seq} ${c.type} ${c.id} ${c.op}`),
      [
        `${before + 1} Folder ${ACCOUNT}:Label_1 d`,
        `${before + 1} Message ${ACCOUNT}:m1 u`,
        `${before + 1} Thread ${ACCOUNT}:t1 u`,
        `${before + 2} Folder ${ACCOUNT}:INBOX u`,
        `${before + 2} Message ${ACCOUNT}:m1 u`,
        `${before + 2} Thread ${ACCOUNT}:t1 u`,
      ],
    );
  } finally {
    store.close();
  }
});
