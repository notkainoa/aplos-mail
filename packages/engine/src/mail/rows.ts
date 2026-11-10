import type { Input, Message, Output } from '@aplos/contract';
import type { MethodContext } from '../methods/types';
import { KEEP_DONE_MS } from '../outbox/notifications';
import { FLAG, PART } from '../store/commit';
import type { StoreReader } from '../store/port';
import { findMessage, type MessageRef } from './message';

// `Message/get`: stored message headers and attachment lists, no bodies. Unknown ids come back in `notFound`. An
// attachment's id is its provider part (`attachments.remote_part`), scoped by the message id, as `Attachment/get` takes it.

type Address = NonNullable<Message['from']>;
type Attachment = Message['attachments'][number];

interface MessageDbRow {
  rev: number;
  internet_id: string | null;
  in_reply_to: string | null;
  refs: string | null;
  from_addr: string | null;
  from_name: string | null;
  to_json: string | null;
  cc_json: string | null;
  bcc_json: string | null;
  reply_to: string | null;
  subject: string | null;
  snippet: string | null;
  date: number;
  flags: number;
  parts: number;
  has_body: number;
  [k: string]: string | number | null;
}

interface AttachmentDbRow {
  remote_part: string;
  name: string | null;
  mime: string | null;
  size: number | null;
  cid: string | null;
  inline: number;
  state: string;
  [k: string]: string | number | null;
}

function parseJson(json: string | null): unknown {
  if (json === null) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** A stored address list; entries without an address are dropped. */
export function addresses(json: string | null): Address[] {
  const list = parseJson(json);
  if (!Array.isArray(list)) return [];
  return list.flatMap(entry => {
    const { address, name } = (entry ?? {}) as { address?: unknown; name?: unknown };
    if (typeof address !== 'string' || !address) return [];
    return [typeof name === 'string' && name ? { address, name } : { address }];
  });
}

function senderOf(address: string, name: string | null): Address {
  return name ? { address, name } : { address };
}

function references(json: string | null): string[] | undefined {
  const list = parseJson(json);
  return Array.isArray(list) ? list.filter((r): r is string => typeof r === 'string') : undefined;
}

function bodyState(row: MessageDbRow): Message['bodyState'] {
  if (row.has_body) return 'present';
  return row.parts & PART.evicted ? 'evicted' : 'absent';
}

function bodyKind(row: MessageDbRow): Message['bodyKind'] {
  if (row.parts & PART.html) return 'html';
  return row.parts & PART.text ? 'text' : undefined;
}

function attachmentsOf(q: StoreReader, rowId: number): Attachment[] {
  const rows = q.all<AttachmentDbRow>(
    'SELECT remote_part, name, mime, size, cid, inline, state FROM attachments WHERE message_id = ? ORDER BY id',
    rowId,
  );
  return rows.map(a => ({
    id: a.remote_part,
    name: a.name ?? '',
    mime: a.mime ?? 'application/octet-stream',
    size: a.size ?? 0,
    inline: a.inline === 1,
    ...(a.cid !== null ? { contentId: a.cid } : {}),
    state: a.state,
  }));
}

function labelsOf(q: StoreReader, rowId: number): string[] {
  return q
    .all<{ a: string; r: string }>(
      'SELECT f.account_id AS a, f.remote_id AS r FROM message_folders mf JOIN folders f ON f.id = mf.folder_id WHERE mf.message_id = ?',
      rowId,
    )
    .map(f => `${f.a}:${f.r}`);
}

/** The notifier's outcome for one message (`Message.notification`); unknown once the outbox row may have been pruned. */
function notificationOf(
  q: StoreReader,
  rowId: number,
  date: number,
  now: number,
): Message['notification'] {
  const state = q.get<{ state: string }>(
    'SELECT state FROM notifications WHERE message_id = ?',
    rowId,
  )?.state;
  if (state === undefined) return now - date > KEEP_DONE_MS ? undefined : 'none';
  return state === 'dropped' ? 'suppressed' : 'sent';
}

function notificationField(value: Message['notification']) {
  return value ? { notification: value } : {};
}

function optional(row: MessageDbRow) {
  const bcc = addresses(row.bcc_json);
  const replyTo = addresses(row.reply_to);
  const refs = references(row.refs);
  const kind = bodyKind(row);
  return {
    ...(row.internet_id !== null ? { internetId: row.internet_id } : {}),
    ...(row.from_addr ? { from: senderOf(row.from_addr, row.from_name) } : {}),
    ...(bcc.length ? { bcc } : {}),
    ...(replyTo.length ? { replyTo } : {}),
    ...(kind ? { bodyKind: kind } : {}),
    ...(row.in_reply_to !== null ? { inReplyTo: row.in_reply_to } : {}),
    ...(refs?.length ? { references: refs } : {}),
  };
}

function messageOf(q: StoreReader, ref: MessageRef, now: number): Message | undefined {
  const row = q.get<MessageDbRow>(
    `SELECT m.*, EXISTS(SELECT 1 FROM bodies b WHERE b.message_id = m.id) AS has_body FROM messages m WHERE m.id = ?`,
    ref.rowId,
  );
  if (!row) return undefined;
  return {
    id: ref.id,
    threadId: `${ref.accountId}:${ref.threadRemoteId}`,
    accountId: ref.accountId,
    rev: row.rev,
    to: addresses(row.to_json),
    cc: addresses(row.cc_json),
    subject: row.subject ?? '',
    snippet: row.snippet ?? '',
    date: row.date,
    seen: (row.flags & FLAG.seen) !== 0,
    flagged: (row.flags & FLAG.flagged) !== 0,
    answered: (row.flags & FLAG.answered) !== 0,
    fromMe: (row.flags & FLAG.fromMe) !== 0,
    labels: labelsOf(q, ref.rowId),
    attachments: attachmentsOf(q, ref.rowId),
    bodyState: bodyState(row),
    ...optional(row),
    ...notificationField(notificationOf(q, ref.rowId, row.date, now)),
  };
}

export function getMessages(args: Input<'Message/get'>, ctx: MethodContext): Output<'Message/get'> {
  const { store, clock } = ctx.services;
  const now = clock.now();
  return store.read(q => {
    const accounts = q.all<{ id: string }>('SELECT id FROM accounts').map(a => a.id);
    const list: Message[] = [];
    const notFound: string[] = [];
    for (const id of args.ids) {
      const ref = findMessage(q, id, accounts);
      const message = ref ? messageOf(q, ref, now) : undefined;
      if (message) list.push(message);
      else notFound.push(id);
    }
    return { state: { dbEpoch: store.dbEpoch, seq: store.seq() }, list, notFound };
  });
}
