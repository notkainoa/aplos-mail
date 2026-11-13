import type { SqlValue } from './sql';
import {
  StoreError,
  type FlagsWrite,
  type FolderRef,
  type MessageDeleteWrite,
  type MessageTarget,
  type MessageWrite,
  type PlacementsWrite,
} from './port';
import { FLAG, HDR, PART, MESSAGE_COLS, type CommitRun, type MessageRow } from './commit';
import { folderId as messageFolderId } from './commit-folders';
import { countCorrespondents } from './correspondents';
import { dropIfChanged } from './fts';

const ID_SLOTS = 4096,
  MAX_SECONDS = 2 ** 32;
export function flagBits(w: {
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
}): [number, number] {
  let set = 0,
    clear = 0;
  const bit = (on: boolean | undefined, flag: number) => {
    if (on === true) set |= flag;
    else if (on === false) clear |= flag;
  };
  bit(w.seen, FLAG.seen);
  bit(w.flagged, FLAG.flagged);
  bit(w.answered, FLAG.answered);
  return [set, clear];
}

/** Flags and hdr bits a message write carries; each named flag joins the bits the write sets. */
function messageBits(w: MessageWrite): { flags: number; hdr: number } {
  const h = w.hdr ?? {};
  return {
    flags:
      (w.flags.seen ? FLAG.seen : 0) |
      (w.flags.flagged ? FLAG.flagged : 0) |
      (w.flags.answered ? FLAG.answered : 0) |
      (w.flags.draft ? FLAG.draft : 0) |
      (w.flags.fromMe ? FLAG.fromMe : 0) |
      (w.hasAttachments ? FLAG.attach : 0),
    hdr:
      (h.bulk ? HDR.bulk : 0) |
      (h.list ? HDR.list : 0) |
      (h.autoSubmitted ? HDR.autoSubmitted : 0) |
      (h.noreply ? HDR.noreply : 0) |
      (h.directToMe ? HDR.directToMe : 0) |
      (h.ccMe ? HDR.ccMe : 0),
  };
}

/** Origin for a message row: an explicit one, or the commit's step and origin decide. */
function messageOrigin(run: CommitRun, w: MessageWrite): 'search' | 'local' | 'sync' {
  return (
    w.origin ??
    (run.input.step === 'search'
      ? 'search'
      : run.local || run.input.origin === 'import'
        ? 'local'
        : 'sync')
  );
}

/** The column values of `messages.upsert`, in the fixed order the SQL names them. */
function messageFields(
  run: CommitRun,
  w: MessageWrite,
  threadId: number,
  flags: number,
  hdr: number,
): SqlValue[] {
  return [
    threadId,
    w.internetId ?? null,
    w.inReplyTo ?? null,
    w.refs ? JSON.stringify(w.refs) : null,
    w.from?.address ?? null,
    w.from?.name ?? null,
    JSON.stringify(w.to ?? []),
    JSON.stringify(w.cc ?? []),
    w.bcc?.length ? JSON.stringify(w.bcc) : null,
    w.replyTo?.length ? JSON.stringify(w.replyTo) : null,
    w.subject ?? null,
    w.snippet ?? null,
    w.date,
    w.internalDate,
    w.size ?? null,
    flags,
    hdr,
    w.listUnsubscribe ? JSON.stringify(w.listUnsubscribe) : null,
    w.listUnsubscribe ? listAuth(w.listAuthenticated) : null,
  ];
}

/** `messages.list_auth`, kept only beside `list_unsub`: strict booleans only, anything else is unknown (NULL). */
function listAuth(value: unknown): number | null {
  if (value === true) return 1;
  return value === false ? 0 : null;
}

// ------------------------------------------------------------ messages

export function threadId(
  run: CommitRun,
  accountId: string,
  remoteThreadId: string,
  lastDate: number,
): number {
  const row = run.q('SELECT id FROM threads WHERE account_id = ? AND remote_id = ?').get<{
    id: number;
  }>(accountId, remoteThreadId);
  if (row) return row.id;
  const id = run
    .q(
      `INSERT INTO threads(account_id, remote_id, last_date, msg_count, unread_count, flagged, has_attach, rev)
    VALUES(?, ?, ?, 0, 0, 0, 0, ?) RETURNING id`,
    )
    .get<{ id: number }>(accountId, remoteThreadId, lastDate, run.seq)!.id;
  // Every thread has a workflow row, so Home's index covers it without an outer join.
  run
    .q(
      "INSERT INTO thread_workflow(thread_id, account_id, sync_key, status, last_date) VALUES(?, ?, ?, 'new', ?)",
    )
    .run(id, accountId, remoteThreadId, lastDate);
  return id;
}

