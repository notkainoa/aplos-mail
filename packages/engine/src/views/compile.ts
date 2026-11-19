import type { SqlRow, SqlValue, StoreReader } from '../store';
import type {
  CursorDef,
  KeyCol,
  LayoutSection,
  RowType,
  Run,
  SectionPlan,
  Statement,
  ViewLayout,
  ViewPlan,
  ViewPoint,
  ViewRow,
} from './specs';

/*
 * The keyset machinery every built-in view shares (views-1). A cursor is one index-ordered query; "after key K" is
 * split into one seek per key column, run in order until the page is full, so every query is an index range and no
 * query uses OFFSET or an OR the planner would turn into a scan.
 */

const source = (c: CursorDef) => (c.index ? `${c.from} INDEXED BY ${c.index}` : c.from);
const orderBy = (key: KeyCol[]) => key.map(k => k.expr + (k.desc ? ' DESC' : '')).join(', ');
const whereOf = (preds: string[]) => (preds.length ? preds.join(' AND ') : '1');

/** The page query of `c` with extra predicates; parameters are the cursor's, then `extra`'s, then the limit. */
function pageSql(c: CursorDef, extra: string[]): string {
  const cols = c.key.map((k, i) => `${k.expr} AS k${i}`).join(', ');
  const join = c.join ? ` ${c.join}` : '';
  return `SELECT ${c.id} AS id, ${cols} FROM ${source(c)}${join} WHERE ${whereOf([...c.where, ...extra])} ORDER BY ${orderBy(c.key)} LIMIT ?`;
}

function countSql(c: CursorDef, extra: string[]): string {
  return `SELECT count(*) AS n FROM ${source(c)} WHERE ${whereOf([...c.where, ...extra])}`;
}

/**
 * The disjoint ranges strictly after (`side` 1) or before (`side` -1) `key`, nearest first: equal on the first i
 * columns and past `key` on column i, for i from the last column down to the first.
 */
function ranges(
  c: CursorDef,
  key: SqlValue[],
  side: 1 | -1,
): { extra: string[]; params: SqlValue[] }[] {
  const out = [];
  for (let i = c.key.length - 1; i >= 0; i--) {
    const col = c.key[i];
    const forward = (side === 1) !== !!col.desc;
    const extra = c.key.slice(0, i).map(k => `${k.expr} = ?`);
    extra.push(`${col.expr} ${forward ? '>' : '<'} ?`);
    out.push({ extra, params: key.slice(0, i + 1) });
  }
  return out;
}

const keyOfRow = (c: CursorDef, row: SqlRow) => c.key.map((_, i) => row[`k${i}`]);

/** Up to `limit` rows of one cursor, after `after` when given. */
export function cursorRows(
  q: StoreReader,
  c: CursorDef,
  after: SqlValue[] | undefined,
  limit: number,
) {
  const parts = after ? ranges(c, after, 1) : [{ extra: [], params: [] }];
  const out: { id: string; key: SqlValue[] }[] = [];
  for (const part of parts) {
    if (out.length >= limit) break;
    for (const row of q.all(
      pageSql(c, part.extra),
      ...c.params,
      ...part.params,
      limit - out.length,
    ))
      out.push({ id: row.id as string, key: keyOfRow(c, row) });
  }
  return out;
}

export function cursorCount(q: StoreReader, c: CursorDef): number {
  return (q.get<{ n: number }>(countSql(c, []), ...c.params)?.n as number) ?? 0;
}

/** Rows of `c` that sort strictly before `key`. */
function cursorCountBefore(q: StoreReader, c: CursorDef, key: SqlValue[]): number {
  let n = 0;
  for (const part of ranges(c, key, -1))
    n += q.get<{ n: number }>(countSql(c, part.extra), ...c.params, ...part.params)?.n ?? 0;
  return n;
}

/** The key of internal row `rowid` in `c`, or undefined when the row is not in this cursor. */
function cursorKey(q: StoreReader, c: CursorDef, rowid: SqlValue): SqlValue[] | undefined {
  const cols = c.key.map((k, i) => `${k.expr} AS k${i}`).join(', ');
  const row = q.get(
    `SELECT ${cols} FROM ${c.from} WHERE ${whereOf([...c.where, `${c.rowid} = ?`])}`,
    ...c.params,
    rowid,
  );
  return row ? keyOfRow(c, row) : undefined;
}

