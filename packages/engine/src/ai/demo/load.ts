import { ContractError } from '@aplos/contract/contract-error';
import type { State } from '@aplos/contract';
import type { StorePort } from '../../store/port';
import { DEMO_ACCOUNTS, demoWrites } from './data';

/**
 * `Demo/load`, `Demo/reset` and `Demo/remove` against the store (ai-2). Demo accounts are the rows whose
 * `accounts.provider` is `'demo'` — that is the demo marker `Account.demo` reads. Everything goes through
 * `store.commit`: `load` is one local commit of the original dataset and a no-op once the demo exists,
 * `reset` removes the demo accounts and writes the dataset again, and `remove` is one `accountRemove`
 * write per demo account, which cascades everything the account owns and nothing else.
 */

export const DEMO_ACCOUNT_IDS: readonly string[] = DEMO_ACCOUNTS.map(a => a.id);

/** What `Demo/load` and `Demo/reset` answer: the demo account ids and the commit's applied state. */
export interface DemoApplied {
  accountIds: string[];
  state: State;
}

/** The ids of the stored demo accounts (`provider = 'demo'`), in `DEMO_ACCOUNT_IDS` order. */
export function demoAccountIds(store: StorePort): string[] {
  const stored = store.read(q =>
    q.all<{ id: string }>("SELECT id FROM accounts WHERE provider = 'demo'").map(r => r.id),
  );
  return DEMO_ACCOUNT_IDS.filter(id => stored.includes(id)).concat(
    stored.filter(id => !DEMO_ACCOUNT_IDS.includes(id)),
  );
}

const state = (store: StorePort): State => ({ dbEpoch: store.dbEpoch, seq: store.seq() });

/** `Demo/load`: the dataset commit, or none when the demo is already there (idempotent). */
export function loadDemo(store: StorePort, opId: string, now: number): DemoApplied {
  const existing = demoAccountIds(store);
  if (existing.length) return { accountIds: existing, state: state(store) };
  // The fixed ids belong to the demo alone; never let a load overwrite a real account that took one.
  const taken = store.read(q =>
    q.all<{ id: string }>(
      `SELECT id FROM accounts WHERE provider <> 'demo' AND id IN (${DEMO_ACCOUNT_IDS.map(() => '?').join(',')})`,
      ...DEMO_ACCOUNT_IDS,
    ),
  );
  if (taken.length)
    throw new ContractError({
      type: 'conflict',
      message: 'A real account is using the demo account ids. Remove it first.',
    });
  const result = store.commit({ opId, origin: 'local', writes: demoWrites(now) });
  return { accountIds: [...DEMO_ACCOUNT_IDS], state: { dbEpoch: result.dbEpoch, seq: result.seq } };
}

/** `Demo/reset`: refused while a demo account has a send out, else remove and load again. */
export function resetDemo(store: StorePort, opId: string, now: number): DemoApplied {
  const sending = store.read(
    q =>
      q.get(
        `SELECT 1 FROM submissions WHERE account_id IN (${DEMO_ACCOUNT_IDS.map(() => '?').join(',')})
        AND state IN ('sending', 'uncertain') LIMIT 1`,
        ...DEMO_ACCOUNT_IDS,
      ) !== undefined,
  );
  if (sending)
    throw new ContractError({
      type: 'conflict',
      message: 'A demo message is being sent. Try again when it has gone out.',
    });
  removeDemo(store, `${opId}-remove`);
  return loadDemo(store, `${opId}-load`, now);
}

/** `Demo/remove`: every demo account and its mail; real accounts are untouched by `accountRemove`. */
export function removeDemo(store: StorePort, opId: string): State {
  const ids = demoAccountIds(store);
  if (!ids.length) return state(store);
  const result = store.commit({
    opId,
    origin: 'local',
    writes: ids.map(accountId => ({ kind: 'accountRemove' as const, accountId })),
  });
  return { dbEpoch: result.dbEpoch, seq: result.seq };
}