/**
 * Date-ordered rowid (ARCH 3.1, plan 10 E2 item 3): seconds * 4096 + n, seconds clamped to [0, 2^32]. A full second
 * carries into the next one and continues after the highest id there, so a carried id never repeats one issued.
 */
export function allocateId(run: CommitRun, internalDate: number): number {
  let seconds = Math.min(Math.max(Math.floor(internalDate / 1000), 0), MAX_SECONDS);
  for (;;) {
    const base = seconds * ID_SLOTS;
    const top = run.q('SELECT max(id) AS m FROM messages WHERE id >= ? AND id < ?').get<{
      m: number | null;
    }>(base, base + ID_SLOTS)?.m;
    const next = top === null || top === undefined ? base : top + 1;
    if (next < base + ID_SLOTS) return next;
    seconds++;
  }
}

export function message(run: CommitRun, w: MessageWrite) {
  if (!w.accountId || !w.remoteId || !w.remoteThreadId)
    throw new StoreError('invalid', 'A message needs accountId, remoteId and remoteThreadId');
  if (!Number.isFinite(w.internalDate) || !Number.isFinite(w.date))
    throw new StoreError('invalid', `Message ${w.remoteId} has no valid date`);
  const origin = messageOrigin(run, w);
  const tid = threadId(run, w.accountId, w.remoteThreadId, w.internalDate);
  const existing = run.messageRow(w.accountId, w.remoteId);
  const fenced = existing !== undefined && run.fenced(existing.local_seq);
  const bits = messageBits(w);
  let flags = bits.flags;
  if (fenced) {
    const userFlags = FLAG.seen | FLAG.flagged | FLAG.answered;
    flags = (flags & ~userFlags) | (existing.flags & userFlags);
  }
  const localSeq = run.local ? run.seq : (existing?.local_seq ?? null);
  const fields = messageFields(run, w, tid, flags, bits.hdr);
  let id: number;
  if (existing) {
    id = existing.id;
    // subject, snippet, then from_addr through bcc_json: what the search index holds.
    dropIfChanged(run, id, [fields[10], fields[11], ...fields.slice(4, 9)]);
    // A search hit never downgrades a synced row; a sync adopts a search or local row.
    run
      .q(
        `UPDATE messages SET thread_id = ?, internet_id = ?, in_reply_to = ?, refs = ?, from_addr = ?, from_name = ?,
      to_json = ?, cc_json = ?, bcc_json = ?, reply_to = ?, subject = ?, snippet = ?, date = ?, internal_date = ?, size = ?,
      flags = ?, hdr = ?, list_unsub = ?, list_auth = ?, origin = CASE WHEN ? = 'search' THEN origin ELSE ? END, rev = ?, local_seq = ?
      WHERE id = ?`,
      )
      .run(...fields, origin, origin, run.seq, localSeq, id);
    if (existing.thread_id !== tid) run.touched.add(existing.thread_id);
    // A draft sent in place keeps its id: it counts when it stops being a draft.
    if (existing.flags & FLAG.draft && !(flags & FLAG.draft)) countCorrespondents(run, w);
  } else {
    id = allocateId(run, w.internalDate);
    run
      .q(
        `INSERT INTO messages(thread_id, internet_id, in_reply_to, refs, from_addr, from_name, to_json, cc_json, bcc_json,
      reply_to, subject, snippet, date, internal_date, size, flags, hdr, list_unsub, list_auth, id, account_id, remote_id, origin,
      first_seen_seq, rev, local_seq) VALUES(${fields.map(() => '?').join(', ')}, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...fields, id, w.accountId, w.remoteId, origin, run.seq, run.seq, localSeq);
    countCorrespondents(run, w);
  }
  run.ingested.set(id, run.ingested.get(id) ?? !existing);
  if (w.folders && !fenced) replacePlacements(run, id, w.accountId, w.folders, w.seenGen);
  run.touched.add(tid);
  run.touchedMessage(w.accountId, id);
  run.mark('Message', w.accountId, w.remoteId, 'u');
}

export function replacePlacements(
  run: CommitRun,
  messageId: number,
  accountId: string,
  refs: FolderRef[],
  seenGen: number | undefined,
) {
  const ids = refs.map(r => ({
    folderId: messageFolderId(run, accountId, r.folder),
    uid: r.uid,
  }));
  run
    .q(
      'DELETE FROM message_folders WHERE message_id = ? AND folder_id NOT IN (SELECT value FROM json_each(?))',
    )
    .run(messageId, JSON.stringify(ids.map(i => i.folderId)));
  for (const { folderId: f, uid } of ids) place(run, messageId, f, uid, seenGen);
}

/** A stamp only rises: a page of an older round committed late must not lower a newer round's stamp and get swept. */
export function place(
  run: CommitRun,
  messageId: number,
  folderId: number,
  uid: number | undefined,
  seenGen: number | undefined,
) {
  run
    .q(
      `INSERT INTO message_folders(message_id, folder_id, uid, seen_gen) VALUES(?, ?, ?, ?)
    ON CONFLICT(message_id, folder_id) DO UPDATE SET uid = COALESCE(excluded.uid, uid),
      seen_gen = CASE WHEN seen_gen IS NULL THEN excluded.seen_gen ELSE max(seen_gen, COALESCE(excluded.seen_gen, seen_gen)) END`,
    )
    .run(messageId, folderId, uid ?? null, seenGen ?? null);
}

export function targets(run: CommitRun, accountId: string, target: MessageTarget): MessageRow[] {
  let rows: MessageRow[], what: string;
  if ('remoteId' in target) {
    const row = run.messageRow(accountId, target.remoteId);
    rows = row ? [row] : [];
    what = `Message ${target.remoteId}`;
  } else if ('remoteThreadId' in target) {
    rows = run
      .q(
        `SELECT ${MESSAGE_COLS} FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE t.account_id = ? AND t.remote_id = ? AND (m.flags & ${FLAG.draft}) = 0`,
      )
      .all<MessageRow>(accountId, target.remoteThreadId);
    what = `Thread ${target.remoteThreadId}`;
  } else {
    rows = run
      .q(
        `SELECT ${MESSAGE_COLS} FROM message_folders mf JOIN folders f ON f.id = mf.folder_id
        JOIN messages m ON m.id = mf.message_id WHERE f.account_id = ? AND f.remote_id = ? AND mf.uid = ?`,
      )
      .all<MessageRow>(accountId, target.folder, target.uid);
    what = `UID ${target.uid} in ${target.folder}`;
  }
  if (!rows.length) run.missing(what);
  return rows;
}

export function placements(run: CommitRun, w: PlacementsWrite) {
  for (const m of targets(run, w.accountId, w.target)) {
    if (run.fenced(m.local_seq)) continue;
    movePlacements(run, w.accountId, m.id, w.add, w.remove, w.seenGen);
    run.touchMessage(w.accountId, m);
  }
}

export function movePlacements(
  run: CommitRun,
  accountId: string,
  messageId: number,
  add: FolderRef[],
  remove: string[],
  seenGen: number | undefined,
) {
  for (const ref of add)
    place(run, messageId, messageFolderId(run, accountId, ref.folder), ref.uid, seenGen);
  for (const folder of remove)
    run
      .q(
        'DELETE FROM message_folders WHERE message_id = ? AND folder_id = (SELECT id FROM folders WHERE account_id = ? AND remote_id = ?)',
      )
      .run(messageId, accountId, folder);
}

export function flags(run: CommitRun, w: FlagsWrite) {
  const [set, clear] = flagBits(w);
  for (const m of targets(run, w.accountId, w.target)) {
    if (run.fenced(m.local_seq)) continue;
    run.q('UPDATE messages SET flags = (flags & ~?) | ? WHERE id = ?').run(clear, set, m.id);
    run.touchMessage(w.accountId, m);
  }
}

export function messageDelete(run: CommitRun, w: MessageDeleteWrite) {
  const m = run
    .q('SELECT id, thread_id, parts FROM messages WHERE account_id = ? AND remote_id = ?')
    .get<{ id: number; thread_id: number; parts: number }>(w.accountId, w.remoteId);
  if (!m) return; // deletions are idempotent
  if (m.parts & PART.fts) run.q('DELETE FROM messages_fts WHERE rowid = ?').run(m.id);
  run.q('DELETE FROM messages WHERE id = ?').run(m.id);
  run.touched.add(m.thread_id);
  run.mark('Message', w.accountId, w.remoteId, 'd');
}
