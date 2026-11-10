import type { LaneFor, LaneInput, LaneMessage, LaneResult } from '../ports/content';
import type { ListHeaders } from '../ports/provider';
import { decodeBody } from './bodies';
import { FLAG, HDR, PART, type CommitRun } from './commit';
import { normalAddress } from './correspondents';
import type { CommitExtension, FolderRole, IngestBatch, IngestedMessage } from './port';

/** Body text handed to `laneFor` is capped, like the search index's (ARCH 3.4). */
export const LANE_TEXT_CAP = 16_384;
/**
 * The store keeps the list and automation headers as bits (`messages.hdr`) and `list_unsub` JSON, not verbatim, so
 * `LaneMessage.list` is rebuilt from them: a present header gets these stand-in values, an absent one stays undefined.
 */
export const STORED_HEADER = {
  listId: '(present)',
  precedence: 'bulk',
  autoSubmitted: 'auto-generated',
} as const;

const LANES = new Set(['do', 'update', 'low']);
const IMPORTANCE = new Set(['important', 'normal']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The store's ingest step, after the rollups and inside the commit (seam 2): heuristic lanes for every thread that
 * gained or changed a message or got a body, then each lane's `ingest` hook with the batch of stored messages.
 * Correspondents were already counted as each message was inserted.
 */
export function ingest(run: CommitRun) {
  const laneFor = run.ctx.ingest?.laneFor;
  if (laneFor) for (const threadId of rankedThreads(run)) rankThread(run, threadId, laneFor);
  if (!run.ingested.size) return;
  const hooks = new Set([...(run.ctx.extensions?.values() ?? [])].filter(ext => ext.ingest));
  if (!hooks.size) return;
  const batch: IngestBatch = {
    origin: run.input.origin,
    step: run.input.step,
    messages: ingestedMessages(run),
  };
  if (!batch.messages.length) return;
  for (const ext of hooks) (ext as Required<CommitExtension>).ingest(batch, run.txFor(ext));
}

/** The current threads of the messages this commit wrote or gave a body; deleted ones drop out. */
function rankedThreads(run: CommitRun): number[] {
  const ids = [...run.ingested.keys(), ...run.bodied];
  const fresh = ids.length
    ? run
        .q(
          'SELECT DISTINCT thread_id AS id FROM messages WHERE id IN (SELECT value FROM json_each(?)) ORDER BY 1',
        )
        .all<{ id: number }>(JSON.stringify(ids))
        .map(r => r.id)
    : [];
  return [...new Set([...fresh, ...unrankedThreads(run)])];
}

/** Threads ranked per commit while mail that synced before `laneFor` was wired is caught up. */
const BACKFILL_BATCH = 100;
const BACKFILL_KEY = 'lane_backfill';
const BACKFILL_START = 'n:9007199254740991:9007199254740991';

/**
 * The next batch of threads that were stored before `laneFor` ran (they still hold the schema default lane). The walk
 * keeps its place in `meta`: first the threads Home can show, newest first (`n:<last_date>:<id>`), so the first commit
 * fixes the top of Home; then everything else by thread id (`a:<id>`); then `done`. A batch rides on an ordinary sync
 * commit, so a big mailbox never stalls start-up, and once the walk ends later commits pay one lookup.
 */
function unrankedThreads(run: CommitRun): number[] {
  // Only a sync commit carries a batch: never the owner's own action (an archive must stay quick), nor an import,
  // a system commit or an AI executor commit.
  if (run.input.origin !== 'sync') return [];
  const mark = run.q('SELECT value FROM meta WHERE key = ?').get<{ value: string }>(BACKFILL_KEY);
  if (mark?.value === 'done') return [];
  // A marker this code did not write (a newer or damaged format) restarts the walk, never ends it unseen.
  const known = mark !== undefined && /^(n:\d+:\d+|a:\d+)$/.test(mark.value);
  const [phase, x = '0', y = '0'] = (known ? mark.value : BACKFILL_START).split(':');
  const newest = phase === 'n';
  const ids = run
    .q(
      newest
        ? `SELECT thread_id AS id, last_date AS d FROM thread_workflow WHERE status = 'new' AND ranked_at IS NULL
          AND (last_date < ?1 OR (last_date = ?1 AND thread_id < ?2)) ORDER BY last_date DESC, thread_id DESC LIMIT ?3`
        : `SELECT thread_id AS id, last_date AS d FROM thread_workflow WHERE thread_id > ?1 AND ranked_at IS NULL
          ORDER BY thread_id LIMIT ?3`,
    )
    .all<{ id: number; d: number }>(Number(x), Number(y), BACKFILL_BATCH);
  const last = ids[ids.length - 1];
  const full = ids.length === BACKFILL_BATCH && last !== undefined;
  const next = full
    ? `${phase}:${newest ? `${last.d}:${last.id}` : last.id}`
    : newest
      ? 'a:0'
      : 'done';
  run
    .q(
      'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(BACKFILL_KEY, next);
  return ids.map(r => r.id);
}

interface WorkflowRow {
  account_id: string;
  remote_id: string;
  lane: string;
  importance: string;
  rank_source: string;
  due_date: string | null;
  due_source: string | null;
  [k: string]: string | number | null;
}

/** Runs `laneFor` for one thread and stores it over a heuristic rank only (ARCH 8.2: ai, rule and user win). */
function rankThread(run: CommitRun, threadId: number, laneFor: LaneFor) {
  const wf = run
    .q(
      `SELECT t.account_id, t.remote_id, w.lane, w.importance, w.rank_source, w.due_date, w.due_source
      FROM threads t JOIN thread_workflow w ON w.thread_id = t.id WHERE t.id = ?`,
    )
    .get<WorkflowRow>(threadId);
  if (!wf || wf.rank_source !== 'heuristic') return;
  const input = laneInput(run, threadId, wf.account_id);
  if (!input) return;
  const result = safeLane(laneFor, input);
  if (!result) return;
  const due =
    result.due && (wf.due_source === null || wf.due_source === 'structured')
      ? result.due
      : undefined;
  const same =
    result.lane === wf.lane &&
    result.importance === wf.importance &&
    (due === undefined || due === wf.due_date);
  if (same) {
    // Evaluated and unchanged: stamp it, so the back-fill does not pick it again and "never ranked" stays meaningful.
    run.q('UPDATE thread_workflow SET ranked_at = ? WHERE thread_id = ?').run(run.now(), threadId);
    return;
  }
  run
    .q(
      `UPDATE thread_workflow SET lane = ?, importance = ?, ranked_at = ?,
        due_date = coalesce(?, due_date), due_source = CASE WHEN ? IS NULL THEN due_source ELSE 'structured' END
      WHERE thread_id = ?`,
    )
    .run(result.lane, result.importance, run.now(), due ?? null, due ?? null, threadId);
  run.q('UPDATE threads SET rev = ? WHERE id = ?').run(run.seq, threadId);
  run.mark('Thread', wf.account_id, wf.remote_id, 'u');
}

/** A `laneFor` bug must not stop mail arriving: a throw or an out-of-range answer keeps the stored rank. */
function safeLane(laneFor: LaneFor, input: LaneInput): LaneResult | undefined {
  let result: LaneResult;
  try {
    result = laneFor(input);
  } catch {
    return undefined;
  }
  if (!result || !LANES.has(result.lane) || !IMPORTANCE.has(result.importance)) return undefined;
  if (result.due !== undefined && !DAY.test(result.due)) return { ...result, due: undefined };
  return result;
}

interface LaneRow {
  id: number;
  from_addr: string | null;
  from_name: string | null;
  to_json: string | null;
  cc_json: string | null;
  subject: string | null;
  snippet: string | null;
  date: number;
  internet_id: string | null;
  flags: number;
  hdr: number;
  parts: number;
  list_unsub: string | null;
  list_auth: number | null;
  [k: string]: string | number | null;
}

/** `LaneInput` for a thread from its newest inbound message; undefined when the owner wrote every message. */
export function laneInput(
  run: CommitRun,
  threadId: number,
  accountId: string,
): LaneInput | undefined {
  const m = run
    .q(
      `SELECT id, from_addr, from_name, to_json, cc_json, subject, snippet, date, internet_id, flags, hdr, parts, list_unsub,
      list_auth
      FROM messages WHERE thread_id = ? AND (flags & ${FLAG.draft | FLAG.fromMe}) = 0
      ORDER BY internal_date DESC, id DESC LIMIT 1`,
    )
    .get<LaneRow>(threadId);
  if (!m) return undefined;
  const self = run
    .q('SELECT address FROM accounts WHERE id = ?')
    .get<{ address: string }>(accountId);
  const mine = run
    .q(
      `SELECT max((flags & ${FLAG.fromMe}) <> 0) AS replied,
        (SELECT (flags & ${FLAG.fromMe}) <> 0 FROM messages WHERE thread_id = ?1 AND (flags & ${FLAG.draft}) = 0
          ORDER BY internal_date DESC, id DESC LIMIT 1) AS ended
      FROM messages WHERE thread_id = ?1 AND (flags & ${FLAG.draft}) = 0`,
    )
    .get<{ replied: number | null; ended: number | null }>(threadId);
  const known = m.from_addr
    ? run
        .q('SELECT sent_to FROM correspondents WHERE account_id = ? AND address = ?')
        .get<{ sent_to: number }>(accountId, normalAddress(m.from_addr))
    : undefined;
  return {
    message: laneMessage(run, m),
    self: self ? [normalAddress(self.address)] : [],
    knownCorrespondent: (known?.sent_to ?? 0) > 0,
    userReplied: Boolean(mine?.replied),
    userEndedThread: Boolean(mine?.ended),
    text: bodyText(run, m),
  };
}

function laneMessage(run: CommitRun, m: LaneRow): LaneMessage {
  const roles = run
    .q(
      `SELECT DISTINCT f.role FROM message_folders mf JOIN folders f ON f.id = mf.folder_id
      WHERE mf.message_id = ? AND f.role IS NOT NULL ORDER BY f.role`,
    )
    .all<{ role: FolderRole }>(m.id)
    .map(r => r.role);
  return {
    from: m.from_addr ? { address: m.from_addr, name: m.from_name ?? undefined } : undefined,
    to: JSON.parse(m.to_json ?? '[]'),
    cc: JSON.parse(m.cc_json ?? '[]'),
    subject: m.subject ?? undefined,
    date: m.date,
    internetId: m.internet_id ?? undefined,
    list: listHeaders(m.hdr, m.list_unsub, m.list_auth),
    snippet: m.snippet ?? undefined,
    flags: {
      seen: (m.flags & FLAG.seen) !== 0,
      flagged: (m.flags & FLAG.flagged) !== 0,
      answered: (m.flags & FLAG.answered) !== 0,
      draft: false,
      fromMe: false,
    },
    roles,
  };
}

/** `ListHeaders` rebuilt from the stored bits (see `STORED_HEADER`); `listAuth` is `messages.list_auth`. */
export function listHeaders(
  hdr: number,
  listUnsub: string | null,
  listAuth: number | null = null,
): ListHeaders {
  const unsub = listUnsub
    ? (JSON.parse(listUnsub) as { urls?: string[]; oneClick?: boolean })
    : undefined;
  const urls = unsub?.urls ?? [];
  return {
    listUnsubscribe: urls.length ? urls.map(u => `<${u}>`).join(', ') : undefined,
    listUnsubscribePost: unsub?.oneClick ? 'List-Unsubscribe=One-Click' : undefined,
    listId: hdr & HDR.list ? STORED_HEADER.listId : undefined,
    precedence: hdr & HDR.bulk ? STORED_HEADER.precedence : undefined,
    autoSubmitted: hdr & HDR.autoSubmitted ? STORED_HEADER.autoSubmitted : undefined,
    ...(listAuth === 1 || listAuth === 0 ? { authenticated: listAuth === 1 } : {}),
  };
}

/** The stored body's text, capped; undefined when no text part is stored. */
function bodyText(run: CommitRun, m: LaneRow): string | undefined {
  if (!(m.parts & PART.text)) return undefined;
  const row = run
    .q('SELECT codec, data FROM bodies WHERE message_id = ?')
    .get<{ codec: number; data: Uint8Array }>(m.id);
  if (!row) return undefined;
  // Only the decode is forgiven (a missing codec or a corrupt row gives up the text); the SQL read above must fail loudly.
  try {
    return decodeBody(row, run.ctx.bodyCodec).text?.slice(0, LANE_TEXT_CAP);
  } catch {
    return undefined;
  }
}

interface IngestRow {
  id: number;
  account_id: string;
  remote_id: string;
  thread: string;
  origin: string;
  internal_date: number;
  flags: number;
  folders: string;
  roles: string;
  [k: string]: string | number;
}

/** The batch the lanes' hooks see: messages a `message` write stored, still present, rowid order. */
function ingestedMessages(run: CommitRun): IngestedMessage[] {
  const rows = run
    .q(
      `SELECT m.id, m.account_id, m.remote_id, t.remote_id AS thread, m.origin, m.internal_date, m.flags,
        (SELECT json_group_array(remote_id) FROM (SELECT f.remote_id FROM message_folders mf JOIN folders f ON f.id = mf.folder_id
          WHERE mf.message_id = m.id ORDER BY f.remote_id)) AS folders,
        (SELECT json_group_array(role) FROM (SELECT DISTINCT f.role FROM message_folders mf JOIN folders f ON f.id = mf.folder_id
          WHERE mf.message_id = m.id AND f.role IS NOT NULL ORDER BY f.role)) AS roles
      FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id IN (SELECT value FROM json_each(?)) ORDER BY m.id`,
    )
    .all<IngestRow>(JSON.stringify([...run.ingested.keys()]));
  return rows.map(r => ({
    accountId: r.account_id,
    remoteId: r.remote_id,
    remoteThreadId: r.thread,
    rowId: r.id,
    added: run.ingested.get(r.id) === true,
    origin: r.origin as IngestedMessage['origin'],
    internalDate: r.internal_date,
    flags: {
      seen: (r.flags & FLAG.seen) !== 0,
      flagged: (r.flags & FLAG.flagged) !== 0,
      answered: (r.flags & FLAG.answered) !== 0,
      draft: (r.flags & FLAG.draft) !== 0,
      fromMe: (r.flags & FLAG.fromMe) !== 0,
    },
    folders: JSON.parse(r.folders) as string[],
    roles: JSON.parse(r.roles) as FolderRole[],
  }));
}
