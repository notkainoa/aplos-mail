import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../../../../../apps/desktop/src/host/sqlite';
import {
  eventChangeKey,
  openStore,
  StoreError,
  type CommitInput,
  type FolderRef,
  type MessageTarget,
  type StorePort,
  type StoreWrite,
} from '../../../src/store';
import { ACCOUNT, T0, accountWrite, folderWrites, msg } from '../helpers';

/*
 * The change-log property (ARCH 3.5, plan 10 E2, FR-15): a client holding snapshot(seqK) that applies every change row
 * after K, re-reading each `u` item and every item of a `*` type, ends with exactly snapshot(seqN). Any derived value
 * that moves without a change row (a label deleted under a message, a folder's unread count after a rollup) breaks it.
 */

type Snapshot = Map<string, string>; // `${type}\0${id}` → canonical JSON

/** The contract-visible state, read straight from the tables; derived numbers are recomputed here, not trusted. */
function snapshot(store: StorePort): Snapshot {
  const out: Snapshot = new Map();
  const put = (type: string, id: string, value: unknown) =>
    out.set(`${type}\0${id}`, JSON.stringify(value));
  store.read(q => {
    for (const a of q.all(
      'SELECT a.*, (SELECT count(*) FROM ops o WHERE o.account_id = a.id) AS pending_changes FROM accounts a',
    ))
      put('Account', String(a.id), a);
    for (const c of q.all('SELECT account_id, remote_id, name, hidden, selected FROM calendars'))
      put('Calendar', `${c.account_id}:${c.remote_id}`, c);
    for (const e of q.all(
      `SELECT c.account_id, c.remote_id AS cal, e.remote_id,
        json_group_array(json_array(e.recurrence_id, e.status, e.start_utc, e.data)) AS rows
      FROM (SELECT * FROM events ORDER BY recurrence_id) e JOIN calendars c ON c.id = e.calendar_id
      GROUP BY c.account_id, c.remote_id, e.remote_id`,
    ))
      put('Event', `${e.account_id}:${eventChangeKey(String(e.cal), String(e.remote_id))}`, e);
    for (const f of q.all(
      `SELECT f.account_id, f.remote_id, f.name, f.role, f.kind, f.hidden,
        (SELECT count(*) FROM thread_folders tf WHERE tf.folder_id = f.id) AS total,
        (SELECT count(*) FROM thread_folders tf WHERE tf.folder_id = f.id AND tf.unread > 0) AS unread
      FROM folders f`,
    ))
      put('Folder', `${f.account_id}:${f.remote_id}`, f);
    for (const t of q.all(
      `SELECT t.*, w.status, w.later_until, w.bookmarked, w.lane, w.importance,
        (SELECT json_group_array(f.remote_id) FROM (SELECT f.remote_id FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id
          WHERE tf.thread_id = t.id ORDER BY f.remote_id) f) AS lists
      FROM threads t JOIN thread_workflow w ON w.thread_id = t.id`,
    )) {
      const { id: _internal, ...row } = t;
      put('Thread', `${t.account_id}:${t.remote_id}`, row);
    }
    for (const m of q.all(
      `SELECT m.*, t.remote_id AS thread,
        (SELECT json_group_array(x.remote_id) FROM (SELECT f.remote_id FROM message_folders mf JOIN folders f ON f.id = mf.folder_id
          WHERE mf.message_id = m.id ORDER BY f.remote_id) x) AS labels
      FROM messages m JOIN threads t ON t.id = m.thread_id`,
    )) {
      const { id: _internal, thread_id: _thread, ...row } = m;
      put('Message', `${m.account_id}:${m.remote_id}`, row);
    }
  });
  return out;
}

/** What a client does with the change log: drop `d`, re-read `u`, re-read the whole type of the account for `*`. */
function replay(from: Snapshot, store: StorePort, since: number, latest: Snapshot): Snapshot {
  const client = new Map(from);
  for (let seq = since, more = true; more;) {
    const page = store.changesSince(seq, { limit: 7 });
    assert.equal(page.status, 'ok');
    if (page.status !== 'ok') break;
    for (const c of page.changes) {
      const key = `${c.type}\0${c.id}`;
      if (c.op === 'd') client.delete(key);
      else if (c.op === 'u') {
        const now = latest.get(key);
        if (now === undefined) client.delete(key);
        else client.set(key, now);
      } else {
        const prefix = `${c.type}\0${c.id}:`;
        for (const k of [...client.keys()]) if (k.startsWith(prefix)) client.delete(k);
        for (const [k, v] of latest) if (k.startsWith(prefix)) client.set(k, v);
      }
    }
    seq = page.toSeq;
    more = page.hasMore;
  }
  return client;
}

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

function randomWrite(r: ReturnType<typeof rng>, step: number, local: boolean): StoreWrite {
  const refs = (): FolderRef[] => FOLDERS.filter(() => r.chance(0.3)).map(folder => ({ folder }));
  const target = (): MessageTarget =>
    r.chance(0.7) ? { remoteId: r.pick(MESSAGES) } : { remoteThreadId: r.pick(THREADS) };
  // Local commits also enqueue and settle ops; sync commits merge threads, address UIDs and write calendars.
  if (r.chance(0.25)) {
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
                  target: target(),
                  add: refs(),
                  remove: FOLDERS.filter(() => r.chance(0.3)),
                },
              ]
            : [{ kind: 'flags', target: target(), seen: r.chance(0.5) }],
        };
    }
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
          ? refs().map(f => (r.chance(0.3) ? { ...f, uid: 1 + MESSAGES.indexOf(id) } : f))
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
      target: target(),
      add: refs(),
      remove: FOLDERS.filter(() => r.chance(0.25)),
    };
  if (roll < 60)
    return {
      kind: 'flags',
      accountId: ACCOUNT,
      target: target(),
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

function runSequence(seed: number, commits: number) {
  const r = rng(seed);
  const store = openStore(openSqlite(':memory:'), { now: () => T0 });
  try {
    store.commit({ opId: 'setup', origin: 'sync', writes: [accountWrite, ...folderWrites] });
    const snaps = new Map<number, Snapshot>([[store.seq(), snapshot(store)]]);
    for (let i = 0; i < commits; i++) {
      const origin = r.chance(0.3) ? 'local' : 'sync';
      const input: CommitInput = {
        opId: `c${i}`,
        origin,
        fenceSeq: origin === 'sync' && r.chance(0.3) ? r.int(store.seq() + 1) : undefined,
        changes: origin === 'sync' && r.chance(0.15) ? 'coarse' : 'fine',
        writes: Array.from({ length: 1 + r.int(4) }, () =>
          randomWrite(r, i + 2, origin === 'local'),
        ),
      };
      // Settle some open op: drained, failed, retried or undone.
      const open = store.read(q =>
        q.all<{ op_id: string }>('SELECT op_id FROM ops').map(o => o.op_id),
      );
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
      snaps.set(store.seq(), snapshot(store));
    }
    const latest = snapshot(store);
    for (const [seq, snap] of snaps) {
      const got = replay(snap, store, seq, latest);
      const stale = [...new Set([...got.keys(), ...latest.keys()])].filter(
        k => got.get(k) !== latest.get(k),
      );
      assert.deepEqual(
        stale.map(k => k.replace('\0', ' ')),
        [],
        `seed ${seed}: snapshot(${seq}) + changes != snapshot(${store.seq()})`,
      );
    }
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
