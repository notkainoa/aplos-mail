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
}

export interface GoogleHostConnect {
  connect: GoogleConnect;
  /**
   * `ProviderFactory.discardCredential`: deletes a bundle a NEW connect of this host stored in this process, when the
   * engine refused the result. Any other ref (a reconnect's, which is a live account's; one from before a restart; a
   * guessed or malformed one) is refused and nothing is deleted.
   */
  discardCredential(ref: string): Promise<void>;
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

/** Remembers the ref of every new connect that stored a bundle; a reconnect's ref is a live account's. */
function minting(connect: GoogleConnect, minted: Set<string>): GoogleConnect {
  return async (req, ctx) => {
    const result = await connect(req, ctx);
    if (req.mode === 'new') minted.add(result.credentialRef);
    return result;
  };
}

function discarder(deps: GoogleHostConnectDeps, minted: ReadonlySet<string>) {
  return async (ref: string): Promise<void> => {
    if (!wellFormedRef(ref) || !minted.has(ref)) {
      throw connectError('permanent', 'notThisHostsCredential', { extra: { uncertain: false } });
    }
    try {
      await deps.vault.delete(ref);
    } catch {
      throw connectError('transient', 'vaultDeleteFailed', { extra: { uncertain: false } });
    }
  };
}

export function createGoogleHostConnect(deps: GoogleHostConnectDeps): GoogleHostConnect {
  const { clientInputs, governor, ...rest } = deps;
  const minted = new Set<string>();
  const connect = createGoogleConnect({
    ...rest,
    resolveClient: () => resolveGoogleClient(clientInputs()),
  });
  return {
    connect: withConnectGovernor(minting(connect, minted), governor),
    discardCredential: discarder(deps, minted),
  };
}
