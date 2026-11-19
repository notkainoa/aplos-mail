import type { SqlValue } from './sql';
import { StoreError, type OpEffect, type OpSettleWrite, type OpWrite } from './port';
import type { CommitRun } from './commit';
import { flagBits, flags, movePlacements, placements, targets } from './commit-messages';

// ------------------------------------------------------------ ops (ARCH 4.3)

export function op(run: CommitRun, w: OpWrite) {
  if (!w.opId || !w.accountId || !w.opKind)
    throw new StoreError('invalid', 'An op needs opId, accountId and opKind');
  // Undo, retry and discard check the caller against this scope again (FR-3); an op without one would pass them all.
  if (typeof w.scope !== 'string' || !w.scope)
    throw new StoreError('invalid', `Op ${w.opId} needs the scope of the method that made it`);
  if (!Array.isArray(w.effect))
    throw new StoreError('invalid', `Op ${w.opId} needs an effect array`);
  if (run.q('SELECT 1 FROM ops WHERE op_id = ?').get(w.opId))
    throw new StoreError('invalid', `Op ${w.opId} is already queued`);
  for (const e of w.effect) applyEffect(run, w.accountId, e, undefined);
  run
    .q(
      `INSERT INTO ops(op_id, account_id, kind, target, payload, base, effect, state, created_seq, scope)
    VALUES(?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(
      w.opId,
      w.accountId,
      w.opKind,
      JSON.stringify(w.targets ?? []),
      w.payload,
      w.base ?? null,
      w.effect.length ? JSON.stringify(w.effect) : null,
      run.seq,
      w.scope,
    );
  run.mark('Account', w.accountId, null, 'u'); // Account.pendingChanges
}

export function opSettle(run: CommitRun, w: OpSettleWrite) {
  const row = run.q('SELECT seq, account_id FROM ops WHERE op_id = ?').get<{
    seq: number;
    account_id: string;
  }>(w.opId);
  if (!row) return run.missing(`Op ${w.opId}`);
  if (w.state === 'synced' || w.state === 'cancelled')
    run.q('DELETE FROM ops WHERE seq = ?').run(row.seq);
  else {
    const cols: Record<string, SqlValue> = { state: w.state };
    if (w.attempts !== undefined) cols.attempts = w.attempts;
    if (w.nextAt !== undefined) cols.next_at = w.nextAt;
    if (w.lastError !== undefined) cols.last_error = w.lastError;
    const keys = Object.keys(cols);
    run
      .q(`UPDATE ops SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE seq = ?`)
      .run(...keys.map(k => cols[k]), row.seq);
  }
  run.mark('Account', row.account_id, null, 'u');
}

/**
 * One op effect. `only` set: a replay over a sync commit, limited to the messages it wrote that were already stored
 * when the op was enqueued, ignoring the fence and leaving `local_seq` alone. Unset: the op's own local edit.
 */
export function applyEffect(
  run: CommitRun,
  accountId: string,
  e: OpEffect,
  only: { ids: Set<number>; createdSeq: number } | undefined,
) {
  if (!only) {
    if (e.kind === 'placements')
      return placements(run, {
        kind: 'placements',
        accountId,
        target: e.target,
        add: e.add,
        remove: e.remove,
      });
    if (e.kind === 'flags') return flags(run, { ...e, kind: 'flags', accountId });
    throw new StoreError('invalid', `Unknown op effect ${(e as { kind?: unknown }).kind}`);
  }
  for (const m of targets(run, accountId, e.target)) {
    if (!only.ids.has(m.id) || m.first_seen_seq > only.createdSeq) continue;
    if (e.kind === 'placements') movePlacements(run, accountId, m.id, e.add, e.remove, undefined);
    else if (e.kind === 'flags') {
      const [set, clear] = flagBits(e);
      run.q('UPDATE messages SET flags = (flags & ~?) | ? WHERE id = ?').run(clear, set, m.id);
    }
    run.touched.add(m.thread_id);
  }
}
