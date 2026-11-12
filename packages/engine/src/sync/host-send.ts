import type { AccountId, BudgetId } from '../ports/base';
import type { GovernorPort } from '../ports/governor';
import type { SendPort } from '../ports/engine';
import type { AdapterContext, ProviderAdapter } from '../ports/provider';
import { contextFor, entryTarget, notStarted } from './host-drafts';

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
 * The engine's `SendPort` for the real composition (plan 20 PV4): `send` and `findSent` reach the named account's
 * adapter under that account's actor context on the `interactive` lane, and `admission` answers the mail budget's
 * `send` admission (`send_limit` included) with no I/O. A call for an account that is not started refuses
 * `transient` (`accountNotStarted`): nothing was written, and the outbox re-asks on its next due sweep instead of
 * waiting on a pause that never ends. The account check inside `contextFor` and the refusal shape are the draft
 * port's (`host-drafts.ts`), shared here unchanged.
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
      if (!target) throw notStarted('send');
      return target.adapter.send(submission, contextFor(account, target, 'send'));
    },
    async findSent(account, internetId, since) {
      const target = targetOf(account);
      if (!target) throw notStarted('findSent');
      return target.adapter.findSent(internetId, since, contextFor(account, target, 'findSent'));
    },
  };
}
