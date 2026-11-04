import { StoreError, type CommitExtension, type CommitExtensionTx } from '../store/port';
import { normaliseMatch } from './policy';

// The writer for `Settings.mail.imageAllowList` (seam 2), used by `Mail/allowImages`. The settings document belongs to
// `eng-contract`'s `Settings/*`, which has no writer yet; this kind touches only `mail.imageAllowList` and keeps every
// other field of the document as it is, so `Settings/set` can take the document over later.

/** The list's bound, the contract's `MailSettings.imageAllowList` maximum. */
export const MAX_ALLOW_LIST = 5_000;

/** Add (`allow`) or remove one normalised address or `@domain`. */
export interface ImageAllowListWrite {
  kind: 'imageAllowList';
  sender: string;
  allow: boolean;
}

declare module '../store/port' {
  interface ExtensionWrites {
    imageAllowList: ImageAllowListWrite;
  }
}

type Doc = Record<string, unknown>;

const isObject = (value: unknown): value is Doc =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readDoc(tx: CommitExtensionTx): Doc {
  const row = tx.get<{ data: string }>('SELECT data FROM settings WHERE id = 1');
  if (!row) return {};
  try {
    const doc: unknown = JSON.parse(row.data);
    return isObject(doc) ? doc : {};
  } catch {
    throw new StoreError('invalid', 'The settings document is not JSON');
  }
}

/** The stored list, each entry normalised, unreadable entries dropped, no duplicates. */
export function cleanList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.flatMap(entry => normaliseMatch(entry) ?? []))];
}

/** The list after the edit, or undefined when it does not change. */
export function editList(list: readonly string[], sender: string, allow: boolean) {
  const has = list.includes(sender);
  if (allow === has) return undefined;
  return allow ? [...list, sender] : list.filter(entry => entry !== sender);
}

function apply(write: { kind: string }, tx: CommitExtensionTx): void {
  const w = write as ImageAllowListWrite;
  const sender = normaliseMatch(w.sender);
  if (sender === undefined || typeof w.allow !== 'boolean')
    throw new StoreError('invalid', 'An image allow-list entry is an address or @domain');
  const doc = readDoc(tx);
  const mail = isObject(doc.mail) ? doc.mail : {};
  const next = editList(cleanList(mail.imageAllowList), sender, w.allow);
  if (!next) return;
  if (next.length > MAX_ALLOW_LIST) throw new StoreError('invalid', 'The image allow-list is full');
  const data = JSON.stringify({ ...doc, mail: { ...mail, imageAllowList: next } });
  tx.run(
    'INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
    data,
  );
  tx.mark('Settings', 'settings', 'u');
}

export const allowListExtension: CommitExtension = {
  lane: 'eng-html',
  kinds: ['imageAllowList'],
  changeTypes: ['Settings'],
  apply,
};
