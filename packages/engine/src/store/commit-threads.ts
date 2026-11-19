import type { SqlValue } from './sql';
import {
  StoreError,
  type ThreadDeleteWrite,
  type ThreadMergeWrite,
  type ThreadWrite,
  type WorkflowFields,
  type WorkflowWrite,
} from './port';
import { PART, MESSAGE_COLS, type CommitRun, type MessageRow } from './commit';

// ------------------------------------------------------------ threads and workflow

const WORKFLOW_COLUMNS: Record<keyof WorkflowFields, string> = {
  status: 'status',
  laterUntil: 'later_until',
  dueDate: 'due_date',
  dueSource: 'due_source',
  reminderAt: 'reminder_at',
  reminderFiredAt: 'reminder_fired_at',
  bookmarked: 'bookmarked',
  replyStatus: 'reply_status',
  todo: 'todo',
  hiddenFromHome: 'hidden_from_home',
  lane: 'lane',
  importance: 'importance',
  rankSource: 'rank_source',
  rankedAt: 'ranked_at',
  dueBand: 'due_band',
  editedAt: 'edited_at',
  editDevice: 'edit_device',
  editGen: 'edit_gen',
};

export function thread(run: CommitRun, w: ThreadWrite) {
  const row = run.q('SELECT id FROM threads WHERE account_id = ? AND remote_id = ?').get<{
    id: number;
  }>(w.accountId, w.remoteThreadId);
  if (!row) return run.missing(`Thread ${w.remoteThreadId}`);
  if (w.complete !== undefined)
    run.q('UPDATE threads SET complete = ? WHERE id = ?').run(Number(w.complete), row.id);
  if (w.remoteCount !== undefined)
    run.q('UPDATE threads SET remote_count = ? WHERE id = ?').run(w.remoteCount, row.id);
  run.touched.add(row.id);
}

export function threadDelete(run: CommitRun, w: ThreadDeleteWrite) {
  const row = run.q('SELECT id FROM threads WHERE account_id = ? AND remote_id = ?').get<{
    id: number;
  }>(w.accountId, w.remoteThreadId);
  if (!row) return;
  for (const m of run.q('SELECT id, remote_id, parts FROM messages WHERE thread_id = ?').all<{
    id: number;
    remote_id: string;
    parts: number;
  }>(row.id)) {
    if (m.parts & PART.fts) run.q('DELETE FROM messages_fts WHERE rowid = ?').run(m.id);
    run.mark('Message', w.accountId, m.remote_id, 'd');
  }
  run.markListChanges(run.lists(row.id), new Map());
  // The thread's plans cascade with it; a `*` row re-reads the account's plans (coarser than per-row
  // marks, correct — the deleted thread's plans answer notFound).
  run.markId('Plan', w.accountId, '*');
  // `replydraft:<wire>` and `followup:<wire>[:<hash>]` both belong to this thread.
  const base = `${w.accountId}:${w.remoteThreadId}`;
  run
    .q('DELETE FROM meta WHERE key IN (?, ?, ?) OR substr(key, 1, ?) = ?')
    .run(
      `replydraft:${base}`,
      `followup:${base}`,
      `plans-empty:${base}`,
      `followup:${base}:`.length,
      `followup:${base}:`,
    );
  run.q('DELETE FROM threads WHERE id = ?').run(row.id); // cascades messages, placements, workflow, lists
  run.touched.delete(row.id);
  run.mark('Thread', w.accountId, w.remoteThreadId, 'd');
}

export function workflow(run: CommitRun, w: WorkflowWrite) {
  const row = run.q('SELECT id FROM threads WHERE account_id = ? AND remote_id = ?').get<{
    id: number;
  }>(w.accountId, w.remoteThreadId);
  if (!row) return run.missing(`Thread ${w.remoteThreadId}`);
  const keys = Object.keys(w.patch) as (keyof WorkflowFields)[];
  if (!keys.length) return;
  const values = keys.map(k => {
    if (!(k in WORKFLOW_COLUMNS)) throw new StoreError('invalid', `Unknown workflow field ${k}`);
    const v = w.patch[k];
    return typeof v === 'boolean' ? Number(v) : ((v ?? null) as SqlValue);
  });
  run
    .q(
      `UPDATE thread_workflow SET ${keys.map(k => `${WORKFLOW_COLUMNS[k]} = ?`).join(', ')} WHERE thread_id = ?`,
    )
    .run(...values, row.id);
  // Workflow is part of the contract's Thread row, so the thread's rev moves with it.
  run.q('UPDATE threads SET rev = ? WHERE id = ?').run(run.seq, row.id);
  run.mark('Thread', w.accountId, w.remoteThreadId, 'u');
}

export function threadMerge(run: CommitRun, w: ThreadMergeWrite) {
  const find = (remoteId: string) =>
    run
      .q('SELECT id FROM threads WHERE account_id = ? AND remote_id = ?')
      .get<{ id: number }>(w.accountId, remoteId)?.id;
  const from = w.from.filter(r => r !== w.into);
  let into = find(w.into);
  if (into === undefined) {
    const first = from.find(r => find(r) !== undefined);
    if (first === undefined) return run.missing(`Thread ${w.into}`);
    into = find(first)!;
    run.q('UPDATE threads SET remote_id = ? WHERE id = ?').run(w.into, into);
    run.q('UPDATE thread_workflow SET sync_key = ? WHERE thread_id = ?').run(w.into, into);
    run.mark('Thread', w.accountId, first, 'd');
    // Its messages now name a different contract thread id.
    for (const m of run
      .q(`SELECT ${MESSAGE_COLS} FROM messages m WHERE m.thread_id = ?`)
      .all<MessageRow>(into))
      run.touchMessage(w.accountId, m);
  }
  for (const remoteId of from) {
    const id = find(remoteId);
    if (id === undefined || id === into) continue;
    for (const m of run
      .q(`SELECT ${MESSAGE_COLS} FROM messages m WHERE m.thread_id = ?`)
      .all<MessageRow>(id)) {
      run.q('UPDATE messages SET thread_id = ? WHERE id = ?').run(into, m.id);
      run.touchMessage(w.accountId, { ...m, thread_id: into });
    }
    run.touched.add(id); // emptied: the rollup deletes it and marks it
  }
  run.touched.add(into);
}
