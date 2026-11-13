import type { EngineServices } from '../runtime/services';
import { decodeBody } from './bodies';
import { PART, type CommitRun } from './commit';
import { installIndexer } from './fts';

/** Most backlog messages one `ftsIndex` write indexes. */
export const FTS_BATCH = 500;

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

/** Visible text of an HTML body: no style or script, no tags, the common entities decoded. */
function htmlText(html: string): string {
  return html
    .replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');
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

installIndexer({
  written(run) {
    for (const id of new Set([...run.ingested.keys(), ...run.bodied])) indexOne(run, id);
  },
  backlog(run) {
    const rows = run
      .q(
        `SELECT m.id, t.account_id AS acct, t.remote_id AS remote, t.id AS tid FROM messages m
        JOIN threads t ON t.id = m.thread_id
        WHERE (m.parts & ${PART.fts}) = 0 ORDER BY m.id DESC LIMIT ${FTS_BATCH}`,
      )
      .all<{ id: number; acct: string; remote: string; tid: number }>();
    for (const r of rows) {
      if (!indexOne(run, r.id)) continue;
      run.q('UPDATE threads SET rev = ? WHERE id = ?').run(run.seq, r.tid);
      run.mark('Thread', r.acct, r.remote, 'u');
    }
  },
});

/**
 * Mail stored before the index existed (or before this loaded) is indexed here at start, a batch per commit with a
 * yield between, so a big backlog never holds the engine. Idempotent: an indexed message is skipped, and a store with
 * no backlog costs one empty commit.
 */
export async function indexBacklog(services: EngineServices, signal: AbortSignal) {
  const id = () =>
    `fts:${Array.from(services.randomBytes(8), b => b.toString(16).padStart(2, '0')).join('')}`;
  try {
    while (!signal.aborted) {
      const done = services.store.commit({
        opId: id(),
        origin: 'system',
        writes: [{ kind: 'ftsIndex' }],
      });
      if (done.changed === 0) return;
      await services.clock.sleep(0, signal);
    }
  } catch {
    if (!signal.aborted)
      services.log.event('rpc.failed', { method: 'Search/index', reason: 'backlog' });
  }
}
