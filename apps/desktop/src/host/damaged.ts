import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { SqlDatabase } from '@aplos/engine/store/sql';

/*
 * The damaged-database path (plan 10 Decision 6, WP8.3). A `mail.db` that SQLite reports as corrupt, or that fails
 * `quick_check` after an unclean exit, is never rebuilt on its own: the engine parks, the file is copied aside into
 * `damaged/`, and the owner chooses Export report, Restore a pre-migration backup, or Rebuild from the provider, after
 * seeing what exists only on this Mac (drafts, scheduled sends, Done/Later and reminders, changes not yet sent).
 * Pre-migration backups are `mail.db.pre-<schema>`, written by `writeBackup` before a migration runs.
 */

export const DB_FILE = 'mail.db';
/** Present while an engine has the database open; left behind by a crash, so the next start checks the file. */
export const OPEN_MARK = 'mail.db.open';
export const DAMAGED_DIR = 'damaged';
/** The pre-migration backups kept, newest first. */
export const KEEP_BACKUPS = 2;
const BACKUP = /^mail\.db\.pre-(\d{1,4})$/;
const SIDECARS = ['-wal', '-shm'] as const;

/** The reason the utility gives main when it parks on a damaged database. */
export const DAMAGED_REASON = 'store.corrupt';

/** SQLITE_CORRUPT (11) and SQLITE_NOTADB (26), as `node:sqlite` reports them. */
export function isCorruptError(error: unknown): boolean {
  const e = error as { errcode?: unknown; message?: unknown } | undefined;
  const code = typeof e?.errcode === 'number' ? e.errcode & 0xff : undefined;
  if (code === 11 || code === 26) return true;
  const message = typeof e?.message === 'string' ? e.message : '';
  return /database disk image is malformed|file is not a database/i.test(message);
}

/** Whether SQLite can read the file: `quick_check` over every page. A missing file is fine (a fresh start). */
export function checkDatabase(path: string): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(path)) return { ok: true };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    const rows = db.prepare('PRAGMA quick_check').all() as { quick_check?: unknown }[];
    if (rows.length === 1 && rows[0]?.quick_check === 'ok') return { ok: true };
    return { ok: false, reason: 'quick_check' };
  } catch (error) {
    if (isCorruptError(error)) return { ok: false, reason: 'corrupt' };
    throw error;
  } finally {
    db?.close();
  }
}

/** At start: the file is checked only when the last engine did not close it (a crash, a power cut, a kill). */
export function needsCheck(dataDir: string): boolean {
  return existsSync(join(dataDir, OPEN_MARK));
}

/** Best effort: a folder that cannot be written fails the store's own open, with its own error. */
export function markOpen(dataDir: string): void {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, OPEN_MARK), '', { mode: 0o600 });
  } catch {
    // Without the mark the next start skips the check; a corrupt read at open still parks.
  }
}

export function markClosed(dataDir: string): void {
  try {
    rmSync(join(dataDir, OPEN_MARK), { force: true });
  } catch {
    // A mark left behind only costs one quick_check at the next start.
  }
}

/**
 * Copies the damaged file (and its write-ahead log) into `damaged/`, once per damaged file: a second start on the same
 * file reuses the first copy. Returns the copy's name inside `damaged/`.
 */
