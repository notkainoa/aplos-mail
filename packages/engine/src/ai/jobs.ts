import type { CommitExtension, CommitExtensionTx } from '../store/port';
import { StoreError } from '../store/port';

declare module '../store/port' {
  interface ExtensionWrites {
    job: JobWrite;
  }
}

/**
 * A `job` write (eng-ai): requeue a failed or dead background job, or remove its row. `jobs` rows are created by
 * the AI scheduler; the queue inspector only moves or deletes them here.
 */
export interface JobWrite {
  kind: 'job';
  id: number;
  action: 'requeue' | 'delete';
  nextAt?: number;
}

function apply(write: { kind: string }, tx: CommitExtensionTx): void {
  const w = write as JobWrite;
  if (!Number.isInteger(w.id)) throw new StoreError('invalid', 'A job write names a job');
  if (w.action === 'delete') {
    const gone = tx.run('DELETE FROM jobs WHERE id = ?', w.id);
    if (gone.changes) tx.mark('AiJob', String(w.id), 'd');
    return;
  }
  const changed = tx.run(
    "UPDATE jobs SET state = 'queued', attempts = attempts + 1, next_at = ? WHERE id = ? AND state IN ('failed','dead')",
    w.nextAt ?? tx.now(),
    w.id,
  );
  if (changed.changes) tx.mark('AiJob', String(w.id), 'u');
}

export const jobExtension: CommitExtension = {
  lane: 'eng-ai',
  kinds: ['job'],
  changeTypes: ['AiJob'],
  apply,
};
