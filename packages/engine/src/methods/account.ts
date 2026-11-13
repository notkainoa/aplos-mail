import type { Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { discoverProvider } from '../sync/account-discover';
import { existingAccountFlow, newAccountFlow, type FlowDeps } from '../sync/account-connect';
import {
  accountExists,
  accountIds,
  leaseView,
  readAccount,
  readAccounts,
} from '../sync/account-read';
import {
  connectSessionsOf as sessionsOf,
  connectionOpensOnboarding,
  noteOnboardingConnection,
} from '../sync/connect-sessions';
import type { StorePort } from '../store/port';
import type { AreaHandlers, EngineServices, MethodContext } from './types';

/**
 * The `account` area, owned by lane `prov-gov`. The sign-in flows, the account view and the sessions live in
 * `sync/account-*.ts` and `sync/connect-sessions.ts`; this file only wires the contract to them.
 */

function flowDeps(services: EngineServices): FlowDeps {
  return { store: services.store, accounts: services.accounts, randomBytes: services.randomBytes };
}

const notFound = () =>
  new ContractError({ type: 'notFound', message: 'That account is not in Aplos.' });

function requireAccount(services: EngineServices, id: string) {
  const account = readAccount(services.store, id, services.accounts.status(id));
  if (!account) throw notFound();
  return account;
}

const stateOf = (store: StorePort) => ({ dbEpoch: store.dbEpoch, seq: store.seq() });

function get(args: Input<'Account/get'>, ctx: MethodContext): Output<'Account/get'> {
  const { store, accounts } = ctx.services;
  const { list, notFound: missing } = readAccounts(store, id => accounts.status(id), args.ids);
  return { state: stateOf(store), list, notFound: missing };
}

function reconnectWith(mode: 'reconnect' | 'grantPermissions') {
  return (args: { accountId: string; enable?: 'calendarWrite' }, ctx: MethodContext) => {
    const returnTo = connectionOpensOnboarding(ctx.connectionId) ? 'onboarding' : 'mail';
    const flow = existingAccountFlow(flowDeps(ctx.services), mode, args.accountId, args.enable);
    return sessionsOf(ctx.services).begin({ ...flow, returnTo });
  };
}

function updateSecret(args: Input<'Account/updateSecret'>, ctx: MethodContext): never {
  const account = requireAccount(ctx.services, args.accountId);
  throw new ContractError({
    type: 'unsupported',
    message:
      account.provider === 'google'
        ? 'Gmail accounts sign in with Google, so there is no password to change. Use Reconnect instead.'
        : 'Aplos can add Gmail accounts for now. Support for other mail providers is coming later.',
  });
}

function set(args: Input<'Account/set'>, ctx: MethodContext): Output<'Account/set'> {
  const { store } = ctx.services;
  if (!accountExists(store, args.accountId)) throw notFound();
  // TODO(eng-store): `AccountWrite` has no field for the colour or the notifications switch (both belong in
  // `accounts.settings`), so they cannot be saved yet. Refuse before writing anything, so a call never half-applies.
  if (args.colorTag !== undefined || args.notifications !== undefined) {
    throw new ContractError({
      type: 'unavailable',
      message: 'Account colors and notification switches cannot be saved yet.',
    });
  }
  const { opId, accountId, name, aiAllowed } = args;
  const result = store.commit({
    opId,
    origin: 'local',
    writes: [
      {
        kind: 'account',
        id: accountId,
        ...(name !== undefined ? { displayName: name.trim() || null } : {}),
        ...(aiAllowed !== undefined ? { aiAllowed } : {}),
      },
    ],
  });
  return {
    account: requireAccount(ctx.services, accountId),
    receipt: {
      opId,
      appliedState: { dbEpoch: result.dbEpoch, seq: result.seq },
      undoable: false,
    },
  };
}

/** All or nothing: when a pin fails or the call is cancelled midway, the accounts already changed go back as they were. */
async function lease(
  args: Input<'Account/lease'>,
  ctx: MethodContext,
): Promise<Output<'Account/lease'>> {
  const { store, accounts } = ctx.services;
  if (args.accountId !== undefined && !accountExists(store, args.accountId)) throw notFound();
  const ids = args.accountId !== undefined ? [args.accountId] : accountIds(store);
  const before = new Map(ids.map(id => [id, accounts.status(id)?.lease?.pinned === true]));
  const touched: string[] = [];
  try {
    for (const id of ids) {
      if (ctx.signal.aborted) throw new ContractError({ type: 'cancelled', message: 'Cancelled.' });
      touched.push(id);
      if (args.pin) await accounts.claimLease(id);
      else await accounts.releaseLease(id);
    }
  } catch (error) {
    await restoreLeases(accounts, touched, before);
    throw error;
  }
  const leases = ids.flatMap(accountId => {
    const held = accounts.status(accountId)?.lease;
    return held ? [{ accountId, lease: leaseView(held) }] : [];
  });
  return { leases };
}

/** Best effort: puts each touched account's pin back to what it was (the failing one included, it may be half done). */
async function restoreLeases(
  accounts: EngineServices['accounts'],
  touched: readonly string[],
  before: ReadonlyMap<string, boolean>,
): Promise<void> {
  for (const id of touched) {
    try {
      if (before.get(id)) await accounts.claimLease(id);
      else await accounts.releaseLease(id);
    } catch {
      // Nothing more can be done for this one; the original error is what the caller sees.
    }
  }
}

function disconnect(args: Input<'Account/disconnect'>, ctx: MethodContext): never {
  const { store } = ctx.services;
  if (!accountExists(store, args.accountId)) throw notFound();
  const sending = store.read(
    q =>
      q.get(
        "SELECT 1 FROM submissions WHERE account_id = ? AND state = 'sending'",
        args.accountId,
      ) !== undefined,
  );
  if (sending) {
    throw new ContractError({
      type: 'conflict',
      message: 'A message is being sent from this account. Try again when it has gone out.',
    });
  }
  // TODO(eng-store): the store has no write that removes an account (`DELETE FROM accounts` cascades, but nothing exposes
  // it). Until it does, nothing is stopped or deleted here: stopping the actor first would leave a half-removed account.
  // When it lands: `await accounts.stop(id, 'disconnect')`, commit the removal with `args.opId`, return the receipt.
  throw new ContractError({
    type: 'unavailable',
    message: 'Removing an account is not available yet.',
  });
}

export const handlers: AreaHandlers<'account'> = {
  'Account/get': get,
  'Account/discover': args => discoverProvider(args),
  'Account/connect': (args, ctx) => {
    // A `setupId` rides only on connects from the setup window; the mark lets a later reconnect or
    // grant on this same connection return there too (`returns.ts` binds the nonce to the window).
    // A non-window caller (a listener client, the CLI) can send a setupId but never binds the
    // setup window — the same check that gates the mark gates the binding.
    const fromSetupWindow = ctx.caller.kind === 'window' && Boolean(args.setupId);
    if (fromSetupWindow) noteOnboardingConnection(ctx.connectionId);
    const returnTo = fromSetupWindow ? 'onboarding' : 'mail';
    return sessionsOf(ctx.services).begin({
      ...newAccountFlow(flowDeps(ctx.services), args),
      returnTo,
    });
  },
  'Account/reconnect': reconnectWith('reconnect'),
  'Account/updateSecret': updateSecret,
  'Account/grantPermissions': reconnectWith('grantPermissions'),
  'Account/cancelConnect': (args, ctx) => ({
    cancelled: sessionsOf(ctx.services).cancel(args.connectId),
  }),
  'Account/set': set,
  'Account/lease': lease,
  'Account/disconnect': disconnect,
};
