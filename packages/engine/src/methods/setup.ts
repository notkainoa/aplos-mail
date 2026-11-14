import type { Account, Input, Output, ReasonCode, SetupStatus } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { AccountRuntime } from '../ports/engine';
import { accountExists, accountIds, readAccount } from '../sync/account-read';
import { hexId } from '../sync/connect-sessions';
import { statusOfRefusal } from '../sync/status';
import type { AreaHandlers, MethodContext } from './types';

/**
 * The `setup` area, owned by lane `eng-ai`. The first-sync screen's mail progress (DESIGN 7.12): it reads the live
 * account runtimes (`firstWindow`, `baselineDoneAt`, health), never the AI pass, so the screen reports mail sync with
 * or without a provider or consent. `ai` is omitted until the AI pass reports here; the screen then omits Sort rather
 * than failing it. `Setup/end` writes the `setup.*` meta keys `Session/get` reads, on the first write only.
 */

/** The one setup session at a time (`Setup/begin`); not persisted — a session ends with the engine. */
let setupId: string | undefined;

/** True while a `Setup/begin` session is open; the AI jobs runner pauses so backfill stays one-shot. */
export function setupSessionOpen(): boolean {
  return setupId !== undefined;
}

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
  account: Pick<Account, 'demo' | 'baselineDoneAt' | 'health'>,
  runtime: AccountRuntime | undefined,
): SetupAccountRow['state'] {
  if (account.demo) return 'ready';
  // `account.health` is the live actor's status when one runs, else the account's stored health, so an
  // actor that failed to start or was stopped is answered by what the account last said, never `finding`.
  const status = account.health.status;
  if (FAILED_STATES.has(status.state)) return 'failed';
  if ((runtime?.baselineDoneAt ?? account.baselineDoneAt) !== undefined) return 'ready';
  if (status.state === 'paused') return 'paused';
  if (runtime === undefined) return 'notConnected';
  if (status.state === 'offline') return 'paused';
  if (
    status.state === 'syncing' &&
    (runtime.firstWindow.read > 0 ||
      runtime.firstWindow.total > 0 ||
      runtime.firstWindow.found !== undefined)
  )
    return 'reading';
  // 'starting', 'syncing' with nothing read yet, or 'ok' without a baseline: the account is connected
  // and its first window is still to come.
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
  const status = account.health.status;
  const window = runtime?.firstWindow ?? { read: 0, total: 0 };
  const baselineIn = account.baselineDoneAt !== undefined;
  const backfilling = status.state === 'backfilling' ? status : undefined;
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
    // A pause or failure after the first window is in is the backfill's, not the row's: a ready row
    // emits neither, so the screen still reaches "Open Aplos" (U8 4a).
    ...(state === 'paused' && status.state === 'paused' && status.until !== undefined
      ? { pausedUntil: status.until }
      : {}),
    ...(account.health.reconnectBy !== undefined
      ? { reconnectBy: account.health.reconnectBy }
      : {}),
    ...((state === 'paused' || state === 'failed') && account.health.reasonCode !== undefined
      ? { reasonCode: account.health.reasonCode }
      : {}),
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
  // An end naming an earlier session is an idempotent ok that changes nothing: it must not clear the
  // live session's id or stamp `setup.*` while a new run is in progress.
  // A stale end (a previous session's close) is ignored only while the engine holds a DIFFERENT live id. After an engine
  // restart the live id is gone, and the window's own end must still land (the meta write is first-write-wins).
  if (args.setupId !== undefined && setupId !== undefined && args.setupId !== setupId) {
    return { ok: true };
  }
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
  // The one-shot AI backfill of unsummarised threads queues here (F1/F2/F5/F6); the queue's own gate decides when
  // they run, so a setup ending before consent just leaves the jobs waiting. `catchUpSummaries` logs a failure
  // instead of swallowing it — a silent drop is why this bug went unseen.
  void import('../ai/impl/backfill')
    .then(m => m.catchUpSummaries(ctx.services))
    .catch(() => undefined);
  setupId = undefined;
  return { ok: true };
}

function retry(args: Input<'Setup/retry'>, ctx: MethodContext): Output<'Setup/retry'> {
  const { services } = ctx;
  // The `readAccount` convention: an unknown or removed account is `notFound`, never a quiet ok.
  if (!accountExists(services.store, args.accountId))
    throw new ContractError({ type: 'notFound', message: 'That account is not in Aplos.' });
  const admission = services.accounts.request(args.accountId, { manual: true, force: true });
  if (admission.ok) return { ok: true };
  // `Ok` cannot carry `Sync/request`'s `accepted:false`, so the refusal surfaces as an error with the
  // catalogue reason code `statusOfRefusal` gives the same refusal, and the resume time when it has one.
  const view = statusOfRefusal(admission, { now: services.clock.now() });
  const type =
    view.status.state === 'needsReauth'
      ? 'needsReauth'
      : view.status.state === 'needsPermission'
        ? 'permission'
        : 'paused';
  throw new ContractError({
    type,
    message:
      type === 'needsReauth'
        ? 'Sign in to this account again to retry.'
        : type === 'permission'
          ? 'Aplos needs permission to reach this account again.'
          : 'Aplos is waiting before it tries this again.',
    ...(view.reasonCode !== undefined ? { reasonCode: view.reasonCode } : {}),
    ...(admission.until !== undefined ? { resumeAt: admission.until } : {}),
  });
}

export const handlers: AreaHandlers<'setup'> = {
  'Setup/begin': begin,
  'Setup/end': end,
  'Setup/retry': retry,
  'Setup/status': status,
};
