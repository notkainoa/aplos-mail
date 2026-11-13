import type { SearchQuery, ViewSpec } from '@aplos/contract';
import type { SqlValue, StoreReader } from '../store';
import { keysetPlan, materializedPlan, threadRowId, visible } from './compile';
import {
  archiveRun,
  folderRowId,
  roleRun,
  statusRun,
  tfCursor,
  wfCursor,
  accountPred,
  type Pred,
} from './lists';
import { startOfDay } from './sections';
import { MATERIALIZED_LIMIT, type Run, type Statement, type ViewEnv, type ViewPlan } from './specs';

/*
 * Local search (views-1). Words and the `from:`, `to:` and `subject:` operators go to the contentless FTS index
 * (newest message first, rowid order), each word a quoted prefix phrase so no user text is FTS syntax; the operators
 * are then checked exactly on the matching messages. A query with only place, date and flag operators reads the place's
 * own list instead. Remote results join the window through views-2 (`Search/remote`).
 */

const ROLES = new Set(['inbox', 'sent', 'trash', 'spam', 'important']);
const ARCHIVE_PRED = `(EXISTS (SELECT 1 FROM thread_folders px JOIN folders pf ON pf.id = px.folder_id WHERE px.thread_id = %s AND pf.role = 'archive')
  OR (NOT EXISTS (SELECT 1 FROM folders af WHERE af.role = 'archive' AND af.account_id = (SELECT account_id FROM threads WHERE id = %s))
    AND NOT EXISTS (SELECT 1 FROM thread_folders ix JOIN folders xf ON xf.id = ix.folder_id WHERE ix.thread_id = %s AND xf.role = 'inbox')
    AND %v))`;
const FLAGGED = 'EXISTS (SELECT 1 FROM threads sf WHERE sf.id = %s AND sf.flagged = 1)';
/** A thread only a provider search found (`origin='search'` rows are in no list, so `visible` leaves them out). */
const SEARCH_HIT =
  "EXISTS (SELECT 1 FROM messages sm WHERE sm.thread_id = %s AND sm.origin = 'search' AND (sm.flags & 8) = 0 AND NOT EXISTS (SELECT 1 FROM message_folders smf JOIN folders sy ON sy.id = smf.folder_id WHERE smf.message_id = sm.id AND sy.role IN ('trash', 'spam')))";
const hasWordChar = /[\p{L}\p{N}]/u;

