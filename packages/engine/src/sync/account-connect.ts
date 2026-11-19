import { ContractError } from '@aplos/contract/contract-error';
import type { Input } from '@aplos/contract';
import type { AccountActorHost, ConnectRequest, ConnectResult } from '../ports';
import type { StorePort, StoreWrite } from '../store/port';
import { accountWithIdentity, storedIdentity } from './account-read';
import { discardCredential, hexId, type ConnectFlow } from './connect-sessions';
import { hasRequiredScope, MISSING_MAIL_SCOPE } from './scopes';

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
  const address = args.address ?? args.loginHint;
  // Refused before any browser opens. A row still `starting` is a connect whose actor never started: a retry may finish it.
  const earlier = address ? accountWithIdentity(deps.store, 'google', address) : undefined;
  refuseAdded(earlier);
  // A retry signs in under the id of the row that is waiting to start, so the host stores the credential there.
  const retried = earlier ? storedIdentity(deps.store, earlier.id) : undefined;
  const accountId = earlier?.id ?? hexId(deps.randomBytes, 'a');
  return {
    mode: 'new',
    accountId,
    key: `new:${address?.toLowerCase() ?? ''}`,
    kind: 'google',
    request: newAccountRequest(args, address, retried?.subject),
    accept: result =>
      earlier
        ? acceptRetry(deps, accountId, result)
        : acceptNewAccount(deps, accountId, args.name, result),
  };
}

/**
 * A retry overwrites the waiting row's credential, so the host must check whose account it is before it stores
 * anything: the row's subject when it has one, else the requested address.
 */
function newAccountRequest(
  args: ConnectArgs,
  address: string | undefined,
  expectedSubject: string | undefined,
): ConnectRequest {
  return {
    mode: 'new',
    ...(args.loginHint ? { loginHint: args.loginHint } : {}),
    ...(address ? { address } : {}),
    ...(expectedSubject ? { expectedSubject } : {}),
    ...(args.preset === 'gmail' ? { preset: 'gmail' as const } : {}),
  };
}

async function acceptNewAccount(
  deps: FlowDeps,
  accountId: string,
  name: string | undefined,
  result: ConnectResult,
): Promise<{ accountId: string }> {
  try {
    refuseMissingScope(result);
    const { address, subject } = result.identity;
    // Any match is refused, a waiting row too: the host stored this credential under the new id, not under that row's.
    if (accountWithIdentity(deps.store, 'google', address, subject)) throw alreadyAdded();
    deps.store.commit({
      opId: `connect:${accountId}`,
      origin: 'system',
      writes: newAccountWrites(accountId, result, name),
    });
  } catch (error) {
    // The host stored the credential under `accountId` before the engine could refuse the answer: hand it back.
    discardCredential(deps.accounts, accountId, 'google', result.credentialRef);
    throw error;
  }
  await deps.accounts.start(accountId);
  return { accountId };
}

/**
 * The answer to a retry on the waiting row `accountId`: it must be that row's identity and no other row's, read again
 * now. The row is already committed (its `connect:` opId replays as a no-op), so it is resumed, never committed.
 */
async function acceptRetry(
  deps: FlowDeps,
  accountId: string,
  result: ConnectResult,
): Promise<{ accountId: string }> {
  try {
    const current = storedIdentity(deps.store, accountId);
    if (!current) throw notFound();
    // The host stored this grant under `accountId` before the engine could refuse it; the catch hands it back.
    // Limit: a retry stores under the waiting row's id, and that row is committed, so the engine never discards (host.ts
    // `discardCredential` keeps it): a grant refused here, for lacking the mail scope or for an identity another row
    // holds, stays in the vault under that id. A different identity is normally refused earlier, by the host's address
    // check (a new connect that names an address is held to it) before anything is stored.
    refuseOtherIdentity(current, result);
    refuseMissingScope(result);
    const { address, subject } = result.identity;
    if (accountWithIdentity(deps.store, 'google', address, subject, accountId))
      throw alreadyAdded();
  } catch (error) {
    discardCredential(deps.accounts, accountId, 'google', result.credentialRef);
    throw error;
  }
  return resume(deps, accountId, result);
}

/**
 * A retry for an account whose row was committed but whose actor never started (`start` threw): keep the row, store the
 * new grant, and start again instead of refusing it as already added.
 */
async function resume(
  deps: FlowDeps,
  accountId: string,
  result: ConnectResult,
): Promise<{ accountId: string }> {
  await deps.accounts.reconnected(accountId, result);
  await deps.accounts.start(accountId);
  return { accountId };
}

/** Before anything is saved or started: a grant without the mail scope never becomes an account or lifts a block. */
export function refuseMissingScope(result: ConnectResult): void {
  if (hasRequiredScope(result)) return;
  throw new ContractError({
    type: 'permission',
    message: MISSING_MAIL_SCOPE,
    reasonCode: 'permission.mailModify',
  });
}

function refuseAdded(existing: { status: string } | undefined): void {
  if (!existing || existing.status === 'starting') return;
  throw alreadyAdded();
}

function alreadyAdded() {
  return new ContractError({
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
    // Owner decision (2026-11-06): a new account permits its mail for AI by default. It only PERMITS —
    // no mail text leaves the device until a provider exists and the background consent is granted.
    // Reconnects never write this column, so an account the owner turned off stays off.
    aiAllowed: true,
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
  enable?: 'calendarWrite',
): ConnectFlow {
  const stored = storedIdentity(deps.store, accountId);
  if (!stored) throw notFound();
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
      // Only the explicit re-grant carries it; a plain reconnect can never widen the grant.
      ...(mode === 'grantPermissions' && enable ? { enable } : {}),
    },
    accept: async result => {
      // Read again: the account may have changed or gone while the browser was open.
      const current = storedIdentity(deps.store, accountId);
      if (!current) throw notFound();
      // No discard on a refused reconnect: the ref is the live account's own bundle, and the host deletes only refs
      // it minted for a new connect.
      refuseOtherIdentity(current, result);
      refuseMissingScope(result);
      await deps.accounts.reconnected(accountId, result);
    },
  };
}

function notFound() {
  return new ContractError({ type: 'notFound', message: 'That account is not in Aplos.' });
}

/**
 * The host refuses another identity too; the engine checks again so a host that forgot cannot store the wrong grant.
 * A stored subject must match exactly. An account saved before subjects were kept has none: the address match is accepted
 * once, and `reconnected` then stores the subject Google returned (the first and only adoption; from then on it is compared).
 */
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
