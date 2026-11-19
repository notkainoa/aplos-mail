import type { State, SuggestedAction, ThreadRow, WorkflowState } from '@aplos/contract';
import { FLAG } from '../store';
import type { SqlRow, StoreReader } from '../store';
import { splitId } from './compile';
import type { ViewEnv } from './specs';

/*
 * `Thread/get` (views-3): body-free list rows built from the thread, its workflow row, its folder lists and its newest
 * summary. A row is a pure read of the database, so a window frame's `changed` ids and a later `Thread/get` agree.
 */

const DAY = 86_400_000;

const DEFAULTS = { state: 'none' } as const;

/** The columns of a thread joined to its workflow row. */
export const THREAD_COLS = `t.id AS rowid, t.account_id, t.remote_id, t.rev, t.subject, t.snippet, t.participants,
  t.last_date, t.last_inbound_date, t.msg_count, t.unread_count, t.flagged, t.has_attach, t.complete, t.remote_count,
  t.list_unsub, w.status, w.later_until, w.due_date, w.due_source, w.reminder_at, w.reminder_fired_at, w.bookmarked,
  w.reply_status, w.todo, w.hidden_from_home, w.lane, w.importance, w.rank_source, w.ranked_at, w.due_band, w.edited_at`;

export interface ThreadDbRow extends SqlRow {
  rowid: number;
  account_id: string;
  remote_id: string;
  rev: number;
  subject: string | null;
  snippet: string | null;
  participants: string | null;
  last_date: number;
  last_inbound_date: number | null;
  msg_count: number;
  unread_count: number;
  flagged: number;
  has_attach: number;
  complete: number;
  remote_count: number | null;
  list_unsub: string | null;
  status: string;
  later_until: number | null;
  due_date: string | null;
  due_source: string | null;
  reminder_at: number | null;
  reminder_fired_at: number | null;
  bookmarked: number | null;
  reply_status: string | null;
  todo: string | null;
  hidden_from_home: number | null;
  lane: string;
  importance: string;
  rank_source: string;
  ranked_at: number | null;
  due_band: number;
  edited_at: number | null;
}

/** One thread and its workflow row by contract id, or undefined when it is not stored. */
export function threadByContractId(
  q: StoreReader,
  id: string,
  accounts?: readonly string[],
): ThreadDbRow | undefined {
  const parts = splitId(q, id, accounts);
  if (!parts) return undefined;
  return q.get<ThreadDbRow>(
    `SELECT ${THREAD_COLS} FROM threads t JOIN thread_workflow w ON w.thread_id = t.id WHERE t.account_id = ? AND t.remote_id = ?`,
    parts.accountId,
    parts.remoteId,
  );
}

export const contractId = (t: { account_id: string; remote_id: string }) =>
  `${t.account_id}:${t.remote_id}`;

interface Person {
  name?: string | null;
  address?: string | null;
}

