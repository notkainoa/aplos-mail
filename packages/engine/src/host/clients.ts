import type { CommitExtension, CommitExtensionTx } from '../store/port';
import { StoreError } from '../store/port';

declare module '../store/port' {
  interface ExtensionWrites {
    client: ClientWrite;
  }
}

/** The fields a `Clients/grant` commit inserts. Only the SHA-256 of the token is stored, never the token. */
export interface ClientGrantWrite {
  name: string;
  clientKind: string;
  tokenHash: string;
  scopes: readonly string[];
  createdAt: number;
}

/** One `client` write (eng-host): a grant's row insert, or `revokedAt` stamped by `Clients/revoke`. */
export type ClientWrite =
  | { kind: 'client'; id: string; revokedAt: number }
  | { kind: 'client'; id: string; grant: ClientGrantWrite };

const invalid = () => new StoreError('invalid', 'A client write names a client');

function apply(write: { kind: string }, tx: CommitExtensionTx): void {
  const w = write as ClientWrite;
  if (typeof w.id !== 'string' || w.id.length === 0) throw invalid();
  if ('grant' in w) {
    const g = w.grant;
    const ok =
      typeof g?.name === 'string' &&
      g.name.length > 0 &&
      typeof g.clientKind === 'string' &&
      typeof g.tokenHash === 'string' &&
      g.tokenHash.length > 0 &&
      Array.isArray(g.scopes) &&
      g.scopes.every(s => typeof s === 'string') &&
      Number.isSafeInteger(g.createdAt);
    if (!ok) throw invalid();
    tx.run(
      `INSERT INTO clients(id, name, kind, token_hash, scopes, created_at) VALUES(?, ?, ?, ?, ?, ?)`,
      w.id,
      g.name,
      g.clientKind,
      g.tokenHash,
      JSON.stringify(g.scopes),
      g.createdAt,
    );
    tx.mark('Client', w.id, 'u');
    return;
  }
  // Only the first revoke stamps: a repeat must not move the time the tool was cut off.
  const gone = tx.run(
    'UPDATE clients SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    w.revokedAt,
    w.id,
  );
  if (gone.changes) tx.mark('Client', w.id, 'u');
}

export const clientExtension: CommitExtension = {
  lane: 'eng-host',
  kinds: ['client'],
  changeTypes: ['Client'],
  apply,
};
