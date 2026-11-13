import { PART, type CommitRun } from './commit';
import type { FtsIndexWrite } from './port';

/*
 * The search index (ARCH 3.4): one contentless FTS5 row per message, rowid = `messages.id`, and `parts` bit 8 says the
 * row is there and current. This file is the always-loaded half: it drops stale rows and forwards each commit's writes
 * and the backlog passes to the indexer. The indexer (`fts-indexer.ts`) loads on engine start (`import()` from
 * `views/module.ts`, so it stays out of the core bundle) and installs itself below. A message committed before that
 * load has no bit, so it is simply backlog the first `ftsIndex` batches pick up; a stale row is still dropped here.
 */

/** The row builder and backlog walker, installed by `store/fts-indexer` when it loads. */
export interface SearchIndexer {
  /** Index the messages and bodies a commit wrote. */
  written(run: CommitRun): void;
  /** `ftsIndex`: these backlog messages, their threads marked so open search windows run again. */
  backlog(run: CommitRun, ids: readonly number[]): void;
}
let indexer: SearchIndexer | undefined;
export function installIndexer(installed: SearchIndexer) {
  indexer = installed;
}

/** End of every commit: the messages and bodies it wrote are indexed. */
export function indexWritten(run: CommitRun) {
  indexer?.written(run);
}

/** A write naming no unindexed message (or with no indexer yet) changes nothing. */
export function ftsIndex(run: CommitRun, w: FtsIndexWrite) {
  indexer?.backlog(run, Array.isArray(w.ids) ? w.ids : []);
}

/**
 * Wraps a message row's update: when subject, snippet or people changed, the indexed row and its bit go (contentless
 * rows cannot be updated) and `indexWritten` indexes the message again. Compares the row itself before and after, so
 * it does not depend on how the update lists its columns. Runs before the indexer loads too: no row may stay stale.
 */
export function keepIndexCurrent(run: CommitRun, id: number, update: () => void) {
  const indexed = `SELECT json_array(subject, snippet, from_addr, from_name, to_json, cc_json, bcc_json) AS v
    FROM messages WHERE id = ? AND (parts & ${PART.fts}) <> 0`;
  const before = run.q(indexed).get<{ v: string }>(id)?.v;
  update();
  if (before === undefined || run.q(indexed).get<{ v: string }>(id)?.v === before) return;
  run.q(`UPDATE messages SET parts = parts & ~${PART.fts} WHERE id = ?`).run(id);
  run.q('DELETE FROM messages_fts WHERE rowid = ?').run(id);
}
