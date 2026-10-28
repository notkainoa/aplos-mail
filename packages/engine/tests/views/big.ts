import type { SqlDatabase } from '../../src/store';
import { rng } from './world';

/*
 * A large mailbox bulk-inserted with SQL shaped like the store's own writes (folder lists derived from placements), for
 * query-plan and cost checks at 100,000 threads; `store.commit`'s own throughput is store-7's benchmark.
 */

export const BIG_NOW = Date.UTC(2026, 9, 28, 17, 0);
const NOW = BIG_NOW;

const ROLES: [string, string, string | null][] = [
  ['acct-1', 'INBOX', 'inbox'],
  ['acct-1', 'SENT', 'sent'],
  ['acct-1', 'TRASH', 'trash'],
  ['acct-1', 'SPAM', 'spam'],
  ['acct-1', 'IMPORTANT', 'important'],
  ['acct-1', 'Label_1', null],
  ['acct-1', 'Label_empty', null],
  ['imap:2', 'INBOX', 'inbox'],
  ['imap:2', 'Sent', 'sent'],
  ['imap:2', 'Trash', 'trash'],
  ['imap:2', 'Archive', 'archive'],
];

/** Writes `n` threads; `withFts` also fills the search index (the slow part). */
export function populate(db: SqlDatabase, n: number, withFts = true) {
  const r = rng(42);
  // A bulk load: no journal and no foreign-key checks; the store reopens the file in WAL mode afterwards.
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF; PRAGMA foreign_keys=OFF; PRAGMA cache_size=-200000; BEGIN');
  for (const [i, id] of ['acct-1', 'imap:2'].entries())
    db.prepare(
      "INSERT INTO accounts(id, provider, address, capabilities, status, created_at, updated_at) VALUES(?, ?, ?, '{}', 'ok', 0, 0)",
    ).run(id, i ? 'imap' : 'google', i ? 'second@mail.example' : 'owner@mail.example');
  const folder = new Map<string, number>();
  for (const [account, remote, role] of ROLES)
    folder.set(
      `${account}/${remote}`,
      db
        .prepare("INSERT INTO folders(account_id, remote_id, name, role, kind) VALUES(?, ?, ?, ?, 'label') RETURNING id")
        .get<{ id: number }>(account, remote, remote, role)!.id,
    );
  const thread = db.prepare(
    `INSERT INTO threads(id, account_id, remote_id, subject, participants, last_date, last_inbound_date, msg_count,
      unread_count, flagged, has_attach, rev) VALUES(?, ?, ?, 'subject', ?, ?, ?, ?, ?, ?, 0, 1)`,
  );
  const message = db.prepare(
    `INSERT INTO messages(id, account_id, thread_id, remote_id, from_addr, from_name, subject, date, internal_date, flags,
      first_seen_seq, rev) VALUES(?, ?, ?, ?, ?, ?, 'subject', ?, ?, ?, 1, 1)`,
  );
  const place = db.prepare('INSERT INTO message_folders(message_id, folder_id) VALUES(?, ?)');
  const list = db.prepare('INSERT INTO thread_folders(folder_id, last_date, thread_id, unread) VALUES(?, ?, ?, ?)');
  const fts = withFts && db.prepare("INSERT INTO messages_fts(rowid, subject, people, body) VALUES(?, 'subject', ?, ?)");
  const wf = db.prepare(
    `INSERT INTO thread_workflow(thread_id, account_id, sync_key, status, later_until, due_date, bookmarked, reply_status,
      hidden_from_home, lane, importance, due_band, last_date) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  );
  let mid = 0;
  for (let t = 1; t <= n; t++) {
    const account = r.chance(0.8) ? 'acct-1' : 'imap:2';
    const gmail = account === 'acct-1';
    const last = NOW - r.int(3 * 365 * 86_400_000);
    const fromMe = r.chance(0.2);
    const unread = r.chance(0.2) ? 1 : 0;
    const folders = [
      ...(r.chance(0.3) ? ['INBOX'] : gmail ? [] : ['Archive']),
      ...(fromMe ? [gmail ? 'SENT' : 'Sent'] : []),
      ...(gmail && r.chance(0.1) ? ['Label_1'] : []),
      ...(gmail && r.chance(0.1) ? ['IMPORTANT'] : []),
      ...(r.chance(0.02) ? [gmail ? 'TRASH' : 'Trash'] : []),
    ];
    const sender = `sender${r.int(2000)}@mail.example`;
    thread.run(t, account, `t${t}`, JSON.stringify([{ address: sender, name: sender }]), last, fromMe ? last - 1000 : last, 1, unread, r.chance(0.03) ? 1 : 0);
    for (let k = 0; k < (r.chance(0.5) ? 2 : 1); k++) {
      mid++;
      message.run(mid, account, t, `m${mid}`, sender, sender, last - k, last - k, (unread ? 0 : 1) | (fromMe && !k ? 16 : 0));
      for (const f of folders) place.run(mid, folder.get(`${account}/${f}`)!);
      if (fts) fts.run(mid, sender, r.chance(0.01) ? 'budget review' : 'other words');
    }
    for (const f of folders) list.run(folder.get(`${account}/${f}`)!, last, t, unread);
    const status = r.pick(['new', 'done', 'done', 'later']);
    const dated = r.chance(0.1);
    wf.run(t, account, `t${t}`, status, status === 'later' && r.chance(0.8) ? NOW + r.int(30 * 86_400_000) - 5 * 86_400_000 : null,
      dated ? '2026-11-03' : null, r.chance(0.02) ? 1 : null, r.pick(['none', 'none', 'none', 'needsReply', 'awaitingReply', null]),
      r.pick(['do', 'update', 'low', 'low']), r.pick(['important', 'normal', 'normal']), dated ? r.int(3) : 3, last);
  }
  db.exec('COMMIT; PRAGMA journal_mode=WAL');
}

