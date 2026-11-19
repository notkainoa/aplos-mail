import { ContractError } from '@aplos/contract/contract-error';
import type { BodyRecord, StoreReader } from '../store/port';
import type { EngineServices } from '../runtime/services';
import { splitId } from '../views/compile';

// A stored message by contract id (`accountId:remoteId`). Its provider-original body (ARCH 3.3) is read or fetched by
// `loadBody` in the lazy `render.ts`.

export interface MessageRef {
  /** The contract id the caller named. */
  id: string;
  accountId: string;
  remoteId: string;
  rowId: number;
  /** The seq that stored this row: with `rowId`, which stored copy this is (a re-insert can reuse a freed rowid). */
  firstSeenSeq: number;
  threadRemoteId: string;
  /** The server's thread size (`threads.remote_count`), the `knownCount` an open passes (AM-1). */
  remoteCount: number | null;
  fromAddr: string | null;
}

interface RefRow {
  id: number;
  first_seen_seq: number;
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
    `SELECT m.id, m.first_seen_seq, t.remote_id AS thread_remote, t.remote_count, m.from_addr FROM messages m
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
    firstSeenSeq: row.first_seen_seq,
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
