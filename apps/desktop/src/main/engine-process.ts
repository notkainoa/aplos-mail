// A static import: a lazy `import()` makes esbuild wrap every engine module in an `__esm` initializer, which keeps the
// outbox's kill-point module names in a release bundle (packages/engine/tests/outbox/release-grep.test.ts).
import { startEngineUtility } from './engine-utility';

/**
 * Entry point of the engine's utility process. Sync, the database and AI requests run here so a large
 * mailbox never blocks the windows; the main process keeps the keychain, links and notifications.
 */
startEngineUtility();
