import type { SqlDatabase } from '../../src/store';
import { openStore, type MessageWrite, type StorePort, type StoreWrite } from '../../src/store';
import { laneExtensions } from '../../src/index';
import { tempDb } from '../store/helpers';

/*
 * A seeded random mailbox for the view tests, written through `store.commit` so `thread_folders`, rollups and
 * workflow rows are the store's own. Drafts, submissions and FTS rows belong to other lanes' writers (eng-time,
 * store-4) that are not built yet, so the harness inserts them with plain SQL.
 */

export const OWNER = 'owner@mail.example';
export const SECOND = 'second@mail.example';
/** The second account's id holds a colon, so contract ids cannot be split at the first one. */
export const ACCOUNTS = ['acct-1', 'imap:2'] as const;

const FOLDERS: Record<string, [remoteId: string, role: string | null, kind: string][]> = {
  'acct-1': [
    ['INBOX', 'inbox', 'system'],
    ['SENT', 'sent', 'system'],
    ['TRASH', 'trash', 'system'],
    ['SPAM', 'spam', 'system'],
    ['IMPORTANT', 'important', 'system'],
    ['CATEGORY_PROMOTIONS', 'category.promotions', 'system'],
    ['Label_1', null, 'label'],
    ['Label_2', null, 'label'],
    ['Label_empty', null, 'label'],
  ],
  'imap:2': [
    ['INBOX', 'inbox', 'folder'],
    ['Sent', 'sent', 'folder'],
    ['Trash', 'trash', 'folder'],
    ['Junk', 'spam', 'folder'],
    ['Archive', 'archive', 'folder'],
    ['Projects', null, 'folder'],
  ],
};

export const WORDS = [
  'budget',
  'invoice',
  'garden',
  'harbor',
  'ticket',
  'lunch',
  'review',
  'maple',
];
const SENDERS = ['ada', 'ben', 'cleo', 'dev', 'eve', 'finn', 'gus', 'hana'];

/** Mulberry32: small, seeded, good enough for test data. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    chance: (p: number) => next() < p,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(list: readonly T[]) => list[Math.floor(next() * list.length)],
  };
}
type Rng = ReturnType<typeof rng>;

export interface World {
  store: StorePort;
  db: SqlDatabase;
  now: number;
  cleanup(): void;
}

function folderWrites(): StoreWrite[] {
  const out: StoreWrite[] = [];
  for (const [i, id] of ACCOUNTS.entries()) {
    out.push({
      kind: 'account',
      id,
      provider: i ? 'imap' : 'google',
      address: i ? SECOND : OWNER,
      capabilities: { labels: !i },
      status: { state: 'ok' },
    });
    for (const [remoteId, role, kind] of FOLDERS[id])
      out.push({
        kind: 'folder',
        accountId: id,
        remoteId,
        name: remoteId,
        role: role as never,
        folderKind: kind as never,
      });
  }
  return out;
}

function placements(r: Rng, account: string, fromMe: boolean): { folder: string }[] {
  const gmail = account === 'acct-1';
  const out: string[] = [];
  const inbox = r.chance(0.5);
  if (inbox) out.push('INBOX');
  if (fromMe) out.push(gmail ? 'SENT' : 'Sent');
  if (r.chance(0.2)) out.push(gmail ? r.pick(['Label_1', 'Label_2']) : 'Projects');
  if (gmail && r.chance(0.15)) out.push('IMPORTANT');
  if (gmail && r.chance(0.2)) out.push('CATEGORY_PROMOTIONS');
  if (!gmail && !inbox && r.chance(0.5)) out.push('Archive');
  if (r.chance(0.08)) out.push(gmail ? 'TRASH' : 'Trash');
  else if (r.chance(0.04)) out.push(gmail ? 'SPAM' : 'Junk');
  return out.map(folder => ({ folder }));
}

function message(r: Rng, account: string, thread: string, i: number, now: number): MessageWrite {
  const fromMe = r.chance(0.3);
  const me = account === 'acct-1' ? OWNER : SECOND;
  const sender = r.pick(SENDERS);
  const when = now - r.int(20 * 86_400_000);
  return {
    kind: 'message',
    accountId: account,
    remoteId: `m${i}`,
    remoteThreadId: thread,
    from: fromMe
      ? { address: me, name: 'Owner' }
      : { address: `${sender}@mail.example`, name: sender },
    to: [{ address: fromMe ? `${sender}@mail.example` : me }],
    cc: [],
    subject: `${r.pick(WORDS)} ${r.pick(WORDS)}`,
    snippet: `${r.pick(WORDS)} notes`,
    date: when,
    internalDate: when,
    flags: { seen: r.chance(0.6), flagged: r.chance(0.1), draft: r.chance(0.05), fromMe },
    folders: placements(r, account, fromMe),
    origin: r.chance(0.05) ? 'search' : undefined,
  };
}

/** Instants around the owner's midnights and a DST change, where Later groups are easiest to get wrong. */
function laterUntil(r: Rng, now: number): number | null {
  if (r.chance(0.2)) return null;
  const day = 86_400_000;
  const near = [
    -day,
    -1,
    1,
    3_600_000,
    2 * 3_600_000,
    day - 1,
    day,
    day + 3_600_000,
    6 * day,
    7 * day,
  ];
  return now + r.pick(near) + (r.chance(0.5) ? 0 : r.int(9 * day)) - r.int(3) * 60_000;
}

