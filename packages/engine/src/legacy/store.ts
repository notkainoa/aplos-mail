import type { AppState, Thread } from '@aplos/contract/legacy/types';
import { transaction, type SqlDatabase } from './sql';
import type { ProviderMemory } from './provider';

const SCHEMA_VERSION = 3;
const META_KEYS = ['settings', 'selectedAccountId', 'sync', 'blockedSenders'] as const;
/** Small collections keep their array order; threads are always read newest first. */
const ORDERED = ['accounts', 'drafts', 'events', 'conversations'] as const;
type Ordered = (typeof ORDERED)[number];

function migrate(db: SqlDatabase) {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (version > SCHEMA_VERSION)
    throw new Error(
      'This mailbox was saved by a newer version of Aplos Mail. Update the app to open it.',
    );
  if (version === SCHEMA_VERSION) return;
  transaction(db, () => {
    if (version < 1)
      db.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS threads_by_account_date ON threads(account_id, date DESC);
      CREATE TABLE IF NOT EXISTS sync_cursors(account_id TEXT PRIMARY KEY, cursor TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS thread_text USING fts5(id UNINDEXED, account_id UNINDEXED, subject, people, body, tokenize='unicode61 remove_diacritics 2');
    `);
    // Version 2: provider changes waiting to be sent, in the order they were made.
    if (version < 2)
      db.exec(
        `CREATE TABLE IF NOT EXISTS ops(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL, data TEXT NOT NULL);`,
      );
    // Version 3: provider-owned indexes such as IMAP message locations and Graph delta links.
    if (version < 3)
      db.exec(
        `CREATE TABLE IF NOT EXISTS provider_memory(account_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(account_id, key));`,
      );
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
  });
}

function searchable(thread: Thread) {
  const people = thread.messages
    .flatMap(m => [m.fromName, m.from, ...m.to, ...(m.cc ?? [])])
    .join(' ');
  const body = [thread.summary, ...thread.messages.map(m => m.text)].join('\n').slice(0, 200_000);
  return { subject: thread.subject, people, body };
}

/** Words become prefix terms joined by AND; quotes and FTS operators in user text are neutralized. */
export function ftsQuery(text: string): string | undefined {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return words?.length ? words.map(word => `"${word}"*`).join(' ') : undefined;
}

/** A change already applied locally that still has to reach the mail host. */
export interface QueuedOp {
  id: string;
  accountId: string;
  threadId: string;
  /** The host's identifier for the thread. */
  remoteId?: string;
  /** Local status before this change, which some hosts need (untrash). */
  fromStatus: Thread['status'];
  /** Labels or folder roles before this change, which folder-based hosts need to find the messages. */
  fromLabels?: string[];
  patch: Partial<Thread>;
  createdAt: string;
  attempts: number;
  nextAt: string;
  error?: string;
}
export interface OpChanges {
  put?: QueuedOp[];
  remove?: string[];
}
export interface MemoryWrite {
  accountId: string;
  key: string;
  value: string | undefined;
}
/** Provider bookkeeping saved in the same transaction as the state it describes. */
export interface SaveExtras {
  memory?: MemoryWrite[];
  cursor?: { accountId: string; cursor: string | undefined; now: Date };
}

/** What a save actually wrote: changed thread IDs, removed thread IDs, and the other collections or fields that differ. */
export interface StoreDiff {
  threads: string[];
  removed: string[];
  changed: Array<Ordered | (typeof META_KEYS)[number]>;
}

export interface MailStore {
  load(): AppState | undefined;
  /** Writes only rows that differ from the last load or save, in one transaction, and reports them. */
  save(state: AppState, ops?: OpChanges, extras?: SaveExtras): StoreDiff;
  /** Queue changes on their own, in one transaction. */
  writeOps(ops: OpChanges): void;
  /** Queued changes, oldest first. */
  ops(): QueuedOp[];
  /** Thread IDs whose subject, people or text contain every word as a prefix, newest first. */
  searchText(text: string, accountId?: string, limit?: number): string[];
  cursor(accountId: string): string | undefined;
  setCursor(accountId: string, cursor: string | undefined, now?: Date): void;
  memory: ProviderMemory;
  close(): void;
}

export function createMailStore(db: SqlDatabase): MailStore {
  migrate(db);
  const written: Record<string, Map<string, string>> = {
    threads: new Map(),
    meta: new Map(),
    ...Object.fromEntries(ORDERED.map(table => [table, new Map()])),
  };
  const upsertThread = db.prepare(
    'INSERT INTO threads(id, account_id, date, status, data) VALUES(?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, date=excluded.date, status=excluded.status, data=excluded.data',
  );
  const deleteText = db.prepare('DELETE FROM thread_text WHERE id=?');
  const insertText = db.prepare(
    'INSERT INTO thread_text(id, account_id, subject, people, body) VALUES(?, ?, ?, ?, ?)',
  );

  function load(): AppState | undefined {
    const meta = new Map(
      db
        .prepare('SELECT key, value FROM meta')
        .all()
        .map(row => [String(row.key), String(row.value)]),
    );
    if (!meta.has('settings')) return;
    for (const [key, value] of meta) written.meta.set(key, value);
    const ordered = (table: Ordered) =>
      db
        .prepare(`SELECT id, pos, data FROM ${table} ORDER BY pos`)
        .all()
        .map(row => {
          written[table].set(String(row.id), `${row.pos}:${row.data}`);
          return JSON.parse(String(row.data));
        });
    const threads = db
      .prepare('SELECT id, data FROM threads ORDER BY date DESC, id')
      .all()
      .map(row => {
        written.threads.set(String(row.id), String(row.data));
        return JSON.parse(String(row.data)) as Thread;
      });
    const value = (key: (typeof META_KEYS)[number]) => JSON.parse(meta.get(key)!);
    return {
      version: 1,
      accounts: ordered('accounts'),
      threads,
      drafts: ordered('drafts'),
      events: ordered('events'),
      conversations: ordered('conversations'),
      settings: value('settings'),
      selectedAccountId: value('selectedAccountId'),
      sync: value('sync'),
      blockedSenders: value('blockedSenders'),
    };
  }

  function applyOps(ops: OpChanges) {
    for (const op of ops.put ?? [])
      db.prepare(
        'INSERT INTO ops(id, account_id, data) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      ).run(op.id, op.accountId, JSON.stringify(op));
    for (const id of ops.remove ?? []) db.prepare('DELETE FROM ops WHERE id=?').run(id);
  }
  function setMemory(accountId: string, key: string, value: string | undefined) {
    if (value === undefined)
      db.prepare('DELETE FROM provider_memory WHERE account_id=? AND key=?').run(accountId, key);
    else
      db.prepare(
        'INSERT INTO provider_memory(account_id, key, value) VALUES(?, ?, ?) ON CONFLICT(account_id, key) DO UPDATE SET value=excluded.value',
      ).run(accountId, key, value);
  }
  function setCursor(accountId: string, cursor: string | undefined, now = new Date()) {
    if (cursor === undefined)
      db.prepare('DELETE FROM sync_cursors WHERE account_id=?').run(accountId);
    else
      db.prepare(
        'INSERT INTO sync_cursors(account_id, cursor, updated_at) VALUES(?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at',
      ).run(accountId, cursor, now.toISOString());
  }
  function save(state: AppState, ops?: OpChanges, extras?: SaveExtras): StoreDiff {
    // The snapshot of what is on disk only advances after the transaction commits.
    const after: Array<() => void> = [];
    const diff: StoreDiff = { threads: [], removed: [], changed: [] },
      changed = new Set<StoreDiff['changed'][number]>();
    transaction(db, () => {
      if (ops) applyOps(ops);
      for (const write of extras?.memory ?? []) setMemory(write.accountId, write.key, write.value);
      if (extras?.cursor)
        setCursor(extras.cursor.accountId, extras.cursor.cursor, extras.cursor.now);
      for (const key of META_KEYS) {
        const json = JSON.stringify(state[key] ?? null);
        if (written.meta.get(key) !== json) {
          db.prepare(
            'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          ).run(key, json);
          after.push(() => written.meta.set(key, json));
          changed.add(key);
        }
      }
      for (const table of ORDERED) {
        const seen = new Set<string>(),
          previous = written[table];
        (state[table] as Array<{ id: string }>).forEach((item, pos) => {
          const data = JSON.stringify(item),
            signature = `${pos}:${data}`;
          seen.add(item.id);
          if (previous.get(item.id) === signature) return;
          db.prepare(
            `INSERT INTO ${table}(id, pos, data) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET pos=excluded.pos, data=excluded.data`,
          ).run(item.id, pos, data);
          after.push(() => previous.set(item.id, signature));
          changed.add(table);
        });
        for (const id of [...previous.keys()])
          if (!seen.has(id)) {
            db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
            after.push(() => previous.delete(id));
            changed.add(table);
          }
      }
      const seen = new Set<string>(),
        previous = written.threads;
      for (const thread of state.threads) {
        const data = JSON.stringify(thread);
        seen.add(thread.id);
        const before = previous.get(thread.id);
        if (before === data) continue;
        upsertThread.run(thread.id, thread.accountId, thread.date, thread.status, data);
        const text = searchable(thread);
        const old = before ? (JSON.parse(before) as Thread) : undefined,
          oldText = old ? searchable(old) : undefined;
        // New rows have no old FTS entry to scan for. Flags and triage do not change indexed text.
        if (
          !oldText ||
          old!.accountId !== thread.accountId ||
          oldText.subject !== text.subject ||
          oldText.people !== text.people ||
          oldText.body !== text.body
        ) {
          if (old) deleteText.run(thread.id);
          insertText.run(thread.id, thread.accountId, text.subject, text.people, text.body);
        }
        after.push(() => previous.set(thread.id, data));
        diff.threads.push(thread.id);
      }
      for (const id of [...previous.keys()])
        if (!seen.has(id)) {
          db.prepare('DELETE FROM threads WHERE id=?').run(id);
          deleteText.run(id);
          after.push(() => previous.delete(id));
          diff.removed.push(id);
        }
    });
    for (const apply of after) apply();
    diff.changed = [...changed];
    return diff;
  }

  function searchText(text: string, accountId?: string, limit = 500): string[] {
    const query = ftsQuery(text);
    if (!query) return [];
    const rows = db
      .prepare(
        `SELECT t.id FROM thread_text f JOIN threads t ON t.id=f.id WHERE thread_text MATCH ?${accountId ? ' AND t.account_id=?' : ''} ORDER BY t.date DESC LIMIT ?`,
      )
      .all(...(accountId ? [query, accountId, limit] : [query, limit]));
    return rows.map(row => String(row.id));
  }

  return {
    load,
    save,
    searchText,
    writeOps: ops => transaction(db, () => applyOps(ops)),
    ops: () =>
      db
        .prepare('SELECT data FROM ops ORDER BY seq')
        .all()
        .map(row => JSON.parse(String(row.data)) as QueuedOp),
    cursor: accountId => {
      const row = db.prepare('SELECT cursor FROM sync_cursors WHERE account_id=?').get(accountId);
      return row ? String(row.cursor) : undefined;
    },
    setCursor,
    memory: {
      get: (accountId, key) => {
        const row = db
          .prepare('SELECT value FROM provider_memory WHERE account_id=? AND key=?')
          .get(accountId, key);
        return row ? String(row.value) : undefined;
      },
      set: setMemory,
      clear: accountId => {
        db.prepare('DELETE FROM provider_memory WHERE account_id=?').run(accountId);
      },
    },
    close: () => db.close(),
  };
}