export function setAside(dataDir: string, now: number): string {
  const source = join(dataDir, DB_FILE);
  const dir = join(dataDir, DAMAGED_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = statSync(source);
  const stamp = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  const last = readLast(dir);
  if (last && last.stamp === stamp && existsSync(join(dir, last.name))) return last.name;
  const name = `mail-${new Date(now).toISOString().replace(/[:.]/g, '-')}.db`;
  copyFileSync(source, join(dir, name));
  for (const side of SIDECARS)
    if (existsSync(source + side)) copyFileSync(source + side, join(dir, name + side));
  writeFileSync(join(dir, 'last.json'), JSON.stringify({ name, stamp }), { mode: 0o600 });
  return name;
}

/** The copy `setAside` made last, for main's damaged-database screen. */
export function lastCopy(dataDir: string): string | null {
  const last = readLast(join(dataDir, DAMAGED_DIR));
  return last && existsSync(join(dataDir, DAMAGED_DIR, last.name)) ? last.name : null;
}

function readLast(dir: string): { name: string; stamp: string } | undefined {
  try {
    const value = JSON.parse(readFileSync(join(dir, 'last.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    return typeof value.name === 'string' && typeof value.stamp === 'string'
      ? { name: value.name, stamp: value.stamp }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Counts of what exists only on this Mac; `null` when the damaged file would not say. */
export interface LocalOnly {
  /** Drafts whose newest version is not on the provider. */
  drafts: number | null;
  /** Sends waiting on this Mac: the undo window and Send later. */
  scheduled: number | null;
  /** Done, Later, reminders and to-dos set in Aplos. */
  workflow: number | null;
  /** Changes made here (archive, read, labels) not yet sent to the provider. */
  changes: number | null;
}

export interface Backup {
  name: string;
  /** The schema version it was taken from. */
  schema: number;
  at: number;
}

export interface DamagedFacts {
  /** The copy's name inside the data folder's `damaged/` folder. */
  copy: string | null;
  localOnly: LocalOnly;
  /** Newest first. */
  backups: Backup[];
}

const COUNTS: Record<keyof LocalOnly, string> = {
  drafts:
    'SELECT count(*) AS n FROM drafts WHERE synced_revision IS NULL OR synced_revision < revision',
  scheduled: "SELECT count(*) AS n FROM submissions WHERE state IN ('queued', 'scheduled')",
  workflow: `SELECT count(*) AS n FROM thread_workflow WHERE status <> 'new' OR later_until IS NOT NULL
    OR reminder_at IS NOT NULL OR todo IS NOT NULL OR bookmarked = 1`,
  changes: "SELECT count(*) AS n FROM ops WHERE state IN ('queued', 'inflight')",
};

/** Opens the damaged copy (never the live file), or undefined when SQLite cannot open it at all. */
function openCopy(dataDir: string, copy: string | null): DatabaseSync | undefined {
  if (!copy) return undefined;
  try {
    return new DatabaseSync(join(dataDir, DAMAGED_DIR, copy));
  } catch {
    return undefined;
  }
}

/** What the damaged-database screen lists: what only this Mac has, read from the copy, and the backups. */
export function inspectDamaged(dataDir: string, copy: string | null): DamagedFacts {
  const db = openCopy(dataDir, copy);
  const localOnly = {} as LocalOnly;
  try {
    for (const key of Object.keys(COUNTS) as (keyof LocalOnly)[]) {
      try {
        const row = db?.prepare(COUNTS[key]).get() as { n?: unknown } | undefined;
        localOnly[key] = typeof row?.n === 'number' ? row.n : null;
      } catch {
        localOnly[key] = null;
      }
    }
  } finally {
    db?.close();
  }
  return { copy, localOnly, backups: listBackups(dataDir) };
}

export function listBackups(dataDir: string): Backup[] {
  let names: string[] = [];
  try {
    names = readdirSync(dataDir);
  } catch {
    return [];
  }
  return names
    .flatMap(name => {
      const match = BACKUP.exec(name);
      if (!match) return [];
      try {
        return [
          { name, schema: Number(match[1]), at: Math.trunc(statSync(join(dataDir, name)).mtimeMs) },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.schema - a.schema || b.at - a.at);
}

/**
 * Before a migration (`openStore`'s `beforeUpgrade`): a consistent copy of the database as it is, `mail.db.pre-<from>`,
 * written with `VACUUM INTO` so the write-ahead log is folded in. Older backups past `KEEP_BACKUPS` are removed.
 */
export function writeBackup(db: SqlDatabase, dataDir: string, from: number): void {
  const name = `mail.db.pre-${Math.trunc(from)}`;
  const path = join(dataDir, name);
  rmSync(path, { force: true });
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  for (const old of listBackups(dataDir)
    .filter(b => b.name !== name)
    .slice(KEEP_BACKUPS - 1))
    rmSync(join(dataDir, old.name), { force: true });
}

/** Puts a backup in place of the damaged file. The damaged copy is already aside; a backup that is itself damaged is refused. */
export function restoreBackup(dataDir: string, name: string): void {
  if (!BACKUP.test(name) || !listBackups(dataDir).some(b => b.name === name))
    throw new Error('That backup is not on this Mac any more.');
  const source = join(dataDir, name);
  if (!checkDatabase(source).ok) throw new Error('That backup is damaged too.');
  const target = join(dataDir, DB_FILE);
  const temp = `${target}.restoring`;
  copyFileSync(source, temp);
  for (const side of SIDECARS) rmSync(target + side, { force: true });
  renameSync(temp, target);
  markClosed(dataDir);
}

/** Starts over: the damaged file goes (its copy stays in `damaged/`), and the next start syncs from the provider. */
export function rebuildDatabase(dataDir: string): void {
  const target = join(dataDir, DB_FILE);
  for (const path of [target, ...SIDECARS.map(side => target + side)])
    rmSync(path, { force: true });
  markClosed(dataDir);
}

// ---------------------------------------------------------------------------------------------- the report

type Row = Record<string, unknown>;

function people(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map(p => {
      const { address, name } = (p ?? {}) as { address?: unknown; name?: unknown };
      if (typeof address !== 'string') return '';
      return typeof name === 'string' && name ? `${name} <${address}>` : address;
    })
    .filter(Boolean)
    .join(', ');
}

/** The HTML of a draft as plain text, enough to copy it back by hand. */
function plain(html: unknown): string {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fields(data: unknown): Row {
  try {
    const value: unknown = JSON.parse(String(data));
    return value && typeof value === 'object' ? (value as Row) : {};
  } catch {
    return {};
  }
}

function rows(db: DatabaseSync | undefined, sql: string): Row[] | undefined {
  try {
    return db?.prepare(sql).all() as Row[] | undefined;
  } catch {
    return undefined;
  }
}

const when = (ms: unknown) => (typeof ms === 'number' ? new Date(ms).toLocaleString() : '');
const count = (n: number | null) => (n === null ? 'could not be read' : String(n));

/**
 * The report Export saves where the owner chooses: what exists only on this Mac, with the drafts' and scheduled sends'
 * own words so they can be written again. It holds mail content, so it is only ever written to the owner's chosen file.
 */
export function damagedReport(dataDir: string, copy: string | null, now: number): string {
  const facts = inspectDamaged(dataDir, copy);
  const db = openCopy(dataDir, copy);
  try {
    return [
      'Aplos Mail: damaged mail database',
      `Made ${new Date(now).toLocaleString()}.`,
      copy
        ? `The damaged file is kept in the Aplos data folder as ${DAMAGED_DIR}/${copy}.`
        : 'The damaged file could not be copied.',
      '',
      'Only on this Mac',
      `  Drafts not yet saved to Google: ${count(facts.localOnly.drafts)}`,
      `  Scheduled sends: ${count(facts.localOnly.scheduled)}`,
      `  Done, Later, reminders and to-dos: ${count(facts.localOnly.workflow)}`,
      `  Changes not yet sent to Google: ${count(facts.localOnly.changes)}`,
      ...section('Drafts', 'The drafts could not be read.', rows(db, DRAFT_ROWS), draftLines),
      ...section(
        'Scheduled sends',
        'The scheduled sends could not be read.',
        rows(db, SEND_ROWS),
        sendLines,
      ),
      ...section(
        'Done, Later, reminders and to-dos',
        'These could not be read.',
        rows(db, WORKFLOW_ROWS),
        workflowLine,
      ),
      '',
    ].join('\n');
  } finally {
    db?.close();
  }
}

const DRAFT_ROWS =
  'SELECT id, data, updated_at FROM drafts WHERE synced_revision IS NULL OR synced_revision < revision ORDER BY updated_at DESC';
const SEND_ROWS = `SELECT s.not_before, d.data FROM submissions s LEFT JOIN drafts d ON d.id = s.draft_id
  WHERE s.state IN ('queued', 'scheduled') ORDER BY s.not_before`;
const WORKFLOW_ROWS = `SELECT w.status, w.later_until, w.reminder_at, w.todo, w.bookmarked, t.subject
  FROM thread_workflow w LEFT JOIN threads t ON t.id = w.thread_id
  WHERE w.status <> 'new' OR w.later_until IS NOT NULL OR w.reminder_at IS NOT NULL OR w.todo IS NOT NULL
    OR w.bookmarked = 1
  ORDER BY w.last_date DESC`;

/** A titled part of the report: its rows' lines, "None." when empty, or why it could not be read. */
function section(
  title: string,
  unread: string,
  list: Row[] | undefined,
  lines: (row: Row) => string[],
) {
  const out = ['', title, '-'.repeat(title.length)];
  if (!list) return [...out, unread];
  if (!list.length) return [...out, 'None.'];
  return [...out, ...list.flatMap(lines)];
}

const subjectOf = (f: Row) => (typeof f.subject === 'string' ? f.subject : '');

function draftLines(d: Row): string[] {
  const f = fields(d.data);
  return [
    `Last edited: ${when(d.updated_at)}`,
    `To: ${people(f.to)}`,
    ...(people(f.cc) ? [`Cc: ${people(f.cc)}`] : []),
    `Subject: ${subjectOf(f)}`,
    '',
    plain(f.html),
    '',
    '---',
  ];
}

function sendLines(s: Row): string[] {
  const f = fields(s.data);
  return [
    `Send at: ${when(s.not_before)}`,
    `To: ${people(f.to)}`,
    `Subject: ${subjectOf(f)}`,
    '',
    plain(f.html),
    '',
    '---',
  ];
}

function workflowLine(w: Row): string[] {
  const marks = [
    w.status === 'done' ? 'Done' : '',
    w.status === 'later' ? `Later until ${when(w.later_until)}` : '',
    w.reminder_at ? `Reminder ${when(w.reminder_at)}` : '',
    typeof w.todo === 'string' && w.todo ? `To-do: ${w.todo}` : '',
    w.bookmarked === 1 ? 'Bookmarked' : '',
  ].filter(Boolean);
  const subject = typeof w.subject === 'string' && w.subject ? w.subject : '(no subject)';
  return [`${subject}: ${marks.join(', ')}`];
}