function parsePeople(json: string | null): Person[] {
  try {
    const list = JSON.parse(json ?? '[]') as Person[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** The workflow facts a row carries; absent columns stay absent. */
export function workflowOf(r: ThreadDbRow): WorkflowState {
  const w: WorkflowState = {
    status: r.status,
    bookmarked: r.bookmarked === 1,
    hiddenFromHome: r.hidden_from_home === 1,
  };
  if (r.later_until !== null) w.laterUntil = r.later_until;
  if (r.due_date !== null) w.dueDate = r.due_date;
  if (r.due_source !== null) w.dueSource = r.due_source;
  if (r.reminder_at !== null) w.reminderAt = r.reminder_at;
  if (r.reminder_fired_at !== null) w.reminderFiredAt = r.reminder_fired_at;
  if (r.reply_status !== null) w.replyStatus = r.reply_status;
  if (r.todo !== null) w.todo = r.todo;
  if (r.edited_at !== null) w.editedAt = r.edited_at;
  return w;
}

function summaryOf(q: StoreReader, rowid: number): ThreadRow['summary'] {
  const s = q.get<{ state: string; text: string; model: string; action: string | null }>(
    'SELECT state, text, model, action FROM summaries WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1',
    rowid,
  );
  if (!s) return { ...DEFAULTS };
  const out: ThreadRow['summary'] = { state: s.state, text: s.text, model: s.model };
  if (s.action) {
    try {
      out.action = JSON.parse(s.action) as SuggestedAction;
    } catch {
      // A summary whose action is unreadable still shows its text.
    }
  }
  return out;
}

const folderIds = (q: StoreReader, rowid: number): string[] =>
  q
    .all<{
      a: string;
      r: string;
    }>(
      'SELECT f.account_id AS a, f.remote_id AS r FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id WHERE tf.thread_id = ?',
      rowid,
    )
    .map(f => `${f.a}:${f.r}`);

/** Back from Later (a Later item whose date has arrived and that was not cleared from Home). */
export const isFromLater = (r: ThreadDbRow, now: number) =>
  r.status === 'later' &&
  r.later_until !== null &&
  r.later_until <= now &&
  r.hidden_from_home !== 1;

/** Follow up: you sent the last message, nobody answered within `followUpDays`, and you are waiting on a reply. */
function followOf(q: StoreReader, r: ThreadDbRow, env: ViewEnv): ThreadRow['follow'] {
  if (r.reply_status !== 'awaitingReply') return undefined;
  if (r.last_date > env.now - env.followUpDays * DAY) return undefined;
  if (r.last_inbound_date !== null && r.last_inbound_date >= r.last_date) return undefined;
  const sent = q.get(
    `SELECT 1 FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id WHERE tf.thread_id = ? AND f.role = 'sent'`,
    r.rowid,
  );
  return sent ? { since: r.last_date } : undefined;
}

interface SentRow extends SqlRow {
  from_addr: string | null;
  to_json: string | null;
  cc_json: string | null;
}

/*
 * The thread's non-draft from-me messages, newest first. A send from an alias keeps its own `from_addr` while carrying
 * the from-me flag, so these senders are the owner's aliases; the newest one's To+Cc names who a Follow up waits on.
 */
function sentByOwner(q: StoreReader, rowid: number): SentRow[] {
  return q.all<SentRow>(
    `SELECT from_addr, to_json, cc_json FROM messages
      WHERE thread_id = ? AND (flags & ${FLAG.draft | FLAG.fromMe}) = ${FLAG.fromMe}
      ORDER BY internal_date DESC, id DESC`,
    rowid,
  );
}

function buildRow(
  q: StoreReader,
  r: ThreadDbRow,
  env: ViewEnv,
  ownAddresses: ReadonlySet<string>,
): ThreadRow {
  const people = parsePeople(r.participants);
  const sent = sentByOwner(q, r.rowid);
  const mine = new Set(ownAddresses);
  for (const m of sent) if (m.from_addr) mine.add(m.from_addr.toLowerCase());
  const person = (p: Person): ThreadRow['participants'][number] => ({
    ...(p.name ? { name: p.name } : {}),
    ...(p.address ? { address: p.address } : {}),
    ...(p.address && mine.has(p.address.toLowerCase()) ? { me: true } : {}),
  });
  const participants = people.map(person);
  const recipients = sent.length
    ? [...parsePeople(sent[0].to_json), ...parsePeople(sent[0].cc_json)].slice(0, 6).map(person)
    : [];
  const follow = followOf(q, r, env);
  return {
    id: contractId(r),
    accountId: r.account_id,
    rev: r.rev,
    subject: r.subject ?? '',
    snippet: r.snippet ?? '',
    fromName: people[0]?.name || people[0]?.address || '',
    participants,
    lastDate: r.last_date,
    ...(r.last_inbound_date !== null ? { lastInboundDate: r.last_inbound_date } : {}),
    messageCount: r.msg_count,
    unreadCount: r.unread_count,
    partial: r.complete === 0,
    unread: r.unread_count > 0,
    flagged: r.flagged === 1,
    hasAttachments: r.has_attach === 1,
    labels: folderIds(q, r.rowid),
    workflow: workflowOf(r),
    rank: {
      lane: r.lane,
      importance: r.importance,
      source: r.rank_source,
      dueBand: r.due_band,
      ...(r.ranked_at !== null ? { rankedAt: r.ranked_at } : {}),
    },
    summary: summaryOf(q, r.rowid),
    fromLater: isFromLater(r, env.now),
    unsubscribe: r.list_unsub !== null,
    ...(recipients.length ? { recipients } : {}),
    ...(follow ? { follow } : {}),
  };
}

/** Every account's own address (lower case), to mark the owner among a row's participants and recipients. */
function accountAddresses(q: StoreReader): Set<string> {
  return new Set(
    q.all<{ address: string }>('SELECT address FROM accounts').map(a => a.address.toLowerCase()),
  );
}

/** `Thread/get`: unknown ids come back in `notFound` instead of failing the call. */
export function readThreadRows(
  q: StoreReader,
  ids: readonly string[],
  env: ViewEnv,
  state: State,
): { state: State; list: ThreadRow[]; notFound: string[] } {
  const accounts = q.all<{ id: string }>('SELECT id FROM accounts').map(a => a.id);
  const addresses = accountAddresses(q);
  const list: ThreadRow[] = [];
  const notFound: string[] = [];
  for (const id of ids) {
    const r = threadByContractId(q, id, accounts);
    if (r) list.push(buildRow(q, r, env, addresses));
    else notFound.push(id);
  }
  return { state, list, notFound };
}
