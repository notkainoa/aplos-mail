import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppState } from '../shared/types';

/** One small, atomic JSON document. Tokens are owned by the Google credential adapter. */
export function createStore(dataDir:string) {
  mkdirSync(dataDir, { recursive:true, mode:0o700 });
  const path = join(dataDir, 'state.json');
  function read():AppState|undefined {
    if (!existsSync(path)) return;
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.accounts) || !Array.isArray(value.threads) ||
        !Array.isArray(value.drafts) || !Array.isArray(value.events) || !Array.isArray(value.conversations) ||
        !value.settings || !Array.isArray(value.blockedSenders)) throw new Error('Invalid state format');
      return value as AppState;
    } catch {
      // Keep the original evidence for recovery. Never silently overwrite a damaged mailbox.
      const backup = `${path}.damaged-${Date.now()}`;
      copyFileSync(path, backup);
      throw new Error(`The saved mailbox could not be read. A recovery copy is available at ${backup}.`);
    }
  }
  function write(value:AppState) {
    const temporary = `${path}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(value), { encoding:'utf8', mode:0o600 });
      renameSync(temporary, path);
    } catch { throw new Error('The mailbox could not be saved. Check free space and folder permissions.'); }
  }
  return { read, write, path };
}
