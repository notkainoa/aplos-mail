import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { timingSafeEqual, createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ClientTokens } from '@aplos/engine/ports';
import type { StorePort } from '@aplos/engine/store';

/**
 * Client token issuing for `Clients/grant` (host-5, the `ClientTokens` port): the 256-bit token lands in a
 * 0600 file under `<dataDir>/run/clients/` (0700) that only the tool's own CLI, MCP or preview client reads.
 * The engine stores only the token's SHA-256; the plaintext never crosses the contract, never a log field
 * and never a window. This module also hosts the socket/HTTP token compare when those transports land.
 */
export function createClientTokens(options: { dataDir: string }): ClientTokens {
  const dir = join(options.dataDir, 'run', 'clients');
  return {
    async issue(clientId, token) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const path = join(dir, `${clientId}.token`);
      // `wx` never overwrites: a re-issued id fails rather than swapping a live tool's secret.
      writeFileSync(path, `${token}\n`, { mode: 0o600, flag: 'wx' });
      return { path };
    },
    async remove(clientId) {
      rmSync(join(dir, `${clientId}.token`), { force: true });
    },
    pathOf: clientId => join(dir, `${clientId}.token`),
    async has(clientId) {
      return existsSync(join(dir, `${clientId}.token`));
    },
  };
}

/**
 * Whether a presented token authenticates a live client (host-5's transport auth, the socket/HTTP/MCP
 * listeners' verify path): the stored SHA-256 is compared with `timingSafeEqual` (no early exit on a prefix
 * match), and the `revoked_at IS NULL` lookup runs per request so a revoke takes effect on the very next call.
 * Returns the client's stored scopes and kind — the caller builds `listenerCaller` from this row, never from
 * the hello frame (freeze R2B-3).
 */
export function verify(
  store: StorePort,
  token: string,
): { clientId: string; kind: string; scopes: string[] } | undefined {
  if (!/^[0-9a-f]{64}$/.test(token)) return undefined;
  const hash = createHash('sha256').update(token, 'utf8').digest();
  const rows = store.read(q =>
    q.all<{ id: string; kind: string; token_hash: string; scopes: string }>(
      'SELECT id, kind, token_hash, scopes FROM clients WHERE revoked_at IS NULL',
    ),
  );
  for (const r of rows) {
    const stored = Buffer.from(r.token_hash, 'hex');
    if (stored.length === hash.length && timingSafeEqual(stored, hash)) {
      try {
        return { clientId: r.id, kind: r.kind, scopes: JSON.parse(r.scopes) as string[] };
      } catch {
        return { clientId: r.id, kind: r.kind, scopes: [] };
      }
    }
  }
  return undefined;
}
