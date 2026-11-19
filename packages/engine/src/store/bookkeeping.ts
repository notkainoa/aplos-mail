import type { SqlValue } from './sql';
import {
  StoreError,
  type GovernorFields,
  type GovernorWrite,
  type ProviderMemoryWrite,
  type SyncFailureWrite,
} from './port';
import type { WriteScope } from './scope';

// Provider bookkeeping (prov-gov, prov-*): persisted so blocks, cooldowns and limits survive a restart. None of it is
// contract-visible on its own, so none of it writes a change row; the account status that reflects it is an
// `AccountWrite` in the same commit.

const GOVERNOR_COLUMNS: Record<keyof GovernorFields, string> = {
  target: 'target',
  cooldownUntil: 'cooldown_until',
  reason: 'reason',
  dailyBlockUntil: 'daily_block_until',
  cooldownStep: 'cooldown_step',
  lastRefusalAt: 'last_refusal_at',
  cls: 'cls',
  inFlightLimit: 'in_flight_limit',
  batchSize: 'batch_size',
  windowSpent: 'window_spent',
  windowAt: 'window_at',
  sendBlockedUntil: 'send_blocked_until',
  blockedCls: 'blocked_cls',
  blockedSince: 'blocked_since',
};

/** The `governor_state.account_id` of the project-wide budgets: no account row behind it. */
const PROJECT = '*';

export function governor(s: WriteScope, w: GovernorWrite) {
  if (!w.accountId || !w.budget)
    throw new StoreError('invalid', 'A governor write needs accountId and budget');
  if (w.accountId !== PROJECT && !s.q('SELECT 1 FROM accounts WHERE id = ?').get(w.accountId))
    throw new StoreError('notFound', `Account ${w.accountId} is not in the store`);
  const keys = Object.keys(w.patch) as (keyof GovernorFields)[];
  for (const k of keys)
    if (!(k in GOVERNOR_COLUMNS)) throw new StoreError('invalid', `Unknown governor field ${k}`);
  const cols = keys.map(k => GOVERNOR_COLUMNS[k]);
  const values = keys.map(k => (w.patch[k] ?? null) as SqlValue);
  if (keys.includes('cooldownStep') && values[keys.indexOf('cooldownStep')] === null)
    throw new StoreError('invalid', 'cooldownStep cannot be null');
  s.q(
    `INSERT INTO governor_state(account_id, budget, ${[...cols, 'updated_at'].join(', ')})
    VALUES(?, ?, ${[...cols, 'updated_at'].map(() => '?').join(', ')})
    ON CONFLICT(account_id, budget) DO UPDATE SET ${[...cols, 'updated_at'].map(c => `${c} = excluded.${c}`).join(', ')}`,
  ).run(w.accountId, w.budget, ...values, s.now());
}

export function providerMemory(s: WriteScope, w: ProviderMemoryWrite) {
  const put = s.q(
    'INSERT INTO provider_memory(account_id, key, value) VALUES(?, ?, ?) ON CONFLICT(account_id, key) DO UPDATE SET value = excluded.value',
  );
  const del = s.q('DELETE FROM provider_memory WHERE account_id = ? AND key = ?');
  for (const [key, value] of Object.entries(w.values))
    if (value === null) del.run(w.accountId, key);
    else put.run(w.accountId, key, value);
}

export function syncFailure(s: WriteScope, w: SyncFailureWrite) {
  if (w.failure === null) {
    s.q('DELETE FROM sync_failures WHERE account_id = ? AND item = ?').run(w.accountId, w.item);
    return;
  }
  s.q(
    `INSERT INTO sync_failures(account_id, item, attempts, next_retry_at, last_reason) VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(account_id, item) DO UPDATE SET attempts = excluded.attempts, next_retry_at = excluded.next_retry_at,
      last_reason = excluded.last_reason`,
  ).run(
    w.accountId,
    w.item,
    w.failure.attempts,
    w.failure.nextRetryAt,
    w.failure.lastReason ?? null,
  );
}
