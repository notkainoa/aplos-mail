import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '../../../../apps/desktop/src/host/sqlite';
import { openStore, type MessageWrite, type OpenStoreOptions, type StorePort } from '../../src/store';

/** A fresh `mail.db` in its own temp folder, on the real host adapter. */
export function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aplos-store-'));
  const path = join(dir, 'mail.db');
  return { path, open: () => openSqlite(path), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function withStore(fn: (store: StorePort, file: ReturnType<typeof tempDb>) => void, options?: OpenStoreOptions) {
  const file = tempDb();
  const store = openStore(file.open(), options);
  try { fn(store, file); } finally { store.close(); file.cleanup(); }
}

export const ACCOUNT = 'acct-1';
export const T0 = Date.UTC(2026, 9, 27, 9, 0, 0);

export const accountWrite = {
  kind: 'account', id: ACCOUNT, provider: 'google', address: 'owner@mail.example',
  capabilities: { labels: true, drafts: true }, status: { state: 'ok' },
} as const;

export const folderWrites = [
  { kind: 'folder', accountId: ACCOUNT, remoteId: 'INBOX', name: 'Inbox', role: 'inbox', folderKind: 'system' },
  { kind: 'folder', accountId: ACCOUNT, remoteId: 'TRASH', name: 'Trash', role: 'trash', folderKind: 'system' },
  { kind: 'folder', accountId: ACCOUNT, remoteId: 'Label_1', name: 'Receipts', folderKind: 'label' },
] as const;

export function msg(remoteId: string, remoteThreadId: string, minutes: number, extra: Partial<MessageWrite> = {}): MessageWrite {
  return {
    kind: 'message', accountId: ACCOUNT, remoteId, remoteThreadId,
    from: { address: `sender-${remoteId}@mail.example`, name: `Sender ${remoteId}` }, to: [{ address: 'owner@mail.example' }], cc: [],
    subject: `Subject ${remoteThreadId}`, snippet: `Snippet ${remoteId}`,
    date: T0 + minutes * 60_000, internalDate: T0 + minutes * 60_000,
    flags: { seen: false, flagged: false, draft: false, fromMe: false },
    folders: [{ folder: 'INBOX' }],
    ...extra,
  };
}