function workflow(r: Rng, account: string, thread: string, now: number): StoreWrite {
  const status = r.pick(['new', 'new', 'new', 'done', 'done', 'later'] as const);
  const dated = r.chance(0.4);
  return {
    kind: 'workflow',
    accountId: account,
    remoteThreadId: thread,
    patch: {
      status,
      lane: r.pick(['do', 'update', 'low'] as const),
      importance: r.pick(['important', 'normal'] as const),
      dueBand: r.int(4) as 0 | 1 | 2 | 3,
      dueDate: dated ? `2026-11-0${1 + r.int(9)}` : null,
      laterUntil: status === 'later' ? laterUntil(r, now) : null,
      hiddenFromHome: r.chance(0.1) ? true : r.chance(0.5) ? false : null,
      bookmarked: r.chance(0.15) ? true : null,
      replyStatus: r.pick(['none', 'needsReply', 'awaitingReply', 'awaitingReply', null]),
    },
  };
}

/**
 * Rows other lanes write later (eng-time's drafts and submissions), inserted directly, and the FTS rows replaced with
 * fixed body words the reference search reads. The indexer loads with the engine (after this fixture commits), so the
 * indexed bit is set here too: the start-up backlog pass leaves the controlled rows alone.
 */
function laneRows(db: SqlDatabase, r: Rng, now: number) {
  const draft = db.prepare(
    'INSERT INTO drafts(id, account_id, revision, data, updated_at) VALUES(?, ?, 1, ?, ?)',
  );
  const sub = db.prepare(
    'INSERT INTO submissions(id, draft_id, account_id, internet_id, not_before, state) VALUES(?, ?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < 12; i++) {
    const account = r.pick(ACCOUNTS);
    draft.run(`draft-${i}`, account, '{}', now - r.int(10) * 60_000);
    if (r.chance(0.5))
      sub.run(
        `sub-${i}`,
        `draft-${i}`,
        account,
        `<${i}@mail.example>`,
        now + r.int(5) * 60_000,
        r.pick(['queued', 'scheduled', 'sending', 'sent', 'cancelled', 'failed']),
      );
  }
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('delete-all')");
  const fts = db.prepare(
    'INSERT INTO messages_fts(rowid, subject, people, body) VALUES(?, ?, ?, ?)',
  );
  const rows = db
    .prepare('SELECT id, subject, from_addr, from_name, to_json FROM messages')
    .all<{ id: number; subject: string; from_addr: string; from_name: string; to_json: string }>();
  for (const m of rows)
    fts.run(m.id, m.subject, `${m.from_name} ${m.from_addr} ${m.to_json}`, bodyOf(m.id));
  db.exec('UPDATE messages SET parts = parts | 8');
}

/** A message's indexed body text (the reference search reads the same words). */
export const bodyOf = (id: number) =>
  `${WORDS[id % WORDS.length]} body ${WORDS[(id >> 3) % WORDS.length]}`;

export function makeWorld(seed: number, now: number, threads = 120): World {
  const file = tempDb();
  const db = file.open();
  const store = openStore(db, { now: () => now, extensions: laneExtensions() });
  const r = rng(seed);
  store.commit({ opId: 'setup', origin: 'sync', writes: folderWrites() });
  let m = 0;
  for (let t = 0; t < threads; t++) {
    const account = r.pick(ACCOUNTS);
    const thread = `t${t}`;
    const writes: StoreWrite[] = [];
    const n = 1 + r.int(4);
    for (let k = 0; k < n; k++) writes.push(message(r, account, thread, m++, now));
    store.commit({ opId: `t${t}`, origin: 'sync', writes });
    // A thread made only of drafts is deleted by its rollup; skip its workflow then.
    if (
      store.read(q =>
        q.get('SELECT 1 FROM threads WHERE account_id = ? AND remote_id = ?', account, thread),
      )
    )
      store.commit({ opId: `w${t}`, origin: 'local', writes: [workflow(r, account, thread, now)] });
  }
  laneRows(db, r, now);
  return { store, db, now, cleanup: () => (store.close(), file.cleanup()) };
}
