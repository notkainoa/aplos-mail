import { NotSentError, PausedError } from '../ports/base';
import type { AccountId, BudgetId } from '../ports/base';
import type { GovernorPort } from '../ports/governor';
import type { SendPort } from '../ports/engine';
import type { AdapterContext, ProviderAdapter } from '../ports/provider';
import { entryTarget } from './host-drafts';

export { entryTarget } from './host-drafts';

/**
 * What a send routes through in a started account, kept structural so the host's entry type stays private: the
 * adapter, the mail budget `admission` asks and the actor that hands out the account's governor-bound context.
 */
export interface SendEntry {
  adapter: ProviderAdapter;
  budget: BudgetId;
  actor: { context(): AdapterContext };
}

/**
 * An account that is not started right now, for the send lane: a `transient` `PausedError`, never `NotSentError`.
 * `settle` maps a `NotSentError` to `failed` with manual Retry; a non-`send_limit` pause returns the row to waiting
 * and re-asks on the next poll (runner.ts `settlePaused`), which is what "the outbox re-asks" means. The budget is
 * `oauth` — a not-started account is blocked on its own start, never on a mail rate budget it has no meter for.
 */
const sendNotStarted = (account: AccountId) =>
  new PausedError(account, 'oauth', 'transient', 'accountNotStarted');

/**
 * The account's context checked against the account the caller named, as `contextFor` does — except a mismatch on
 * the send lane provably wrote nothing, so it is a `permanent` `NotSentError` (settled `failed`), not the draft
 * lane's `ProviderError` that the outbox would hold `uncertain` and retry forever.
 */
function sendContext(
  account: AccountId,
  target: { context(): AdapterContext },
  method: string,
): AdapterContext {
  const ctx = target.context();
  if (ctx.account.id !== account)
    throw new NotSentError({
      class: 'permanent',
      provider: 'engine',
      method,
      reason: 'accountMismatch',
    });
  return ctx;
}

/**
 * The engine's `SendPort` for the real composition (plan 20 PV4): `send` and `findSent` reach the named account's
 * adapter under that account's actor context on the `interactive` lane, and `admission` answers the mail budget's
 * `send` admission (`send_limit` included) with no I/O. A call for an account that is not started is a `transient`
 * pause (`accountNotStarted`): nothing was written, and the outbox re-asks on its next poll instead of waiting on a
 * pause that never ends or parking the row as `failed`.
 */
export function sendPortOf(
  governor: () => GovernorPort,
  entries: ReadonlyMap<AccountId, SendEntry>,
): SendPort {
  const targetOf = (account: AccountId) => entryTarget(entries.get(account));
  return {
    admission(account) {
      const found = entries.get(account);
      if (!found) return { ok: false, cls: 'transient', reason: 'accountNotStarted' };
      return governor().admission(account, found.budget, 'interactive', 'send');
    },
    async send(account, submission) {
      const target = targetOf(account);
      if (!target) throw sendNotStarted(account);
      return target.adapter.send(submission, sendContext(account, target, 'send'));
    },
    async findSent(account, internetId, since) {
      const target = targetOf(account);
      if (!target) throw sendNotStarted(account);
      return target.adapter.findSent(internetId, since, sendContext(account, target, 'findSent'));
    },
  };
}