export function compareKeys(key: KeyCol[], a: SqlValue[], b: SqlValue[]): number {
  for (let i = 0; i < key.length; i++) {
    const x = a[i],
      y = b[i];
    if (x === y) continue;
    const cmp = (x as number | string) < (y as number | string) ? -1 : 1;
    return key[i].desc ? -cmp : cmp;
  }
  return 0;
}

/** A run's rows: one cursor directly, several merged by their shared key (cursors of a run never share a row). */
function runRows(q: StoreReader, run: Run, after: SqlValue[] | undefined, limit: number) {
  if (run.cursors.length === 1) return cursorRows(q, run.cursors[0], after, limit);
  const key = run.cursors[0]?.key ?? [];
  return run.cursors
    .flatMap(c => cursorRows(q, c, after, limit))
    .sort((a, b) => compareKeys(key, a.key, b.key))
    .slice(0, limit);
}

const runCount = (q: StoreReader, run: Run) =>
  run.cursors.reduce((n, c) => n + cursorCount(q, c), 0);

export interface KeysetOptions {
  kind: string;
  rowType: RowType;
  /** Built at read time (folder and account lookups); the same spec always gives the same section and run shape. */
  sections: (q: StoreReader) => SectionPlan[];
  /** Contract id to the cursors' `rowid`; undefined when unknown. */
  resolve: (q: StoreReader, id: string) => SqlValue | undefined;
}

interface Part {
  section: SectionPlan;
  run: Run;
}
const partsOf = (sections: SectionPlan[]): Part[] =>
  sections.flatMap(section => section.runs.map(run => ({ section, run })));

/** A plan over keyset cursors. */
export function keysetPlan(o: KeysetOptions): ViewPlan {
  return {
    kind: o.kind,
    rowType: o.rowType,
    layout: q => keysetLayout(q, o.sections(q)),
    rows(q, after, limit) {
      const parts = partsOf(o.sections(q));
      const out: ViewRow[] = [];
      for (let p = after?.part ?? 0; p < parts.length && out.length < limit; p++) {
        if (parts[p].section.countOnly) continue;
        const from = after && p === after.part ? after.key : undefined;
        for (const r of runRows(q, parts[p].run, from, limit - out.length))
          out.push({ id: r.id, at: { part: p, key: r.key } });
      }
      return out;
    },
    locate(q, id) {
      const rowid = o.resolve(q, id);
      return rowid === undefined ? undefined : keysetLocate(q, partsOf(o.sections(q)), rowid);
    },
    statements: q => keysetStatements(o.sections(q)),
  };
}

function keysetLayout(q: StoreReader, sections: SectionPlan[]): ViewLayout {
  const out: LayoutSection[] = [];
  let start = 0;
  for (const s of sections) {
    const count = s.runs.reduce((n, run) => n + runCount(q, run), 0);
    if (!count) continue;
    const entry: LayoutSection = { key: s.key, start, count };
    if (s.label !== undefined) entry.label = s.label;
    if (s.senders) entry.senders = s.senders(q);
    out.push(entry);
    if (!s.countOnly) start += count;
  }
  return { total: start, sections: out.filter(s => s.key !== '') };
}

function keysetLocate(q: StoreReader, parts: Part[], rowid: SqlValue) {
  let index = 0;
  for (let p = 0; p < parts.length; p++) {
    if (parts[p].section.countOnly) continue;
    const { cursors } = parts[p].run;
    for (const c of cursors) {
      const key = cursorKey(q, c, rowid);
      if (!key) continue;
      for (const other of cursors) index += cursorCountBefore(q, other, key);
      return { index, at: { part: p, key } };
    }
    index += runCount(q, parts[p].run);
  }
  return undefined;
}

/** Every statement shape a plan runs, with representative parameters, for EXPLAIN QUERY PLAN. */
function keysetStatements(sections: SectionPlan[]): Statement[] {
  const out: Statement[] = [];
  for (const c of partsOf(sections).flatMap(p => p.run.cursors)) {
    const probe = c.key.map(() => 0 as SqlValue);
    out.push({ sql: pageSql(c, []), params: [...c.params, 200] });
    out.push({ sql: countSql(c, []), params: c.params });
    for (const r of ranges(c, probe, 1))
      out.push({ sql: pageSql(c, r.extra), params: [...c.params, ...r.params, 200] });
  }
  return out;
}

