import type { Caller } from '@aplos/contract/access';
import { StoreError, type CommitExtension, type CommitExtensionTx } from '../store/port';

// The writer for `audit_log` (seam 2, lane `eng-host`): which listener client called which audited method on what. It is
// content-free (a method name and an optional target id, never a body or a subject). A handler of a contract method
// marked `audit: true` appends `auditWrites(caller, method, target)` to the writes of its own commit, so the row lands
// in the same transaction as the change it records or not at all. A window's or main's call is the owner acting and
// writes nothing.

/** One audit row. */
export interface AuditWrite {
  kind: 'audit';
  clientId: string;
  /** The contract method, such as `Mail/allowImages`. */
  method: string;
  /** What it acted on (an id or a normalised key), never content. */
  target?: string;
}

declare module '../store/port' {
  interface ExtensionWrites {
    audit: AuditWrite;
  }
}

/**
 * The longest client id, method name or target stored: the contract's `Id` bound, so no id the contract accepts can fail
 * an audited call. Longer is refused, not cut, so a row never names something else.
 */
const MAX_FIELD = 1_000;

/**
 * The audit writes for one call: one row for a listener client, none for a window or main. Spread it into the
 * commit's `writes`: `writes: [change, ...auditWrites(caller, 'Mail/allowImages', sender)]`.
 */
export function auditWrites(caller: Caller, method: string, target?: string): AuditWrite[] {
  if (caller.kind !== 'listener') return [];

  // A listener the transport did not identify never reaches a handler (`principalOf` refuses it); refuse here too.
  if (!caller.clientId) throw new StoreError('invalid', 'An audited call needs a client id');
  return [
    {
      kind: 'audit',
      clientId: caller.clientId,
      method,
      ...(target === undefined ? {} : { target }),
    },
  ];
}

function apply(write: { kind: string }, tx: CommitExtensionTx): void {
  const w = write as AuditWrite;
  const bad = (value: unknown, required: boolean) =>
    value === undefined
      ? required
      : typeof value !== 'string' || value.length === 0 || value.length > MAX_FIELD;
  if (bad(w.clientId, true) || bad(w.method, true) || bad(w.target, false))
    throw new StoreError('invalid', 'An audit row is a client id, a method and an optional target');
  tx.run(
    'INSERT INTO audit_log(at, client_id, method, target) VALUES(?, ?, ?, ?)',
    tx.now(),
    w.clientId,
    w.method,
    w.target ?? null,
  );
}

export const auditExtension: CommitExtension = {
  lane: 'eng-host',
  kinds: ['audit'],
  changeTypes: [],
  apply,
};
