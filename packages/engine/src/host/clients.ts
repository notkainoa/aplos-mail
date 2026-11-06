import type { CommitExtension, CommitExtensionTx } from '../store/port';
import { StoreError } from '../store/port';

declare module '../store/port' {
  interface ExtensionWrites {
    client: ClientWrite;
  }
}

/** One `client` write (eng-host): today only `revokedAt`, stamped by `Clients/revoke`. */
export interface ClientWrite {
  kind: 'client';
  id: string;
  revokedAt: number;
}

function apply(write: { kind: string }, tx: CommitExtensionTx): void {
  const w = write as ClientWrite;
  if (typeof w.id !== 'string' || w.id.length === 0)
    throw new StoreError('invalid', 'A client write names a client');
  const gone = tx.run('UPDATE clients SET revoked_at = ? WHERE id = ?', w.revokedAt, w.id);
  if (gone.changes) tx.mark('Client', w.id, 'u');
}

export const clientExtension: CommitExtension = {
  lane: 'eng-host',
  kinds: ['client'],
  changeTypes: ['Client'],
  apply,
};
