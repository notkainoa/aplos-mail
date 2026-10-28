import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../../../../../apps/desktop/src/host/sqlite';
import {
  openStore,
  StoreError,
  type CommitOrigin,
  type FolderRef,
  type StorePort,
  type StoreWrite,
  type SyncStepOrigin,
} from '../../../src/store';
import { ACCOUNT, T0, accountWrite, msg } from '../helpers';

/*
 * Out-of-order rollups (plan 10 E2 (b), store-1). Batches arrive in adversarial orders (a reply before its parent, a
 * delete before the insert, a label move racing a sweep, drafts, trashed replies, merges, search hits) and after every
 * commit the stored thread rollups, `thread_folders` and folder counts must equal a slow reference written here in plain
 * TypeScript over the raw `messages`, `message_folders` and `folders` rows. The reference follows ARCH 3.2 and D8/D9,
 * not the store's SQL:
 * - drafts never count (D9); a thread with only drafts keeps its newest draft's date as `last_date` and counts nothing;
 * - `subject` is the earliest counted message's that has one, `snippet` the newest counted message's;
 * - a message lists its thread in each folder it is placed in, except that a message in Trash or Spam lists it only
 *   there (D8: a trashed reply leaves the conversation in Inbox and adds it to Trash); drafts and `origin='search'`
 *   rows never list it; `unread` there is the number of unseen messages that list it;
 * - a folder's total is the number of threads it lists, its unread count the number with `unread > 0`.
 */

// Schema 0001 bit layout of `messages.flags`.
const SEEN = 1,
  FLAGGED = 2,
  DRAFT = 8,
  FROM_ME = 16,
  ATTACH = 32;
const MINUTE = 60_000;

// ------------------------------------------------------------------ the slow reference

interface RawMessage {
  id: number;
  thread_id: number;
  remote_id: string;
  flags: number;
  internal_date: number;
  subject: string | null;
  snippet: string | null;
  origin: string;
}
interface Raw {
  messages: RawMessage[];
  placements: { message_id: number; folder_id: number }[];
  folders: { id: number; remote_id: string; role: string | null }[];
  threads: Record<string, string | number | null>[];
  lists: { folder_id: number; thread_id: number; last_date: number; unread: number }[];
}

function readRaw(store: StorePort): Raw {
  return store.read(q => ({
    messages: q.all<RawMessage & Record<string, string | number | null>>(
      'SELECT id, thread_id, remote_id, flags, internal_date, subject, snippet, origin FROM messages',
    ),
    placements: q.all<{ message_id: number; folder_id: number }>(
      'SELECT message_id, folder_id FROM message_folders',
    ),
    folders: q.all<{ id: number; remote_id: string; role: string | null }>(
      'SELECT id, remote_id, role FROM folders',
    ),
    threads: q.all(
      `SELECT id, remote_id, msg_count, unread_count, flagged, has_attach, first_date, last_date, last_inbound_date,
        subject, snippet FROM threads`,
    ),
    lists: q.all<{ folder_id: number; thread_id: number; last_date: number; unread: number }>(
      'SELECT folder_id, thread_id, last_date, unread FROM thread_folders',
    ),
  }));
}

const has = (m: RawMessage, bit: number) => (m.flags & bit) !== 0;
/** Oldest first, rowid breaking date ties (rowids are date-ordered, ARCH 3.1). */
const byDate = (a: RawMessage, b: RawMessage) => a.internal_date - b.internal_date || a.id - b.id;

function maxDate(ms: RawMessage[]): number | null {
  return ms.length ? Math.max(...ms.map(m => m.internal_date)) : null;
}

/** ARCH 3.2 thread rollups over one thread's messages. */
function referenceThread(all: RawMessage[]) {
  const counted = all.filter(m => !has(m, DRAFT)).sort(byDate);
  return {
    msg_count: counted.length,
    unread_count: counted.filter(m => !has(m, SEEN)).length,
    flagged: Number(counted.some(m => has(m, FLAGGED))),
    has_attach: Number(counted.some(m => has(m, ATTACH))),
    first_date: counted.length ? counted[0].internal_date : null,
    last_date: maxDate(counted) ?? maxDate(all),
    last_inbound_date: maxDate(counted.filter(m => !has(m, FROM_ME))),
    subject: counted.find(m => m.subject !== null)?.subject ?? null,
    snippet: counted.length ? counted[counted.length - 1].snippet : null,
  };
}

