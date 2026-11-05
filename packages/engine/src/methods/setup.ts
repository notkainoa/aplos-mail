import type { Input, Output } from '@aplos/contract';
import { notImplemented, type AreaHandlers, type MethodContext } from './types';

/**
 * The `setup` area, owned by lane `eng-ai`. `Setup/status` reports first-sync progress per stored account from the
 * actor runtime; `begin`, `end` and `retry` belong to the onboarding session and stay stubs.
 */

type SetupAccount = Output<'Setup/status'>['accounts'][number];

const ACTIVE = new Set(['syncing', 'starting', 'backfilling', 'ok']);

function status(_args: Input<'Setup/status'>, ctx: MethodContext): Output<'Setup/status'> {
  const { store, accounts } = ctx.services;
  const rows = store.read(q =>
    q.all<{ id: string; baseline_done_at: number | null }>(
      'SELECT id, baseline_done_at FROM accounts ORDER BY created_at, id',
    ),
  );
  const errors: Output<'Setup/status'>['errors'] = [];
  const list: SetupAccount[] = rows.map(row => {
    // A stand-in port (no actor host) answers `unavailable`; the store's facts still describe the run.
    let runtime;
    try {
      runtime = accounts.status(row.id);
    } catch {
      runtime = undefined;
    }
    const win = runtime?.firstWindow;
    const done = row.baseline_done_at !== null;
    const health = runtime?.status.state;
    const state: SetupAccount['state'] = done
      ? 'ready'
      : health === 'needsReauth' || health === 'needsPermission'
        ? 'paused'
        : health === 'error' || health === 'misconfigured'
          ? 'failed'
          : ACTIVE.has(health ?? '') || !health
            ? 'reading'
            : 'paused';
    const reasonCode = runtime?.reasonCode as SetupAccount['reasonCode'];
    if (reasonCode && !done)
      errors.push({
        accountId: row.id,
        phase: 'firstWindow',
        reasonCode,
        at: ctx.services.clock.now(),
      });
    return {
      accountId: row.id,
      state,
      firstWindow: {
        ...(win?.found !== undefined ? { found: win.found } : {}),
        read: win?.read ?? 0,
        total: win?.total ?? 0,
        done,
      },
      backfill: { read: 0, target: 0 },
      ...(runtime?.reconnectBy !== undefined ? { reconnectBy: runtime.reconnectBy } : {}),
      ...(reasonCode ? { reasonCode } : {}),
      runId: `${row.id}:first-sync`,
    };
  });
  return {
    accounts: list,
    done: list.length > 0 && list.every(a => a.firstWindow.done),
    partial: errors.length > 0,
    errors,
  };
}

export const handlers: AreaHandlers<'setup'> = {
  'Setup/begin': notImplemented('Setup/begin'),
  'Setup/end': notImplemented('Setup/end'),
  'Setup/retry': notImplemented('Setup/retry'),
  'Setup/status': status,
};
