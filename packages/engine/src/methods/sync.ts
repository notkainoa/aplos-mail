import type { Output } from '@aplos/contract';
import type { AccountId, Admission } from '../ports';
import type { AreaHandlers, EngineServices } from './types';

/**
 * The `sync` area, owned by lane `prov-gov`. Arguments arrive validated; throw `ContractError`
 * (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */

type SyncAccount = Output<'Sync/request'>['accounts'][number];

function answer(accountId: AccountId, admission: Admission): SyncAccount {
  if (admission.ok) return { accountId, accepted: true };
  return {
    accountId,
    accepted: false,
    reasonCode: admission.reason.slice(0, 60),
    ...(admission.until === undefined ? {} : { resumeAt: admission.until }),
  };
}

/** Every started account is asked; one the governor refused gets its single `force` call when the caller allows it. */
function requestEveryAccount(accounts: EngineServices['accounts'], force: boolean): SyncAccount[] {
  const admissions = accounts.requestAll({ manual: true });
  return Object.entries(admissions).map(([id, admission]) => {
    const retry = !admission.ok && force;
    return answer(id, retry ? accounts.request(id, { manual: true, force: true }) : admission);
  });
}

export const handlers: AreaHandlers<'sync'> = {
  /**
   * The governor answers first, so a manual sync during a pause makes no network call. `scope` narrows nothing yet: the
   * actor plans its own scopes from its cursors, so a manual request always plans a full pass.
   */
  'Sync/request': ({ accountId, force }, { services }) => {
    const { accounts } = services;
    if (accountId === undefined) {
      return { accounts: requestEveryAccount(accounts, force === true) };
    }
    const admission = accounts.request(accountId, { manual: true, force });
    return { accounts: [answer(accountId, admission)] };
  },
};
