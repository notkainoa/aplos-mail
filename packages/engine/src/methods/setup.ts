import type { Input, Output, ReasonCode, SetupStatus } from '@aplos/contract';
import type { AccountRuntime } from '../ports/engine';
import { accountIds, readAccount } from '../sync/account-read';
import { hexId } from '../sync/connect-sessions';
import type { AreaHandlers, MethodContext } from './types';

/**
 * The `setup` area, owned by lane `eng-ai`. The first-sync screen's mail progress (DESIGN 7.12): it reads the live
 * account runtimes (`firstWindow`, `baselineDoneAt`, health), never the AI pass, so the screen reports mail sync with
 * or without a provider or consent. `ai` is omitted until the AI pass reports here; the screen then omits Sort rather
 * than failing it. `Setup/end` writes the `setup.*` meta keys `Session/get` reads, on the first write only.
 */

/** The one setup session at a time (`Setup/begin`); not persisted — a session ends with the engine. */
let setupId: string | undefined;

/** One account's row inside `Setup/status`. */
type SetupAccountRow = SetupStatus['accounts'][number];

const FAILED_STATES = new Set([
  'needsReauth',
  'needsPermission',
  'needsAdmin',
  'misconfigured',
  'error',
]);

/** The account's first-sync state, from its health and first-window facts. A demo account is always `ready`. */
export function setupStateOf(
  account: { demo: boolean; baselineDoneAt?: number },
  runtime: AccountRuntime | undefined,
): SetupAccountRow['state'] {
  if (account.demo) return 'ready';
  const status = runtime?.status;
  if (status !== undefined && FAILED_STATES.has(status.state)) return 'failed';
  if ((runtime?.baselineDoneAt ?? account.baselineDoneAt) !== undefined) return 'ready';
  if (status?.state === 'paused' || status?.state === 'offline') return 'paused';
  if (
    status?.state === 'syncing' &&
    runtime !== undefined &&
    (runtime.firstWindow.read > 0 ||
      runtime.firstWindow.total > 0 ||
      runtime.firstWindow.found !== undefined)
  )
    return 'reading';
  // 'starting', 'syncing' with nothing read yet, 'ok' without a baseline, or an actor that is not up
  // yet: the account is connected and its first window is still to come.
  return 'finding';
}

/** One account's row for `Setup/status`. Mail facts only: no AI pass reads or writes here. */
function setupAccountOf(
  services: MethodContext['services'],
  accountId: string,
): SetupAccountRow | undefined {
  const runtime = services.accounts.status(accountId);
  const account = readAccount(services.store, accountId, runtime);
  if (!account) return undefined;
  const state = setupStateOf(account, runtime);
  const window = runtime?.firstWindow ?? { read: 0, total: 0 };
  const baselineIn = account.baselineDoneAt !== undefined;
  const backfilling = runtime?.status.state === 'backfilling' ? runtime.status : undefined;
  return {
    accountId,
    state,
    firstWindow: {
      ...(window.found !== undefined ? { found: window.found } : {}),
      read: window.read,
      total: window.total,
      done: baselineIn,
    },
    backfill: backfilling
      ? { read: backfilling.done, target: backfilling.of ?? backfilling.done }
      : { read: 0, target: 0 },
    ...(runtime?.status.state === 'paused' ? { pausedUntil: runtime.status.until } : {}),
    ...(account.health.reconnectBy !== undefined
      ? { reconnectBy: account.health.reconnectBy }
      : {}),
    ...(runtime?.reasonCode !== undefined ? { reasonCode: runtime.reasonCode } : {}),
    // Counters are monotonic for the account's life here; a retry resumes the same run.
    runId: `run-${accountId}`,
  };
}

function status(_args: Input<'Setup/status'>, ctx: MethodContext): Output<'Setup/status'> {
  const { store } = ctx.services;
  const accounts: SetupAccountRow[] = [];
  const errors: SetupStatus['errors'] = [];
  for (const id of accountIds(store)) {
    const row = setupAccountOf(ctx.services, id);
    if (!row) continue;
    accounts.push(row);
    if (row.state === 'failed' && row.reasonCode !== undefined)
      errors.push({
        accountId: id,
        phase:
          row.firstWindow.read > 0 || row.firstWindow.found !== undefined
            ? 'firstWindow'
            : 'connect',
        reasonCode: row.reasonCode as ReasonCode,
        at: ctx.services.clock.now(),
      });
  }
  return {
    ...(setupId !== undefined ? { setupId } : {}),
    accounts,
    done: accounts.every(row => row.firstWindow.done),
    partial: accounts.some(row => row.state === 'paused' || row.state === 'failed'),
    errors,
  };
}

function begin(_args: Input<'Setup/begin'>, ctx: MethodContext): Output<'Setup/begin'> {
  setupId = hexId(ctx.services.randomBytes, 'setup');
  return { setupId };
}

function end(args: Input<'Setup/end'>, ctx: MethodContext): Output<'Setup/end'> {
  const { store, clock, randomBytes } = ctx.services;
  const key =
    args.reason === 'skipped'
      ? 'setup.skippedAt'
      : args.reason === 'closed'
        ? undefined
        : 'setup.completedAt';
  if (key !== undefined) {
    const already = store.read(
      q => q.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value,
    );
    // The first end wins: a later close never moves the recorded time.
    if (already === undefined)
      store.commit({
        opId: hexId(randomBytes, 'setup-end'),
        origin: 'local',
        writes: [{ kind: 'meta', key, value: String(clock.now()) }],
      });
  }
  setupId = undefined;
  return { ok: true };
}

function retry(args: Input<'Setup/retry'>, ctx: MethodContext): Output<'Setup/retry'> {
  ctx.services.accounts.request(args.accountId, { manual: true, force: true });
  return { ok: true };
}

export const handlers: AreaHandlers<'setup'> = {
  'Setup/begin': begin,
  'Setup/end': end,
  'Setup/retry': retry,
  'Setup/status': status,
};
