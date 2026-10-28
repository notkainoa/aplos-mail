import { ContractError } from '@aplos/contract/contract-error';
import type { Input } from '@aplos/contract';
import type { AccountActorHost, ConnectRequest, ConnectResult } from '../ports';
import type { StorePort, StoreWrite } from '../store/port';
import { accountWithIdentity, storedIdentity } from './account-read';
import { hexId, type ConnectFlow } from './connect-sessions';

// The three sign-in flows behind `Account/connect|reconnect|grantPermissions`: what each asks the host for and what the
// engine stores when Google answers. Round 1 connects Google only.

export const WRONG_ACCOUNT =
  'That is a different Google account. Sign in with the account you are reconnecting.';
export const ALREADY_ADDED = 'That account is already in Aplos. Use Reconnect on it instead.';
export const GOOGLE_ONLY =
  'Aplos can add Gmail accounts for now. Support for other mail providers is coming later.';

export interface FlowDeps {
  store: StorePort;
  accounts: AccountActorHost;
  randomBytes: (n: number) => Uint8Array;
}

type ConnectArgs = Input<'Account/connect'>;

/** A new Google account: the engine picks its id, and commits the row only after Google answered. */
export function newAccountFlow(deps: FlowDeps, args: ConnectArgs): ConnectFlow {
  if (args.provider !== 'google')
    throw new ContractError({ type: 'unsupported', message: GOOGLE_ONLY });
  const accountId = hexId(deps.randomBytes, 'a');
  const address = args.address ?? args.loginHint;
  const request: ConnectRequest = {
    mode: 'new',
    ...(args.loginHint ? { loginHint: args.loginHint } : {}),
    ...(address ? { address } : {}),
    ...(args.preset === 'gmail' ? { preset: 'gmail' as const } : {}),
  };
  return {
    mode: 'new',
    accountId,
    key: `new:${address?.toLowerCase() ?? ''}`,
    kind: 'google',
    request,
    accept: async result => {
      refuseDuplicate(deps.store, result);
      deps.store.commit({
        opId: `connect:${accountId}`,
        origin: 'system',
        writes: newAccountWrites(accountId, result, args.name),
      });
      await deps.accounts.start(accountId);
    },
  };
}

function refuseDuplicate(store: StorePort, result: ConnectResult): void {
  const { address, subject } = result.identity;
  if (!accountWithIdentity(store, 'google', address, subject)) return;
  throw new ContractError({
    type: 'conflict',
    message: ALREADY_ADDED,
    reasonCode: 'account.exists',
  });
}

function newAccountWrites(accountId: string, result: ConnectResult, name?: string): StoreWrite[] {
  const { identity, grant } = result;
  const displayName = name?.trim() || identity.displayName;
  const account: StoreWrite = {
    kind: 'account',
    id: accountId,
    provider: 'google',
    address: identity.address,
    ...(displayName ? { displayName } : {}),
    capabilities: { ...result.capabilities },
    grantedScopes: result.grantedScopes,
    status: { state: 'starting' },
    remoteSubject: identity.subject,
    ...(grant ? { tokenGrantedAt: grant.grantedAt } : {}),
    ...(grant?.refreshExpiresAt !== undefined ? { refreshExpiresAt: grant.refreshExpiresAt } : {}),
    ...(grant?.client !== undefined ? { oauthClient: grant.client } : {}),
  };
  const memory = result.memory && Object.keys(result.memory).length ? result.memory : undefined;
  return memory ? [account, { kind: 'providerMemory', accountId, values: memory }] : [account];
}

/** Sign in again to an account that exists (the weekly reconnect, or a full re-consent for missing scopes). */
export function existingAccountFlow(
  deps: FlowDeps,
  mode: 'reconnect' | 'grantPermissions',
  accountId: string,
): ConnectFlow {
  const stored = storedIdentity(deps.store, accountId);
  if (!stored)
    throw new ContractError({ type: 'notFound', message: 'That account is not in Aplos.' });
  if (stored.provider !== 'google')
    throw new ContractError({ type: 'unsupported', message: GOOGLE_ONLY });
  return {
    mode,
    accountId,
    key: `account:${accountId}`,
    kind: 'google',
    request: {
      mode,
      loginHint: stored.address,
      address: stored.address,
      ...(stored.subject ? { expectedSubject: stored.subject } : {}),
    },
    accept: async result => {
      refuseOtherIdentity(stored, result);
      await deps.accounts.reconnected(accountId, result);
    },
  };
}

/** The host refuses another identity too; the engine checks again so a host that forgot cannot store the wrong grant. */
function refuseOtherIdentity(
  stored: { address: string; subject?: string },
  result: ConnectResult,
): void {
  const { subject, address } = result.identity;
  const same = stored.subject
    ? stored.subject === subject
    : stored.address.toLowerCase() === address.toLowerCase();
  if (same) return;
  throw new ContractError({
    type: 'needsReauth',
    message: WRONG_ACCOUNT,
    reasonCode: 'auth.wrongAccount',
  });
}
