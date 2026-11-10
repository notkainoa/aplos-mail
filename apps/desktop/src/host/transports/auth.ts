import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientTokens } from '@aplos/engine/ports';

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
  };
}