// ------------------------------------------------------------ materialized views

export interface Materialized {
  ids: string[];
  sections: LayoutSection[];
}

/**
 * A plan for a bounded view computed whole (search results, sender groups, a thread's messages): at most
 * `MATERIALIZED_LIMIT` rows, sliced in memory. A point is the row's id and index, so a row that left resumes in place.
 */
export function materializedPlan(o: {
  kind: string;
  rowType: RowType;
  build: (q: StoreReader) => Materialized;
  statements: (q: StoreReader) => Statement[];
}): ViewPlan {
  return {
    kind: o.kind,
    rowType: o.rowType,
    layout(q) {
      const m = o.build(q);
      return { total: m.ids.length, sections: m.sections };
    },
    rows(q, after, limit) {
      const { ids } = o.build(q);
      const start = after ? resumeAt(ids, after) : 0;
      return ids
        .slice(start, start + limit)
        .map((id, i) => ({ id, at: { part: 0, key: [id, start + i] } }));
    },
    locate(q, id) {
      const index = o.build(q).ids.indexOf(id);
      return index < 0 ? undefined : { index, at: { part: 0, key: [id, index] } };
    },
    statements: o.statements,
  };
}

function resumeAt(ids: string[], after: ViewPoint): number {
  const [id, index] = after.key as [string, number];
  const found = ids.indexOf(id);
  return found >= 0 ? found + 1 : Math.min(Number(index) || 0, ids.length);
}

// ------------------------------------------------------------ shared SQL pieces

/** The contract id of the thread joined as `t`. */
export const THREAD_ID = "t.account_id || ':' || t.remote_id";

/**
 * The thread has a message that is not a draft, not a search-only copy and not in Trash or Spam (D8: one trashed reply
 * does not trash the conversation). The first test is the cheap common case: a folder list outside Trash and Spam
 * only ever holds such messages.
 */
export function visible(col: string): string {
  return `(EXISTS (SELECT 1 FROM thread_folders vx JOIN folders vf ON vf.id = vx.folder_id
    WHERE vx.thread_id = ${col} AND coalesce(vf.role, '') NOT IN ('trash', 'spam'))
  OR EXISTS (SELECT 1 FROM messages vm WHERE vm.thread_id = ${col} AND (vm.flags & 8) = 0 AND vm.origin <> 'search'
    AND NOT EXISTS (SELECT 1 FROM message_folders vmf JOIN folders vy ON vy.id = vmf.folder_id
      WHERE vmf.message_id = vm.id AND vy.role IN ('trash', 'spam'))))`;
}

/** Splits a contract id `accountId:remoteId` against the stored accounts (an account id may itself hold a colon). */
export function splitId(
  q: StoreReader,
  id: string,
  accounts?: readonly string[],
): { accountId: string; remoteId: string } | undefined {
  let best: string | undefined;
  const known = accounts ?? q.all<{ id: string }>('SELECT id FROM accounts').map(a => a.id);
  for (const a of known) if (id.startsWith(`${a}:`) && (!best || a.length > best.length)) best = a;
  return best === undefined ? undefined : { accountId: best, remoteId: id.slice(best.length + 1) };
}

export function threadRowId(q: StoreReader, id: string): number | undefined {
  const parts = splitId(q, id);
  if (!parts) return undefined;
  return q.get<{ id: number }>(
    'SELECT id FROM threads WHERE account_id = ? AND remote_id = ?',
    parts.accountId,
    parts.remoteId,
  )?.id;
}

/** Accounts a spec covers: the one named, or every account, in a stable order; never one being removed. */
export function accountIds(q: StoreReader, accountId?: string): string[] {
  return q
    .all<{ id: string }>(
      `SELECT id FROM accounts WHERE status <> 'removing'${accountId === undefined ? '' : ' AND id = ?'} ORDER BY id`,
      ...(accountId === undefined ? [] : [accountId]),
    )
    .map(r => r.id);
}

/** The account's first folder with `role` (one list per role, so a thread is never counted twice). */
export function roleFolder(q: StoreReader, accountId: string, role: string): number | undefined {
  return q.get<{ id: number }>(
    'SELECT id FROM folders WHERE account_id = ? AND role = ? ORDER BY id LIMIT 1',
    accountId,
    role,
  )?.id;
}
