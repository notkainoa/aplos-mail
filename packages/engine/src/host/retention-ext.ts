import type { CommitExtension, CommitExtensionTx } from '../store/port';

declare module '../store/port' {
  interface ExtensionWrites {
    bodyRead: BodyReadWrite;
    bodyEvict: BodyEvictWrite;
    bodyVacuum: { kind: 'bodyVacuum'; pages: number };
  }
}

/** `Thread/open`: the thread's messages were opened now, for retention (ARCH 3.6). */
export interface BodyReadWrite {
  kind: 'bodyRead';
  accountId: string;
  remoteThreadId: string;
  /** The engine clock's now, the clock the retention pass compares against. */
  at: number;
}

/**
 * Drops stored bodies (`messages.id`s, never on the wire) planned by the retention pass (`store/retention.ts`). Every
 * row is checked again here, since the plan was read across yields: a draft, a local-only message, one not yet in the
 * search index, or one opened after `before` keeps its body; with `rule` (the age rule, not the size cap) a starred
 * or unread message keeps it too.
 */
export interface BodyEvictWrite {
  kind: 'bodyEvict';
  ids: readonly number[];
  before: number;
  rule: boolean;
}

function apply(write: { kind: string }, tx: CommitExtensionTx): void {
  if (write.kind === 'bodyVacuum') {
    // `auto_vacuum=INCREMENTAL` (host opener): hand freed pages back to the disk, a bounded step at a time.
    const pages = Math.max(
      1,
      Math.trunc(Number((write as { kind: string; pages?: number }).pages) || 1),
    );
    tx.all(`PRAGMA incremental_vacuum(${pages})`);
    return;
  }
  if (write.kind === 'bodyRead') {
    const w = write as BodyReadWrite;
    const thread = tx.threadRowId(w.accountId, w.remoteThreadId);
    if (thread !== undefined)
      tx.run(
        'UPDATE messages SET last_read_at = ? WHERE thread_id = ?',
        Number(w.at) || tx.now(),
        thread,
      );
    return;
  }
  const w = write as BodyEvictWrite;
  for (const id of w.ids) {
    const m = tx.get<{ account_id: string; remote_id: string }>(
      `SELECT account_id, remote_id FROM messages WHERE id = ? AND (flags & 8) = 0 AND origin <> 'local'
        AND (parts & 8) <> 0 AND (last_read_at IS NULL OR last_read_at < ?) AND (? = 0 OR (flags & 3) = 1)`,
      id,
      w.before,
      Number(w.rule),
    );
    if (!m || !tx.run('DELETE FROM bodies WHERE message_id = ?', id).changes) continue;
    tx.run('UPDATE messages SET parts = parts | 32 WHERE id = ?', id);
    tx.touchMessage(m.account_id, m.remote_id); // Message.bodyState is now `evicted`
  }
}

/** Retention's writers (eng-host): mark opened, evict, vacuum. The pass itself loads lazily. */
export const retentionExtension: CommitExtension = {
  lane: 'eng-host',
  kinds: ['bodyRead', 'bodyEvict', 'bodyVacuum'],
  changeTypes: [],
  apply,
};