/** D8: folder id → unseen listing messages, for the folders this thread is listed in. */
function referenceLists(
  all: RawMessage[],
  folderIdsOf: Map<number, number[]>,
  isBin: (folderId: number) => boolean,
): Map<number, number> {
  const lists = new Map<number, number>();
  for (const m of all) {
    if (has(m, DRAFT) || m.origin === 'search') continue;
    const placed = folderIdsOf.get(m.id) ?? [];
    const binned = placed.some(isBin);
    for (const f of placed) {
      if (binned && !isBin(f)) continue;
      lists.set(f, (lists.get(f) ?? 0) + (has(m, SEEN) ? 0 : 1));
    }
  }
  return lists;
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const list = out.get(key(item));
    if (list) list.push(item);
    else out.set(key(item), [item]);
  }
  return out;
}

interface View {
  threads: Record<string, unknown>;
  lists: Record<string, Record<string, unknown>>;
  folders: Record<string, { total: number; unread: number }>;
}

function folderTotals(lists: View['lists'], folderNames: string[]): View['folders'] {
  const out: View['folders'] = {};
  for (const name of folderNames) out[name] = { total: 0, unread: 0 };
  for (const byFolder of Object.values(lists))
    for (const [name, row] of Object.entries(byFolder)) {
      out[name].total++;
      if ((row as { unread: number }).unread > 0) out[name].unread++;
    }
  return out;
}

/** What the reference says the derived tables should hold, by remote ids. */
function expectedView(raw: Raw): View {
  const folderName = new Map(raw.folders.map(f => [f.id, f.remote_id]));
  const bins = new Set(
    raw.folders.filter(f => f.role === 'trash' || f.role === 'spam').map(f => f.id),
  );
  const folderIdsOf = new Map<number, number[]>();
  for (const [id, ps] of groupBy(raw.placements, p => p.message_id))
    folderIdsOf.set(
      id,
      ps.map(p => p.folder_id),
    );
  const threadName = new Map(raw.threads.map(t => [Number(t.id), String(t.remote_id)]));
  const view: View = { threads: {}, lists: {}, folders: {} };
  for (const [threadId, ms] of groupBy(raw.messages, m => m.thread_id)) {
    const name = threadName.get(threadId) ?? `missing-thread-row-${threadId}`;
    const rollup = referenceThread(ms);
    view.threads[name] = rollup;
    const lists = referenceLists(ms, folderIdsOf, f => bins.has(f));
    if (lists.size)
      view.lists[name] = Object.fromEntries(
        [...lists].map(([f, unread]) => [
          folderName.get(f)!,
          { last_date: rollup.last_date, unread },
        ]),
      );
  }
  view.folders = folderTotals(
    view.lists,
    raw.folders.map(f => f.remote_id),
  );
  return view;
}

/** What the store actually holds in `threads` and `thread_folders`. */
function storedView(raw: Raw): View {
  const folderName = new Map(raw.folders.map(f => [f.id, f.remote_id]));
  const threadName = new Map(raw.threads.map(t => [Number(t.id), String(t.remote_id)]));
  const view: View = { threads: {}, lists: {}, folders: {} };
  for (const { id: _id, remote_id, ...rollup } of raw.threads)
    view.threads[String(remote_id)] = rollup;
  for (const row of raw.lists) {
    const name = threadName.get(row.thread_id) ?? `orphan-${row.thread_id}`;
    view.lists[name] ??= {};
    view.lists[name][folderName.get(row.folder_id) ?? `orphan-${row.folder_id}`] = {
      last_date: row.last_date,
      unread: row.unread,
    };
  }
  view.folders = folderTotals(
    view.lists,
    raw.folders.map(f => f.remote_id),
  );
  return view;
}

function assertMatchesReference(store: StorePort, where: string) {
  const raw = readRaw(store);
  assert.deepEqual(storedView(raw), expectedView(raw), `${where}: stored rollups != reference`);
}

