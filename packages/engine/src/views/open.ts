import type { Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { EngineServices } from '../runtime/services';
import { loadRetention } from '../host/module';
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
  // Opened mail keeps its text past the retention window (ARCH 3.6), stamped by the lazy retention module (a re-open
  // the same day writes nothing). Best effort: a failed load or stamp never fails the open itself.
  try {
    (await loadRetention()).markOpened(services, now);
  } catch {
    // The next open stamps it; at worst this thread's text is treated as unopened by one retention pass.
  }
  return {
    threadId,
    complete: now.complete === 1,
    state: { dbEpoch: store.dbEpoch, seq: store.seq() },
  };
}
