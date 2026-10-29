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
  /** `ProviderFactory.discardCredential`: deletes a bundle a connect stored when the engine refused the result. */
  discardCredential(ref: string): Promise<void>;
}

function withConnectGovernor(
  connect: GoogleConnect,
  source?: ConnectGovernorSource,
): GoogleConnect {
  if (!source) return connect;
  return (req, ctx) => connect(req, { ...ctx, governor: source.bindConnect(ctx.accountId) });
}

export function createGoogleHostConnect(deps: GoogleHostConnectDeps): GoogleHostConnect {
  const { clientInputs, governor, ...rest } = deps;
  const connect = createGoogleConnect({
    ...rest,
    resolveClient: () => resolveGoogleClient(clientInputs()),
  });
  return {
    connect: withConnectGovernor(connect, governor),
    discardCredential: async ref => {
      try {
        await deps.vault.delete(ref);
      } catch {
        throw connectError('transient', 'vaultDeleteFailed', { extra: { uncertain: false } });
      }
    },
  };
}