// ------------------------------------------------------------------ the generator

/** mulberry32, as in replay.test.ts. */
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
  const shuffle = <T>(xs: readonly T[]) => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return {
    next,
    int,
    shuffle,
    pick: <T>(xs: readonly T[]) => xs[int(xs.length)],
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof rng>;

const THREADS = ['t0', 't1', 't2', 't3'];
const ROLES = ['p', 'r1', 'r2', 'd'] as const; // parent, two replies, a draft
const SYNCED = THREADS.flatMap(t => ROLES.map(r => `${t}-${r}`));
const SEARCH_ONLY = ['s0', 's1', 's2'];
const PLACES = ['INBOX', 'TRASH', 'SPAM', 'Label_1', 'Label_2', 'DRAFT'];
const NOT_BIN = ['INBOX', 'Label_1', 'Label_2'];

const setupWrites: StoreWrite[] = [
  accountWrite,
  ...[
    ['INBOX', 'inbox', 'system'],
    ['TRASH', 'trash', 'system'],
    ['SPAM', 'spam', 'system'],
    ['Label_1', null, 'label'],
    ['Label_2', null, 'label'],
  ].map(
    ([remoteId, role, folderKind]) =>
      ({
        kind: 'folder',
        accountId: ACCOUNT,
        remoteId,
        name: remoteId,
        role,
        folderKind,
      }) as StoreWrite,
  ),
];

interface Batch {
  origin: CommitOrigin;
  step?: SyncStepOrigin;
  writes: StoreWrite[];
}

const isDraftId = (remoteId: string) => remoteId.endsWith('-d');

function randomFolders(r: Rng, remoteId: string): FolderRef[] {
  if (isDraftId(remoteId)) return [{ folder: 'DRAFT' }];
  const roll = r.int(10);
  // A trashed reply: in Trash only, or still carrying Inbox as well (Gmail keeps the label until it is removed).
  if (roll === 0) return [{ folder: 'TRASH' }];
  if (roll === 1) return [{ folder: 'INBOX' }, { folder: 'TRASH' }];
  if (roll === 2) return [{ folder: 'SPAM' }];
  return NOT_BIN.filter(() => r.chance(0.45)).map(folder => ({ folder }));
}

/** A full message write; replies date after parents, but the batches carrying them arrive in any order. */
function messageWrite(r: Rng, remoteId: string, seenGen?: number): StoreWrite {
  const [thread, role] = remoteId.includes('-') ? remoteId.split('-') : [r.pick(THREADS), 's'];
  const minutes =
    100 * THREADS.indexOf(thread) + 10 * Math.max(0, ROLES.indexOf(role as never)) + r.int(12);
  return msg(remoteId, thread, minutes, {
    flags: {
      seen: r.chance(0.5),
      flagged: r.chance(0.2),
      draft: isDraftId(remoteId) || r.chance(0.05),
      fromMe: role === 'r1' ? r.chance(0.6) : r.chance(0.1),
    },
    subject: r.chance(0.2) ? undefined : `Subject ${thread} ${role}`,
    snippet: `Snippet ${remoteId} ${r.int(3)}`,
    inReplyTo: role === 'p' ? undefined : `<${thread}-p@mail.example>`,
    hasAttachments: r.chance(0.2),
    folders: randomFolders(r, remoteId),
    seenGen,
  });
}

const sync = (...writes: StoreWrite[]): Batch => ({ origin: 'sync', writes });

/** One adversarial event: 0..11. */
function randomEvent(r: Rng, gen: number): Batch {
  const id = r.pick(SYNCED);
  switch (r.int(12)) {
    case 0:
    case 1:
    case 2:
      // A page of messages in a random order: replies before parents half the time.
      return sync(
        ...r
          .shuffle(SYNCED)
          .slice(0, 1 + r.int(4))
          .map(m => messageWrite(r, m, gen)),
      );
    case 3:
      // Delete, possibly before the insert has ever arrived.
      return sync({ kind: 'messageDelete', accountId: ACCOUNT, remoteId: id });
    case 4:
      // Trash a reply by delta: Inbox off, Trash on.
      return sync({
        kind: 'placements',
        accountId: ACCOUNT,
        target: { remoteId: `${r.pick(THREADS)}-${r.pick(['r1', 'r2'])}` },
        add: [{ folder: r.chance(0.8) ? 'TRASH' : 'SPAM' }],
        remove: r.chance(0.7) ? ['INBOX'] : [],
      });
    case 5:
      // A label move, sometimes stamped by the page that saw it.
      return sync({
        kind: 'placements',
        accountId: ACCOUNT,
        target: r.chance(0.7) ? { remoteId: id } : { remoteThreadId: r.pick(THREADS) },
        add: [{ folder: r.pick(PLACES) }],
        remove: PLACES.filter(() => r.chance(0.25)),
        seenGen: r.chance(0.5) ? gen : undefined,
      });
    case 6:
      // The sweep that races it: placements an older round stamped and this one did not see.
      return sync({
        kind: 'sweep',
        accountId: ACCOUNT,
        folder: r.pick(PLACES),
        generation: gen - r.int(2),
      });
    case 7:
      return sync({
        kind: 'flags',
        accountId: ACCOUNT,
        target: r.chance(0.6) ? { remoteId: id } : { remoteThreadId: r.pick(THREADS) },
        seen: r.chance(0.5) ? r.chance(0.5) : undefined,
        flagged: r.chance(0.5) ? r.chance(0.5) : undefined,
      });
    case 8:
      return sync({
        kind: 'threadMerge',
        accountId: ACCOUNT,
        from: r.shuffle(THREADS).slice(0, 1 + r.int(2)),
        into: r.pick(THREADS),
      });
    case 9:
      // A search hit: a new row, or the same facts about a message sync already has (which keeps origin 'sync').
      return {
        origin: 'sync',
        step: 'search',
        writes: [messageWrite(r, r.chance(0.5) ? r.pick(SEARCH_ONLY) : id)],
      };
    case 10:
      // Label_2 turns into a Trash-like folder and back: every thread placed there is relisted.
      return sync({
        kind: 'folder',
        accountId: ACCOUNT,
        remoteId: 'Label_2',
        name: 'Label_2',
        role: r.pick([null, 'spam', 'trash'] as const),
        folderKind: 'label',
      });
    default:
      // The owner's own edit: may fail with notFound when the message is not here yet.
      return {
        origin: 'local',
        writes: [
          {
            kind: 'flags',
            accountId: ACCOUNT,
            target: { remoteThreadId: r.pick(THREADS) },
            seen: r.chance(0.5),
          },
        ],
      };
  }
}

function apply(store: StorePort, batch: Batch, opId: string) {
  try {
    store.commit({ opId, origin: batch.origin, step: batch.step, writes: batch.writes });
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
  }
}

function freshStore() {
  const store = openStore(openSqlite(':memory:'), { now: () => T0 });
  store.commit({ opId: 'setup', origin: 'sync', writes: setupWrites });
  return store;
}

function runAdversarial(seed: number, events: number) {
  const r = rng(seed);
  const store = freshStore();
  try {
    for (let i = 0; i < events; i++) {
      apply(store, randomEvent(r, 2 + Math.floor(i / 3)), `e${i}`);
      assertMatchesReference(store, `seed ${seed}, after event ${i}`);
    }
  } finally {
    store.close();
  }
}

// ------------------------------------------------------------------ commuting batches

/**
 * Batches that commute: every message is written by exactly one sync batch with its full final state, at a distinct
 * date (so no rowid tie-break depends on arrival order). Some are also seen by an identical search hit, which may land
 * before or after the sync (a sync adopts a search row; a search hit never downgrades a synced one); search-only rows
 * never list. Whatever the order, the final state is the same.
 */
function commutingBatches(r: Rng): Batch[] {
  const ids = [...SYNCED, ...SEARCH_ONLY];
  const minutes = r.shuffle(ids.map((_, i) => i * 7));
  const writes = new Map(
    ids.map((id, i) => {
      const w = messageWrite(r, id) as ReturnType<typeof msg>;
      return [id, { ...w, internalDate: T0 + minutes[i] * MINUTE, date: T0 + minutes[i] * MINUTE }];
    }),
  );
  const batches: Batch[] = [];
  const syncIds = r.shuffle(SYNCED);
  while (syncIds.length)
    batches.push(sync(...syncIds.splice(0, 1 + r.int(4)).map(id => writes.get(id)!)));
  const searched = [...SEARCH_ONLY, ...SYNCED.filter(() => r.chance(0.2))];
  for (const id of searched)
    batches.push({ origin: 'sync', step: 'search', writes: [writes.get(id)!] });
  return batches;
}

/** The final state by remote ids: messages, thread rollups, lists and folder counts. */
function finalState(store: StorePort) {
  const raw = readRaw(store);
  const placed = groupBy(raw.placements, p => p.message_id);
  const folderName = new Map(raw.folders.map(f => [f.id, f.remote_id]));
  const threadName = new Map(raw.threads.map(t => [Number(t.id), String(t.remote_id)]));
  const messages = Object.fromEntries(
    raw.messages.map(m => [
      m.remote_id,
      {
        thread: threadName.get(m.thread_id),
        flags: m.flags,
        origin: m.origin,
        labels: (placed.get(m.id) ?? []).map(p => folderName.get(p.folder_id)).sort(),
      },
    ]),
  );
  return { messages, ...storedView(raw) };
}

function runCommuting(seed: number, orders: number) {
  const r = rng(seed);
  const batches = commutingBatches(r);
  let first: ReturnType<typeof finalState> | undefined;
  for (let o = 0; o < orders; o++) {
    const store = freshStore();
    try {
      r.shuffle(batches).forEach((b, i) => {
        apply(store, b, `b${i}`);
        assertMatchesReference(store, `seed ${seed}, order ${o}, batch ${i}`);
      });
      const state = finalState(store);
      if (first) assert.deepEqual(state, first, `seed ${seed}: order ${o} ended elsewhere`);
      else first = state;
    } finally {
      store.close();
    }
  }
}

// ------------------------------------------------------------------ the tests

const RUNS = Number(process.env.APLOS_ROLLUP_RUNS ?? 60);
const SEED = Number(process.env.APLOS_ROLLUP_SEED ?? 1);

function eachSeed(fn: (seed: number) => void) {
  for (let i = 0; i < RUNS; i++) {
    const seed = SEED + i;
    try {
      fn(seed);
    } catch (error) {
      throw new Error(`rollups failed for APLOS_ROLLUP_SEED=${seed}`, { cause: error });
    }
  }
}

// 60 seeds by default; APLOS_ROLLUP_RUNS for more, APLOS_ROLLUP_SEED to rerun one.
test('rollups match the slow reference after every commit of adversarially ordered batches', () => {
  eachSeed(seed => runAdversarial(seed, 40));
});

test('commuting batches reach the same rollups in any order', () => {
  eachSeed(seed => runCommuting(seed, 3));
});

test('D8: a trashed reply leaves the conversation in Inbox and adds it to Trash', () => {
  const store = freshStore();
  try {
    // The reply arrives before its parent, already trashed.
    apply(
      store,
      sync(msg('x-r1', 'x', 5, { folders: [{ folder: 'INBOX' }, { folder: 'TRASH' }] })),
      'reply',
    );
    apply(
      store,
      sync(
        msg('x-p', 'x', 0, { flags: { seen: true, flagged: false, draft: false, fromMe: false } }),
      ),
      'parent',
    );
    apply(
      store,
      sync(
        msg('x-d', 'x', 9, {
          flags: { seen: false, flagged: false, draft: true, fromMe: true },
          folders: [{ folder: 'DRAFT' }],
        }),
      ),
      'draft',
    );
    assertMatchesReference(store, 'D8');
    const view = storedView(readRaw(store));
    assert.deepEqual(view.lists.x, {
      INBOX: { last_date: T0 + 5 * MINUTE, unread: 0 },
      TRASH: { last_date: T0 + 5 * MINUTE, unread: 1 },
    });
    assert.deepEqual(view.folders.INBOX, { total: 1, unread: 0 });
    assert.deepEqual(view.folders.TRASH, { total: 1, unread: 1 });
    assert.equal((view.threads.x as { msg_count: number }).msg_count, 2);
  } finally {
    store.close();
  }
});
