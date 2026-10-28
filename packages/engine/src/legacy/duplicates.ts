import type { Thread } from '@aplos/contract/legacy/types';

/** Compare complete content, never snippets or AI summaries. Delivery IDs and times may differ. */
function contentKey(thread: Thread): string | undefined {
  if (
    !thread.messages.length ||
    thread.messages.some(m => (!m.text && !m.html) || m.attachments.some(a => a.data === undefined))
  )
    return;
  return JSON.stringify([
    thread.subject,
    thread.messages.map(m => [
      m.from,
      m.fromName,
      m.to,
      m.cc ?? [],
      m.sent === true,
      m.text,
      m.html ?? '',
      m.quoted ?? '',
      m.attachments.map(a => [a.name, a.type, a.size, a.contentId ?? '', a.data]),
    ]),
  ]);
}

/**
 * Older exact copies in this account's inbox, only for content that arrived in this sync.
 * Compare whole threads so a repeated reply can never hide a conversation with different history.
 * Unknown attachment bytes cannot prove equality. Local edits made during sync always win.
 */
export function olderInboxDuplicates(
  threads: Thread[],
  accountId: string,
  arrivals: ReadonlySet<string>,
  protectedIds: ReadonlySet<string>,
): Thread[] {
  if (!arrivals.size) return [];
  const eligible = (t: Thread) =>
    t.accountId === accountId &&
    t.status === 'new' &&
    (!t.labels || t.labels.includes('INBOX')) &&
    !protectedIds.has(t.id) &&
    Number.isFinite(Date.parse(t.date));
  const groups = new Map<string, Thread[]>();
  for (const t of threads)
    if (arrivals.has(t.id) && eligible(t)) {
      const key = contentKey(t);
      if (key !== undefined) groups.set(key, []);
    }
  if (!groups.size) return [];
  for (const t of threads)
    if (eligible(t)) {
      const key = contentKey(t);
      if (key !== undefined) groups.get(key)?.push(t);
    }
  const older: Thread[] = [];
  for (const copies of groups.values()) {
    // If delivery times tie, prefer the newly observed copy, then a stable ID within one batch.
    copies.sort(
      (a, b) =>
        Date.parse(b.date) - Date.parse(a.date) ||
        Number(arrivals.has(b.id)) - Number(arrivals.has(a.id)) ||
        a.id.localeCompare(b.id),
    );
    older.push(...copies.slice(1));
  }
  return older;
}
