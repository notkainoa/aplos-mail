import { ContractError } from '@aplos/contract/contract-error';
import type { State } from '@aplos/contract';
import { StoreError, type StorePort, type StoreWrite } from '../../store/port';

/**
 * `Demo/load`, `Demo/reset` and `Demo/remove` against the store (ai-2). Demo accounts are the rows whose
 * `accounts.provider` is `'demo'` — that is the demo marker `Account.demo` reads. Everything goes through
 * `store.commit`: `load` is one local commit of the original dataset and a no-op once every demo account
 * is there (a partial demo is removed and loaded again, never reported as loaded), `reset` removes the
 * demo accounts and writes the dataset again, and `remove` is one `accountRemove` write per demo account,
 * which cascades everything the account owns and nothing else.
 */

/** The demo accounts' fixed ids, in `Demo/load`'s order; a test pins them to `DEMO_ACCOUNTS` in `data.ts`. */
export const DEMO_ACCOUNT_IDS: readonly string[] = ['demo-work', 'demo-personal'];

/** Builds the demo dataset's writes for `now`. */
export type DemoWrites = (now: number) => StoreWrite[];

/**
 * The demo dataset (about 11 KB minified), loaded on first use: a mailbox that never asks for the demo never reads
 * it, and a build that splits chunks keeps it out of the core bundle. Awaited BEFORE any commit, so `Demo/reset`'s two
 * commits never wait on a load between them.
 */
export const lazyDemoWrites = async (): Promise<DemoWrites> => (await import('./data')).demoWrites;

/**
 * The receipt opId of a call that committed nothing. `Receipt.opId` always names an applied commit, so a
 * no-op answers a stable documented marker — 'no commit' — rather than a fresh `demo-*` id nothing holds.
 */
export const DEMO_LOAD_NOOP = 'demo-load-noop';
export const DEMO_REMOVE_NOOP = 'demo-remove-noop';

/** What `Demo/load` and `Demo/reset` answer: the demo account ids and the applied commit's receipt. */
export interface DemoApplied {
  accountIds: string[];
  /** The opId of the commit that applied this call, or `DEMO_LOAD_NOOP` when nothing was committed. */
  opId: string;
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

/** `Demo/load`: the dataset commit, or none once every demo account is there (idempotent). */
export function loadDemo(
  store: StorePort,
  opId: string,
  now: number,
  writes: DemoWrites,
): DemoApplied {
  const existing = demoAccountIds(store);
  if (DEMO_ACCOUNT_IDS.every(id => existing.includes(id)))
    return { accountIds: existing, opId: DEMO_LOAD_NOOP, state: state(store) };
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
  // A partial demo is not 'loaded': the survivors go first, then the whole set commits again.
  if (existing.length) removeDemo(store, `${opId}-remove`);
  const result = store.commit({ opId, origin: 'local', writes: writes(now) });
  return {
    accountIds: [...DEMO_ACCOUNT_IDS],
    opId,
    state: { dbEpoch: result.dbEpoch, seq: result.seq },
  };
}

/**
 * `Demo/reset`: refused while a demo account has a send out, else remove and load again. Two commits, never
 * one — the store refuses a write naming an account removed earlier in the same commit — so a failure in
 * between leaves no demo accounts: the reload is retried once, and a second failure throws `internal`
 * saying the demo is empty and `Demo/load` restores it.
 */
export function resetDemo(
  store: StorePort,
  opId: string,
  now: number,
  writes: DemoWrites,
): DemoApplied {
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
  // The reload carries this call's own opId, so the receipt names a commit that really happened. It is the
  // second of reset's two commits; a failure after the remove leaves the demo empty, so it gets one retry.
  for (let attempt = 0; attempt < 2; attempt++)
    try {
      return loadDemo(store, opId, now, writes);
    } catch (error) {
      // Only a failed commit is worth a second try: a refusal loadDemo raises itself (a ContractError) or a
      // programming error stands, instead of being retried and masked as an empty demo.
      if (!(error instanceof StoreError)) throw error;
    }
  throw new ContractError({
    type: 'internal',
    message: 'The demo is empty after a failed reset. Demo/load restores it.',
  });
}

/**
 * `Demo/remove`: every demo account and its mail; real accounts are untouched by `accountRemove`. The store's
 * `conflict` — a demo submission is `sending` or `uncertain` — becomes the typed `conflict` the UI shows.
 */
export function removeDemo(store: StorePort, opId: string): { opId: string; state: State } {
  const ids = demoAccountIds(store);
  if (!ids.length) return { opId: DEMO_REMOVE_NOOP, state: state(store) };
  try {
    const result = store.commit({
      opId,
      origin: 'local',
      writes: ids.map(accountId => ({ kind: 'accountRemove' as const, accountId })),
    });
    return { opId, state: { dbEpoch: result.dbEpoch, seq: result.seq } };
  } catch (error) {
    if (error instanceof StoreError && error.code === 'conflict')
      throw new ContractError({
        type: 'conflict',
        message: "Demo accounts can't be removed while a message is sending.",
      });
    throw error;
  }
}
