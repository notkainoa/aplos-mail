import { createService } from './service';
import { serveEngine } from './engine-rpc';
import { createCipher } from './keyring';
import { REAL_ENGINE_ARG } from '../host/transports/port';
// A static import: a lazy `import()` makes esbuild wrap every engine module in an `__esm` initializer, which keeps the
// outbox's kill-point module names in a release bundle (packages/engine/tests/outbox/release-grep.test.ts).
import { startEngineUtility } from './engine-utility';

/**
 * Entry point of the engine's utility process. Sync, the database and AI requests run here so a large
 * mailbox never blocks the windows; the main process keeps the keychain, links and notifications.
 * Forked with `REAL_ENGINE_ARG` (the default engine, contract-4) it runs the new engine instead (`engine-utility.ts`).
 */
function serveLegacy() {
  const parent = process.parentPort;
  serveEngine(
    {
      post: message => parent.postMessage(message),
      listen: handler => parent.on('message', event => handler(event.data)),
    },
    async (init, call) => {
      const cipher = init.key ? createCipher(init.key) : undefined;
      const missing = () =>
        new Error(init.keyError || 'macOS secure credential storage is unavailable.');
      return createService({
        dataDir: init.dataDir,
        desktop: true,
        symbolTool: init.symbolTool,
        openExternal: url => call('openExternal', url),
        encrypt: value => {
          if (!cipher) throw missing();
          return cipher.encrypt(value);
        },
        decrypt: value => {
          if (!cipher) throw missing();
          return cipher.decrypt(value);
        },
      });
    },
    () => process.exit(0),
  );
}

if (process.argv.includes(REAL_ENGINE_ARG)) startEngineUtility();
else serveLegacy();
