// How the host builds the Google adapter's connect half (plan 20 PV5): `createGoogleConnect` over the host's HTTP
// client, browser launcher, OAuth client inputs and vault, plus the factory's `discardCredential`. Spread the result
// into `createGoogleProvider` options. There is no host composition root for the new engine yet; it calls this.

import type { AccountId, BoundGovernor } from '@aplos/engine/ports';
import { resolveGoogleClient, type GoogleClientInputs } from './client';
import { connectError } from './connect-errors';
import { createGoogleConnect, type GoogleConnect, type GoogleConnectDeps } from './connect';

/** The engine's governor (`sync/governor.ts`): connect-time calls ignore the account's auth block, nothing else. */
export interface ConnectGovernorSource {
  bindConnect(account: AccountId): BoundGovernor;
}

/** `knownSubject` comes from the engine store at the composition root (an account row with that `remote_subject`). */
export interface GoogleHostConnectDeps extends Omit<GoogleConnectDeps, 'resolveClient'> {
  /** The environment, the Settings client and the bundled one, read again at each connect. */
  clientInputs(): GoogleClientInputs;
  /**
   * When given, every connect runs on `governor.bindConnect(accountId)` whatever governor the caller passed.
   * `AccountActorHost.connect` already passes that binding; this keeps any other caller from using the account's
   * ordinary one, whose auth block would stop the reconnect that ends it.
   */
  governor?: ConnectGovernorSource;
  /**
   * Whether the engine store holds a committed row for this account id. A ref minted for an account that has one is
   * a live credential and is never deleted (the engine checks the same rule; this keeps the host safe on its own).
   * Required: an optional check would be silently off wherever the composition root forgot it.
   */
  accountIsCommitted(accountId: string): boolean;
}

export interface GoogleHostConnect {
  connect: GoogleConnect;
  /**
   * `ProviderFactory.discardCredential`: deletes a bundle a NEW connect of this host stored in this process, when the
   * engine refused the result. Any other ref (a reconnect's, which is a live account's; one from before a restart; a
   * guessed or malformed one) is refused and nothing is deleted.
   */
  discardCredential(ref: string): Promise<void>;
  /**
   * `ProviderFactory.forgetAccount`: deletes the account's token bundle (`refFor(accountId)`) once the engine removed
   * it. Refused while the account still has a committed row. The grant is not revoked at Google: whether a revoke
   * ends only this token or the user's whole grant for this client is still unproven (connect.ts TODO(live)), and a
   * whole-grant revoke would sign the same account out on the owner's other Macs.
   */
  forgetAccount(accountId: string): Promise<void>;
}

function withConnectGovernor(
  connect: GoogleConnect,
  source?: ConnectGovernorSource,
): GoogleConnect {
  if (!source) return connect;
  return (req, ctx) => connect(req, { ...ctx, governor: source.bindConnect(ctx.accountId) });
}

const printable = (ref: string) =>
  [...ref].every(ch => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f);

/** Non-empty, bounded, printable, and nothing a path or key scheme could read as another entry. */
export function wellFormedRef(ref: unknown): ref is string {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 256) return false;
  return printable(ref) && !/[/\\]/.test(ref) && !ref.includes('..');
}

/** Remembers ref -> account id of every new connect that stored a bundle; a reconnect's ref is a live account's. */
function minting(connect: GoogleConnect, minted: Map<string, string>): GoogleConnect {
  return async (req, ctx) => {
    const result = await connect(req, ctx);
    if (req.mode === 'new') minted.set(result.credentialRef, ctx.accountId);
    return result;
  };
}

function discarder(deps: GoogleHostConnectDeps, minted: Map<string, string>) {
  return async (ref: string): Promise<void> => {
    const owner = minted.get(ref);
    // Minted by a new connect here, and the account it was minted for has no committed row since.
    if (!wellFormedRef(ref) || owner === undefined || deps.accountIsCommitted(owner)) {
      throw connectError('permanent', 'notThisHostsCredential', { extra: { uncertain: false } });
    }
    try {
      await deps.vault.delete(ref);
    } catch {
      throw connectError('transient', 'vaultDeleteFailed', { extra: { uncertain: false } });
    }
  };
}

function forgetter(deps: GoogleHostConnectDeps, minted: Map<string, string>) {
  return async (accountId: string): Promise<void> => {
    if (deps.accountIsCommitted(accountId)) {
      throw connectError('permanent', 'accountStillHeld', { extra: { uncertain: false } });
    }
    const ref = deps.refFor ? deps.refFor(accountId) : accountId;
    if (!wellFormedRef(ref)) return;
    minted.delete(ref);
    try {
      await deps.vault.delete(ref);
    } catch {
      throw connectError('transient', 'vaultDeleteFailed', { extra: { uncertain: false } });
    }
  };
}

export function createGoogleHostConnect(deps: GoogleHostConnectDeps): GoogleHostConnect {
  const { clientInputs, governor, ...rest } = deps;
  const minted = new Map<string, string>();
  const connect = createGoogleConnect({
    ...rest,
    resolveClient: () => resolveGoogleClient(clientInputs()),
  });
  return {
    connect: withConnectGovernor(minting(connect, minted), governor),
    discardCredential: discarder(deps, minted),
    forgetAccount: forgetter(deps, minted),
  };
}