/** One FTS5 prefix phrase per word; a word without a letter or digit is dropped (it would match nothing). */
export function ftsPhrases(text: string | undefined): string[] {
  return (text ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .split(/\s+/)
    .filter(w => hasWordChar.test(w))
    .map(w => `"${w.replace(/"/g, '""')}"*`);
}

/** The FTS5 query for a search, or '' when it has no word operators. */
export function ftsQuery(query: SearchQuery): string {
  const parts = ftsPhrases(query.text);
  const column = (name: string, value?: string) => {
    for (const phrase of ftsPhrases(value)) parts.push(`${name} : ${phrase}`);
  };
  column('people', query.from);
  column('people', query.to);
  column('subject', query.subject);
  return parts.join(' ');
}

/** True when a text or word operator was given, even if it holds no searchable word. */
const hasWordOperator = (query: SearchQuery) =>
  [query.text, query.from, query.to, query.subject].some(v => (v ?? '').trim() !== '');

const like = (v: string) => `%${v.replace(/[\\%_]/g, c => `\\${c}`)}%`;

/** Exact message-level checks for the word operators (FTS `people` holds senders and recipients together). */
function messagePreds(query: SearchQuery): Pred[] {
  const out: Pred[] = [];
  if (query.from)
    out.push([
      "(m.from_addr LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\')",
      like(query.from),
      like(query.from),
    ]);
  if (query.to) out.push(["m.to_json LIKE ? ESCAPE '\\'", like(query.to)]);
  return out;
}

/**
 * Place: a folder role, `done`, `later` or a folder id. Without one (or `all`), Trash and Spam are left out and the
 * threads a provider search found are in.
 */
function placePred(q: StoreReader, place: string | undefined, col: string): Pred {
  if (place === undefined || place.toLowerCase() === 'all')
    return [`(${visible(col)} OR ${SEARCH_HIT.replace('%s', col)})`];
  const p = place.toLowerCase();
  // Starred is a flag at Gmail, not a folder.
  if (p === 'starred') return [FLAGGED.replace('%s', col)];
  if (p === 'done' || p === 'later')
    return [
      `EXISTS (SELECT 1 FROM thread_workflow pw WHERE pw.thread_id = ${col} AND pw.status = ?)`,
      p,
    ];
  if (p === 'archive') return [ARCHIVE_PRED.replace(/%s/g, col).replace('%v', visible(col))];
  if (ROLES.has(p))
    return [
      `EXISTS (SELECT 1 FROM thread_folders px JOIN folders pf ON pf.id = px.folder_id WHERE px.thread_id = ${col} AND pf.role = ?)`,
      p,
    ];
  return [
    `EXISTS (SELECT 1 FROM thread_folders px WHERE px.thread_id = ${col} AND px.folder_id = ?)`,
    folderRowId(q, place) ?? -1,
  ];
}

/** Thread-level operators: attachment, dates (local days in the owner's zone) and flags. */
function threadPreds(query: SearchQuery, env: ViewEnv, col: string): Pred[] {
  const out: Pred[] = [];
  const thread = (cond: string, ...params: SqlValue[]): Pred => [
    `EXISTS (SELECT 1 FROM threads st WHERE st.id = ${col} AND ${cond})`,
    ...params,
  ];
  if (query.hasAttachment !== undefined)
    out.push(thread('st.has_attach = ?', Number(query.hasAttachment)));
  if (query.before) out.push(thread('st.last_date < ?', startOfDay(query.before, env.zone)));
  if (query.after) out.push(thread('st.last_date >= ?', startOfDay(query.after, env.zone)));
  for (const flag of new Set(query.is ?? [])) {
    if (flag === 'unread') out.push(thread('st.unread_count > 0'));
    if (flag === 'read') out.push(thread('st.unread_count = 0'));
    if (flag === 'flagged') out.push(thread('st.flagged = 1'));
    if (flag === 'bookmarked')
      out.push([
        `EXISTS (SELECT 1 FROM thread_workflow bw WHERE bw.thread_id = ${col} AND bw.bookmarked = 1)`,
      ]);
  }
  return out;
}

type SearchSpec = Extract<ViewSpec, { kind: 'search' }>;

/** Word search: matching messages newest first, their threads newest first, at most `MATERIALIZED_LIMIT`. */
function ftsStatement(q: StoreReader, spec: SearchSpec, env: ViewEnv, match: string): Statement {
  const msg = messagePreds(spec.query);
  const thread: Pred[] = [
    ...(spec.accountId === undefined ? [] : [['t.account_id = ?', spec.accountId] as Pred]),
    placePred(q, spec.query.in, 't.id'),
    ...threadPreds(spec.query, env, 't.id'),
  ];
  // The place and flag filters sit inside the limited subquery, so a broad word never loses older matches to the cap.
  const where = ['messages_fts MATCH ?', ...msg.map(p => p[0]), ...thread.map(p => p[0])].join(
    ' AND ',
  );
  const sql = `SELECT t.account_id || ':' || t.remote_id AS id FROM threads t WHERE t.id IN (
    SELECT m.thread_id FROM messages_fts f CROSS JOIN messages m ON m.id = f.rowid CROSS JOIN threads t ON t.id = m.thread_id
    WHERE ${where} ORDER BY f.rowid DESC LIMIT ?) ORDER BY t.last_date DESC, t.id DESC LIMIT ?`;
  const params: SqlValue[] = [
    match,
    ...msg.flatMap(p => p.slice(1) as SqlValue[]),
    ...thread.flatMap(p => p.slice(1) as SqlValue[]),
    MATERIALIZED_LIMIT,
    MATERIALIZED_LIMIT,
  ];
  return { sql, params };
}

/** Operator-only search: the place's own list with the operators as filters. A named place includes Trash and Spam. */
function placeRun(q: StoreReader, spec: SearchSpec, env: ViewEnv): Run {
  const place = spec.query.in?.toLowerCase();
  const a = spec.accountId;
  if (place === 'done' || place === 'later')
    return {
      cursors: [
        wfCursor([
          ['w.status = ?', place],
          ...accountPred(a),
          ...threadPreds(spec.query, env, 'w.thread_id'),
        ]),
      ],
    };
  if (place === 'starred')
    return statusRun(
      [[FLAGGED.replace('%s', 'w.thread_id')], ...threadPreds(spec.query, env, 'w.thread_id')],
      a,
    );
  if (place === 'all')
    return statusRun([[visible('w.thread_id')], ...threadPreds(spec.query, env, 'w.thread_id')], a);
  if (place === 'archive') return archiveRun(q, a, col => threadPreds(spec.query, env, col));
  if (place !== undefined && ROLES.has(place))
    return roleRun(q, place, a, threadPreds(spec.query, env, 'tf.thread_id'));
  if (spec.query.in !== undefined) {
    const folder = folderRowId(q, spec.query.in);
    return {
      cursors:
        folder === undefined
          ? []
          : [
              tfCursor(folder, [
                ...(a === undefined
                  ? []
                  : [
                      [
                        'EXISTS (SELECT 1 FROM threads at WHERE at.id = tf.thread_id AND at.account_id = ?)',
                        a,
                      ] as Pred,
                    ]),
                ...threadPreds(spec.query, env, 'tf.thread_id'),
              ]),
            ],
    };
  }
  return statusRun([[visible('w.thread_id')], ...threadPreds(spec.query, env, 'w.thread_id')], a);
}

export function searchPlan(spec: SearchSpec, env: ViewEnv): ViewPlan {
  const match = ftsQuery(spec.query);
  if (!match)
    return keysetPlan({
      kind: 'search',
      rowType: 'Thread',
      // Words that were typed but reduce to nothing (punctuation only) match nothing, not everything.
      sections: q => [
        { key: '', runs: [hasWordOperator(spec.query) ? { cursors: [] } : placeRun(q, spec, env)] },
      ],
      resolve: threadRowId,
    });
  return materializedPlan({
    kind: 'search',
    rowType: 'Thread',
    build(q) {
      const s = ftsStatement(q, spec, env, match);
      return { ids: q.all<{ id: string }>(s.sql, ...s.params).map(r => r.id), sections: [] };
    },
    statements: q => [ftsStatement(q, spec, env, match)],
  });
}
