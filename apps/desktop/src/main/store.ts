import { DatabaseSync } from 'node:sqlite';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { AppState } from '@aplos/contract/legacy/types';
import type { SqlDatabase, SqlValue } from '@aplos/engine/legacy/sql';
import {
  createMailStore,
  type MailStore,
  type OpChanges,
  type SaveExtras,
  type StoreDiff,
} from '@aplos/engine/legacy/store';

export function openDatabase(path: string): SqlDatabase {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
  return {
    exec: sql => db.exec(sql),
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run: (...params: SqlValue[]) => statement.run(...params),
        get: (...params: SqlValue[]) =>
          statement.get(...params) as Record<string, SqlValue> | undefined,
        all: (...params: SqlValue[]) => statement.all(...params) as Record<string, SqlValue>[],
      };
    },
    close: () => db.close(),
  };
}

function readLegacy(path: string): AppState {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (
      value.version !== 1 ||
      !Array.isArray(value.accounts) ||
      !Array.isArray(value.threads) ||
      !Array.isArray(value.drafts) ||
      !Array.isArray(value.events) ||
      !Array.isArray(value.conversations) ||
      !value.settings ||
      !Array.isArray(value.blockedSenders)
    )
      throw new Error('Invalid state format');
    return value as AppState;
  } catch {
    // Keep the original evidence for recovery. Never silently overwrite a damaged mailbox.
    const backup = `${path}.damaged-${Date.now()}`;
    copyFileSync(path, backup);
    throw new Error(
      `The saved mailbox could not be read. A recovery copy is available at ${backup}.`,
    );
  }
}

export interface Store extends Omit<MailStore, 'load' | 'save'> {
  read(): AppState | undefined;
  write(value: AppState, ops?: OpChanges, extras?: SaveExtras): StoreDiff;
  path: string;
}

/** The local mailbox database. A pre-SQLite `state.json` is imported once and kept beside it. */
export function createStore(dataDir: string): Store {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'aplos.db'),
    legacy = join(dataDir, 'state.json');
  let mail: MailStore;
  try {
    mail = createMailStore(openDatabase(path));
    chmodSync(path, 0o600);
  } catch (error) {
    if (error instanceof Error && /newer version/.test(error.message)) throw error;
    throw new Error(
      'The mailbox database could not be opened. Check free space and folder permissions.',
    );
  }
  let initial = mail.load();
  if (!initial && existsSync(legacy)) {
    initial = readLegacy(legacy);
    mail.save(initial);
    renameSync(legacy, `${legacy}.imported`);
  }
  return {
    path,
    read() {
      const value = initial;
      initial = undefined;
      return value ?? mail.load();
    },
    write(value, ops, extras) {
      try {
        return mail.save(value, ops, extras);
      } catch {
        throw new Error('The mailbox could not be saved. Check free space and folder permissions.');
      }
    },
    searchText: mail.searchText,
    cursor: mail.cursor,
    setCursor: mail.setCursor,
    ops: mail.ops,
    memory: mail.memory,
    close: mail.close,
    writeOps(ops) {
      try {
        mail.writeOps(ops);
      } catch {
        throw new Error('The mailbox could not be saved. Check free space and folder permissions.');
      }
    },
  };
}
