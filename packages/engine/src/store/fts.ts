import { PART, type CommitRun } from './commit';
import type { SqlValue } from './sql';

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
  /** `ftsIndex`: a batch of backlog messages, their threads marked so open search windows run again. */
  backlog(run: CommitRun): void;
}
let indexer: SearchIndexer | undefined;
export function installIndexer(installed: SearchIndexer) {
  indexer = installed;
}

/** End of every commit: the messages and bodies it wrote are indexed. */
export function indexWritten(run: CommitRun) {
  indexer?.written(run);
}

/** A write with no backlog (or no indexer yet) changes nothing. */
export function ftsIndex(run: CommitRun) {
  indexer?.backlog(run);
}

/**
 * Before a message write replaces an indexed row's fields: when subject, snippet or people change, the stale row and
 * its bit go (contentless rows cannot be updated), and the write is indexed again by `indexWritten`. `fields` are the
 * new values, in `json_array` order. Runs even before the indexer loads: an old session's row must not stay stale.
 */
export function dropIfChanged(run: CommitRun, id: number, fields: SqlValue[]) {
  const dropped = run
    .q(
      `UPDATE messages SET parts = parts & ~${PART.fts} WHERE id = ? AND (parts & ${PART.fts}) <> 0
      AND json_array(subject, snippet, from_addr, from_name, to_json, cc_json, bcc_json) IS NOT
        json_array(?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ...fields).changes;
  if (dropped) run.q('DELETE FROM messages_fts WHERE rowid = ?').run(id);
}
