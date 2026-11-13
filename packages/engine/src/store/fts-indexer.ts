import type { EngineServices } from '../runtime/services';
import { decodeBody } from './bodies';
import { PART, type CommitRun } from './commit';
import { installIndexer } from './fts';

/** Most backlog messages one `ftsIndex` write indexes. */
export const FTS_BATCH = 200;

/*
 * The lazy half of the search index (`store/fts.ts` holds the always-loaded half): what one index row is made of and
 * the start-up pass that walks the backlog. `views/module.ts` loads this file on start, so the engine core bundle does
 * not carry it; importing it installs the row builder for every commit.
 */

/** Body text indexed per message: the first 16 KB (ARCH 3.4). */
export const FTS_BODY_CAP = 16_384;

type IndexRow = {
  id: number;
  subject: string | null;
  snippet: string | null;
  from_addr: string | null;
  from_name: string | null;
  to_json: string | null;
  cc_json: string | null;
  bcc_json: string | null;
  codec: number | null;
  data: Uint8Array | null;
};

/** Names and addresses of a stored address list (`to_json` and the like); a damaged list adds nothing. */
function addresses(json: string | null): string[] {
  try {
    const list: unknown = JSON.parse(json ?? '[]');
    if (!Array.isArray(list)) return [];
    return list.flatMap((a: { name?: unknown; address?: unknown }) =>
      [a?.name, a?.address].filter((v): v is string => typeof v === 'string'),
    );
  } catch {
    return [];
  }
}

/** HTML read for the index: four times the body cap, so stripping never walks a multi-megabyte body (fix-search review). */
export const FTS_HTML_SCAN = FTS_BODY_CAP * 4;
const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  amp: '&',
};

/**
 * Visible text of an HTML body, in one left-to-right pass of `indexOf` (no backtracking regex, which took minutes on
 * 100 KB of `<` inside the commit): tags become spaces, style and script lose their content, and an unclosed tag or
 * element ends the text. Only the first `FTS_HTML_SCAN` characters are read.
 */
export function htmlText(source: string): string {
  const html = source.slice(0, FTS_HTML_SCAN);
  const lower = html.toLowerCase();
  let out = '';
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open < 0) {
      out += html.slice(at);
      break;
    }
    out += `${html.slice(at, open)} `;
    const close = html.indexOf('>', open);
    if (close < 0) break;
    at = close + 1;
    const raw = /^<(style|script)\b/.exec(lower.slice(open, open + 8))?.[1];
    if (raw === undefined) continue;
    const end = lower.indexOf(`</${raw}`, at);
    const after = end < 0 ? -1 : lower.indexOf('>', end);
    if (after < 0) break;
    at = after + 1;
  }
  return out.replace(
    /&(nbsp|lt|gt|quot|#39|amp);/gi,
    (m, name: string) => ENTITIES[name.toLowerCase()] ?? m,
  );
}

/** The stored body's text (plain, else the HTML's), or the snippet when there is no body or it cannot be read. */
function bodyText(run: CommitRun, row: IndexRow): string {
  let text: string | undefined;
  if (row.data !== null && row.codec !== null) {
    try {
      const body = decodeBody({ codec: row.codec, data: row.data }, run.ctx.bodyCodec);
      text = body.text ?? (body.html === undefined ? undefined : htmlText(body.html));
    } catch {
      // An unreadable body is still searchable by its snippet.
    }
  }
  return (text ?? row.snippet ?? '').slice(0, FTS_BODY_CAP);
}

/** Indexes one message unless its row is already current; true when it wrote a row. */
function indexOne(run: CommitRun, id: number): boolean {
  const row = run
    .q(
      `SELECT m.id, m.subject, m.snippet, m.from_addr, m.from_name, m.to_json, m.cc_json, m.bcc_json, b.codec, b.data
      FROM messages m LEFT JOIN bodies b ON b.message_id = m.id
      WHERE m.id = ? AND (m.parts & ${PART.fts}) = 0`,
    )
    .get<IndexRow>(id);
  if (!row) return false;
  const people = [row.from_name, row.from_addr]
    .filter((v): v is string => typeof v === 'string')
    .concat(addresses(row.to_json), addresses(row.cc_json), addresses(row.bcc_json));
  run
    .q('INSERT INTO messages_fts(rowid, subject, people, body) VALUES(?, ?, ?, ?)')
    .run(row.id, row.subject ?? '', people.join(' '), bodyText(run, row));
  run.q(`UPDATE messages SET parts = parts | ${PART.fts} WHERE id = ?`).run(row.id);
  return true;
}

let report: EngineServices['log'] | undefined;
let reported = false;

/**
 * One message, isolated in a savepoint: a row that cannot be built or written is rolled back with its bit left clear (the
 * next start's backlog pass tries it again) and never fails the sync or body commit it belongs to. The first failure
 * after each engine start is logged, as a reason code only (a broken index would otherwise log on every commit).
 */
function indexSafely(run: CommitRun, id: number): boolean {
  const db = run.ctx.db;
  db.exec('SAVEPOINT fts_row');
  try {
    const wrote = indexOne(run, id);
    db.exec('RELEASE fts_row');
    return wrote;
  } catch {
    db.exec('ROLLBACK TO fts_row');
    db.exec('RELEASE fts_row');
    if (report && !reported) {
      report.event('rpc.failed', { method: 'Search/index', reason: 'row' });
      reported = true;
    }
    return false;
  }
}

installIndexer({
  written(run) {
    for (const id of new Set([...run.ingested.keys(), ...run.bodied])) indexSafely(run, id);
  },
  backlog(run, ids) {
    const marked = new Set<number>();
    for (const id of ids) {
      if (!indexSafely(run, id)) continue;
      const t = run
        .q(
          'SELECT t.id, t.account_id AS acct, t.remote_id AS remote FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = ?',
        )
        .get<{ id: number; acct: string; remote: string }>(id);
      if (!t || marked.has(t.id)) continue;
      marked.add(t.id);
      run.q('UPDATE threads SET rev = ? WHERE id = ?').run(run.seq, t.id);
      run.mark('Thread', t.acct, t.remote, 'u');
    }
  },
});

/**
 * Mail stored before the index existed (or before this loaded) is indexed here at start, a batch per commit with a
 * yield between, so a big backlog never holds the engine. Idempotent: an indexed message is skipped, and a store with
 * no backlog costs one read.
 */
export async function indexBacklog(services: EngineServices, signal: AbortSignal) {
  report = services.log;
  reported = false;
  const id = () =>
    `fts:${Array.from(services.randomBytes(8), b => b.toString(16).padStart(2, '0')).join('')}`;
  // Keyset paging, newest first, through the partial index `messages_unindexed`: a row that fails stays unindexed but
  // is passed, so it can never hold the pass in place.
  let below = Number.MAX_SAFE_INTEGER;
  try {
    while (!signal.aborted) {
      const ids = services.store.read(q =>
        q
          .all<{ id: number }>(
            `SELECT id FROM messages WHERE (parts & ${PART.fts}) = 0 AND id < ? ORDER BY id DESC LIMIT ${FTS_BATCH}`,
            below,
          )
          .map(r => r.id),
      );
      if (ids.length === 0) return;
      below = ids[ids.length - 1];
      services.store.commit({ opId: id(), origin: 'system', writes: [{ kind: 'ftsIndex', ids }] });
      await services.clock.sleep(0, signal);
    }
  } catch {
    if (!signal.aborted)
      services.log.event('rpc.failed', { method: 'Search/index', reason: 'backlog' });
  }
}
