import {
  StoreError,
  type AttachmentStateWrite,
  type AttachmentsWrite,
  type BodyWrite,
} from './port';
import { PART, type CommitRun } from './commit';
import { encodeBody } from './bodies';

// ------------------------------------------------------------ bodies and attachments (ARCH 3.3)

export function body(run: CommitRun, w: BodyWrite) {
  const m = run.messageRow(w.accountId, w.remoteId);
  if (!m) return run.missing(`Message ${w.remoteId}`);
  const { rawSize, codec, data } = encodeBody(w.body, run.ctx.bodyCodec);
  run
    .q(
      `INSERT INTO bodies(message_id, codec, raw_size, data) VALUES(?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET codec = excluded.codec, raw_size = excluded.raw_size, data = excluded.data`,
    )
    .run(m.id, codec, rawSize, data);
  const parts = run
    .q('SELECT parts FROM messages WHERE id = ?')
    .get<{ parts: number }>(m.id)!.parts;
  // The body changes what search indexes: drop the row and the bit, and this commit indexes the message again.
  if (parts & PART.fts) run.q('DELETE FROM messages_fts WHERE rowid = ?').run(m.id);
  const next =
    (parts & ~(PART.text | PART.html | PART.fts | PART.evicted)) |
    (w.body.text !== undefined ? PART.text : 0) |
    (w.body.html !== undefined ? PART.html : 0);
  run.q('UPDATE messages SET parts = ?, rev = ? WHERE id = ?').run(next, run.seq, m.id);
  run.bodied.add(m.id);
  run.mark('Message', w.accountId, w.remoteId, 'u'); // Message.bodyState
}

export function attachments(run: CommitRun, w: AttachmentsWrite) {
  const m = run.messageRow(w.accountId, w.remoteId);
  if (!m) return run.missing(`Message ${w.remoteId}`);
  run
    .q(
      'DELETE FROM attachments WHERE message_id = ? AND remote_part NOT IN (SELECT value FROM json_each(?))',
    )
    .run(m.id, JSON.stringify(w.list.map(a => a.remotePart)));
  const upsert = run.q(
    `INSERT INTO attachments(message_id, remote_part, name, mime, size, cid, inline, state) VALUES(?, ?, ?, ?, ?, ?, ?, 'absent')
    ON CONFLICT(message_id, remote_part) DO UPDATE SET name = excluded.name, mime = excluded.mime, size = excluded.size,
      cid = excluded.cid, inline = excluded.inline`,
  );
  for (const a of w.list)
    upsert.run(
      m.id,
      a.remotePart,
      a.name ?? null,
      a.mime ?? null,
      a.size ?? null,
      a.cid ?? null,
      Number(a.inline),
    );
  run
    .q('UPDATE messages SET parts = parts | ?, rev = ? WHERE id = ?')
    .run(PART.attachListed, run.seq, m.id);
  run.mark('Message', w.accountId, w.remoteId, 'u'); // Message.attachments
}

/** The path reaches the host's file delete, so it stays inside the attachments folder: relative, no `..`, no NUL. */
function safePath(path: string | null | undefined) {
  if (path === undefined || path === null) return;
  const parts = typeof path === 'string' ? path.split(/[\\/]/) : [];
  if (!path || path.includes('\0') || /^([\\/]|[a-zA-Z]:)/.test(path) || parts.includes('..'))
    throw new StoreError(
      'invalid',
      'An attachment path is relative, inside the attachments folder',
    );
}

export function attachmentState(run: CommitRun, w: AttachmentStateWrite) {
  safePath(w.path);
  const m = run.messageRow(w.accountId, w.remoteId);
  if (!m) return run.missing(`Message ${w.remoteId}`);
  const done = run
    .q(
      `UPDATE attachments SET state = ?, path = CASE WHEN ? THEN ? ELSE path END WHERE message_id = ? AND remote_part = ?`,
    )
    .run(w.state, Number(w.path !== undefined), w.path ?? null, m.id, w.remotePart).changes;
  if (!done) return run.missing(`Attachment ${w.remotePart} of ${w.remoteId}`);
  if (typeof w.path === 'string') run.q('DELETE FROM file_removals WHERE path = ?').run(w.path);
  run.q('UPDATE messages SET rev = ? WHERE id = ?').run(run.seq, m.id);
  run.mark('Message', w.accountId, w.remoteId, 'u');
}
