import type { ViewSpec } from '@aplos/contract';
import type { SqlValue, StoreReader } from '../store';

/*
 * Compiled views (views-1). A view spec compiles to a `ViewPlan`: ordered sections, each a list of runs, each run one
 * or more keyset cursors over an index, merged in a shared order. The window engine (views-2) pages through a plan
 * with `rows` and `locate`; the SQL never uses OFFSET. Everything reads through one `StoreReader`, so a page, its
 * counts and its sections come from one snapshot when called inside one `store.read`.
 */

/** The row types a window can hold (the contract's `RowType`). */
export type RowType =
  'Thread' | 'Message' | 'Draft' | 'Submission' | 'Event' | 'Plan' | 'Conversation' | 'SenderGroup';

/** What a plan needs besides the database: the clock, the owner's time zone and the Follow up period. */
export interface ViewEnv {
  now: number;
  /** IANA time zone for local days (Later groups, search dates). */
  zone: string;
  /** `mail.followUpDays` from Settings. */
  followUpDays: number;
}

/** One ordering column of a cursor. `expr` is SQL over the cursor's tables and never NULL for a row it returns. */
export interface KeyCol {
  expr: string;
  desc?: boolean;
}

/**
 * One index-ordered query. Rows come back ordered by `key`; the last key column is unique within the cursor, so a key
 * is a position. Keyset paging splits "after this key" into one index seek per key column (no OR, no OFFSET).
 */
export interface CursorDef {
  /** `FROM` clause with joins the `where` needs, e.g. `thread_workflow w`. */
  from: string;
  /**
   * The index pages and counts must use (`INDEXED BY`), where the planner would otherwise pick an index that serves the
   * ORDER BY and filter the whole table through it. Lookups by `rowid` never use it.
   */
  index?: string;
  /** Predicates, ANDed. Each `?` is bound from `params` in order. */
  where: string[];
  params: SqlValue[];
  key: KeyCol[];
  /** The contract id of a row, SQL over `from` plus `join`. */
  id: string;
  /** Joins only the id needs (kept out of counts). */
  join?: string;
  /** The internal row id `locate` matches (`w.thread_id`, `tf.thread_id`, `m.id`, `d.id`). */
  rowid: string;
}

/** Several cursors read as one sequence in the order of their shared key (several accounts, folders or bands). */
export interface Run {
  cursors: CursorDef[];
}

export interface SectionPlan {
  /** The `WindowSection.key`; `''` for an ungrouped view (no section is reported). */
  key: string;
  label?: string;
  runs: Run[];
  /** Counted and reported, but its rows are not in the view (Home's Low band). */
  countOnly?: boolean;
  /** Up to three sender names for a count-only band. */
  senders?: (q: StoreReader) => string[];
}

export interface Statement {
  sql: string;
  params: SqlValue[];
}

/** Where a row sits: the run (flattened over sections) and its key in that run. */
export interface ViewPoint {
  part: number;
  key: SqlValue[];
}
export interface ViewRow {
  id: string;
  at: ViewPoint;
}
export interface LayoutSection {
  key: string;
  label?: string;
  start: number;
  count: number;
  senders?: string[];
}
export interface ViewLayout {
  /** Rows in the view, count-only sections excluded. */
  total: number;
  /** Non-empty sections in order; empty for an ungrouped view. */
  sections: LayoutSection[];
}

/** A compiled view, ready to be read any number of times (each read sees the database as it is then). */
export interface ViewPlan {
  kind: string;
  rowType: RowType;
  layout(q: StoreReader): ViewLayout;
  /** Up to `limit` rows in view order, from the start or strictly after `after`. */
  rows(q: StoreReader, after: ViewPoint | undefined, limit: number): ViewRow[];
  /** The row's index in the view and its point, or undefined when the row is not in the view. */
  locate(q: StoreReader, id: string): { index: number; at: ViewPoint } | undefined;
  /** Every SQL statement shape the plan runs, with sample parameters, for EXPLAIN assertions (store-7's gate). */
  statements(q: StoreReader): Statement[];
}

/** Compiles one spec kind. Thrown `ContractError`s (`notFound`, `rangeTooLarge`) reach the caller unchanged. */
export type ViewCompiler<S extends { kind: string } = ViewSpec> = (
  spec: S,
  env: ViewEnv,
) => ViewPlan;

/** Hard ceiling on rows a materialized view (search, sender groups) reads. */
export const MATERIALIZED_LIMIT = 5_000;
