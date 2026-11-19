import type { Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { EngineServices } from '../runtime/services';
import { threadByContractId } from './rows';

/*
 * `Thread/open` (views-3): the reader opened a thread. A complete local thread is served from the store with no
 * provider call; a partial one (built from one metadata message) is fetched whole through `ProviderPort.openThread` in
 * the interactive lane, with the server's own message count as `knownCount` (AM-1). The provider commits what it
 * fetched, so the answer is read back from the store, and an account that cannot be reached answers `unavailable`.
 */

type Opened = Output<'Thread/open'>;

const gone = () =>
  new ContractError({ type: 'notFound', message: 'This conversation is no longer available.' });

export async function openThread(services: EngineServices, threadId: string): Promise<Opened> {
  const { store } = services;
  const t = store.read(q => threadByContractId(q, threadId));
  if (!t) throw gone();
  if (t.complete === 0)
    await services.accounts.openThread(t.account_id, t.remote_id, {
      ...(t.remote_count !== null ? { knownCount: t.remote_count } : {}),
      lane: 'interactive',
    });
  const now = store.read(q => threadByContractId(q, threadId));
  if (!now) throw gone();
  // Opened mail keeps its text past the retention window (ARCH 3.6); no change row, nothing on screen moves.
  const at = services.clock.now();
  store.commit({
    opId: `read:${threadId}:${at}`,
    origin: 'local',
    writes: [{ kind: 'bodyRead', accountId: now.account_id, remoteThreadId: now.remote_id, at }],
  });
  return {
    threadId,
    complete: now.complete === 1,
    state: { dbEpoch: store.dbEpoch, seq: store.seq() },
  };
}
