import { ContractError } from '@aplos/contract/contract-error';
import { readBody } from '../store/bodies';
import type { BodyRecord, StoreReader } from '../store/port';
import type { EngineServices } from '../runtime/services';
import { splitId } from '../views/compile';

// A stored message by contract id (`accountId:remoteId`) and its provider-original body (ARCH 3.3), fetched through
// `ProviderPort.openThread` when it is not stored (absent, or evicted after 90 days).

export interface MessageRef {
  /** The contract id the caller named. */
  id: string;
  accountId: string;
  remoteId: string;
  rowId: number;
  threadRemoteId: string;
  /** The server's thread size (`threads.remote_count`), the `knownCount` an open passes (AM-1). */
  remoteCount: number | null;
  fromAddr: string | null;
}

interface RefRow {
  id: number;
  thread_remote: string;
  remote_count: number | null;
  from_addr: string | null;
  [k: string]: string | number | null;
}

export const messageGone = () =>
  new ContractError({ type: 'notFound', message: 'This message is no longer available.' });

export function findMessage(
  q: StoreReader,
  messageId: string,
  accounts?: readonly string[],
): MessageRef | undefined {
  const parts = splitId(q, messageId, accounts);
  if (!parts) return undefined;
  const row = q.get<RefRow>(
    `SELECT m.id, t.remote_id AS thread_remote, t.remote_count, m.from_addr FROM messages m
      JOIN threads t ON t.id = m.thread_id WHERE m.account_id = ? AND m.remote_id = ?`,
    parts.accountId,
    parts.remoteId,
  );
  if (!row) return undefined;
  return {
    id: messageId,
    accountId: parts.accountId,
    remoteId: parts.remoteId,
    rowId: row.id,
    threadRemoteId: row.thread_remote,
    remoteCount: row.remote_count,
    fromAddr: row.from_addr,
  };
}

export function requireMessage(services: EngineServices, messageId: string): MessageRef {
  const ref = services.store.read(q => findMessage(q, messageId));
  if (!ref) throw messageGone();
  return ref;
}

export function storedBody(services: EngineServices, ref: MessageRef): BodyRecord | undefined {
  return services.store.read(q => readBody(q, ref.accountId, ref.remoteId));
}

/** The stored body, or the provider's after opening the thread on `lane`; `notFound` when there is none to have. */
export async function loadBody(
  services: EngineServices,
  ref: MessageRef,
  lane: 'interactive' | 'prefetch' = 'interactive',
): Promise<BodyRecord> {
  const stored = storedBody(services, ref);
  if (stored) return stored;
  await services.accounts.openThread(ref.accountId, ref.threadRemoteId, {
    ...(ref.remoteCount !== null ? { knownCount: ref.remoteCount } : {}),
    lane,
  });
  const fetched = storedBody(services, ref);
  if (!fetched) throw messageGone();
  return fetched;
}

/** The inline parts' Content-IDs in the stored order: `cid/<n>` is `cids[n]`. */
export function cidsOf(body: BodyRecord): string[] {
  const map = body.cidMap;
  if (typeof map !== 'object' || map === null) return [];
  return Object.keys(map).filter(cid => typeof map[cid] === 'string');
}

/** The attachment part holding Content-ID `cid`, own keys only. */
export function partOf(body: BodyRecord | undefined, cid: string): string | undefined {
  const map = body?.cidMap;
  if (typeof map !== 'object' || map === null || !Object.hasOwn(map, cid)) return undefined;
  const part = map[cid];
  return typeof part === 'string' ? part : undefined;
}
