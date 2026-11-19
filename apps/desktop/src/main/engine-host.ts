import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  safeStorage,
  utilityProcess,
} from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { connectEngine, type EngineInit } from './engine-rpc';
import { KeyringError, createCipher, loadDataKey, migrateCredentials } from './keyring';
import { applyChanges, type StateChanges } from '@aplos/contract/legacy/live';
import { draftMutationId } from './desktop-policy';
import type { AppState, Listener } from '@aplos/contract/legacy/types';
import { assertCaller, external } from './security';
import { claims, emit, applyAppearance } from './windows';
import { nativeMethods, notify, invokeNative, sweepAttachmentTemp } from './native-methods';
import { closing } from './lifecycle';
import { legacyEngineMethods } from '@aplos/contract/allowlists';
import { dataDirOverride } from './test-mode';
import { realEngineRequested } from '../host/transports/port';
import { releaseBuild } from './oauth-config';
import { bootRealEngine, realEngine } from './engine-real';
import { registerMailScheme } from './mail-protocol';

/** The engine's data folder: the test or development override, else the app's own folder. */
const dataFolder = () => dataDirOverride ?? app.getPath('userData');
/** What `realEngineRequested` needs from the folder: plain file checks, nothing opened or written. */
function folderFacts(dir: string) {
  return {
    legacyMail: existsSync(join(dir, 'aplos.db')) || existsSync(join(dir, 'state.json')),
    newStore: existsSync(join(dir, 'mail.db')),
  };
}
/**
 * The new engine in its utility process, no state mirror in main: the default, except on a folder that still holds
 * 0.2.x mail and no `mail.db` (no importer yet; see `realEngineRequested`).
 */
const realPath = realEngineRequested(process.env, releaseBuild, folderFacts(dataFolder()));
// The sealed mail frame's scheme (html-5): registered at import, before app ready as Electron requires, and only on the
// real path. The legacy path registers no scheme, so Chromium does not know `aplos-mail:` there.
if (realPath) registerMailScheme();

const methods = new Set<string>(legacyEngineMethods);
type Engine = ReturnType<typeof connectEngine>;
/** The mailbox engine in its utility process; replaced if that process stops unexpectedly. */
let service: Engine | undefined;
const restarts: number[] = [];
let latestState: AppState | undefined;
function engineEvent(event: Parameters<Listener>[0]) {
  if (event.type === 'changes') {
    const changes = event.payload as StateChanges;
    if (latestState?.epoch === changes.epoch) {
      latestState = applyChanges(latestState, changes);
      applyAppearance(latestState);
    }
  }
  if (event.type === 'reminder') {
    const payload = event.payload as { threadId: string; title: string };
    const thread = latestState?.threads.find(item => item.id === payload.threadId);
    if (
      latestState?.settings.notifications &&
      (!thread || latestState.settings.accountNotifications[thread.accountId] !== false)
    )
      notify('Aplos Mail reminder', payload.title, payload.threadId);
  }
  if (event.type === 'notification') {
    const payload = event.payload as { title?: string; body?: string; threadId?: string };
    if (latestState?.settings.notifications)
      notify(
        payload.title || 'Aplos Mail',
        payload.body || 'You have a reminder.',
        payload.threadId,
      );
  }
  emit(event);
}
/** Unwrap the credential key with the keychain and re-seal credentials saved before it existed. */
async function engineInit(dataDir: string): Promise<EngineInit> {
  const init: EngineInit = {
    dataDir,
    symbolTool: app.isPackaged
      ? join(process.resourcesPath, 'bin', 'aplos-symbols')
      : join(__dirname, '..', 'bin', 'aplos-symbols'),
  };
  const keychain = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value: string) => safeStorage.encryptString(value),
    decrypt: (value: Buffer) => safeStorage.decryptString(value),
  };
  try {
    init.key = await loadDataKey(dataDir, keychain);
  } catch (error) {
    // Only the keyring's own plain messages reach the window; a raw file error names the data folder and key file.
    console.error('Aplos Mail: the credential key could not be loaded:', error);
    init.keyError =
      error instanceof KeyringError
        ? error.message
        : 'macOS secure credential storage is unavailable.';
    return init;
  }
  // A credential file that fails to migrate only affects its own accounts, so the key is still handed over.
  const report = (file: string, error: unknown) =>
    console.error(
      `Aplos Mail: could not re-seal ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  await migrateCredentials(dataDir, keychain.decrypt, createCipher(init.key), report).catch(error =>
    report('credentials', error),
  );
  return init;
}
async function startEngine(init: EngineInit): Promise<Engine> {
  const child = utilityProcess.fork(join(__dirname, 'engine.cjs'), [], {
    serviceName: 'Aplos Mail Engine',
    env: process.env,
  });
  const engine = connectEngine(
    {
      post: message => child.postMessage(message),
      listen: handler => child.on('message', handler),
    },
    init,
    async (method, args) => {
      if (method === 'openExternal') {
        await external(args[0]);
        return true;
      }
      throw new Error('Unsupported engine request.');
    },
  );
  engine.subscribe(engineEvent);
  let exited = false;
  child.once('exit', () => {
    exited = true;
    // Before ready this also rejects `started`, so the caller of a failed start does the accounting.
    engine.fail(new Error('The mailbox stopped unexpectedly. Aplos is reopening it.'));
    if (service !== engine || closing) return;
    service = undefined;
    restartEngine(init);
  });
  try {
    await engine.started;
  } catch (error) {
    if (!exited) child.kill();
    throw error;
  }
  return engine;
}
/** Replace a stopped engine. Failed starts count too, so a crash loop ends in a dialog instead of retrying forever. */
function restartEngine(init: EngineInit, lastError?: unknown) {
  if (closing) return;
  const now = Date.now();
  restarts.push(now);
  while (restarts.length && now - restarts[0] > 60_000) restarts.shift();
  if (restarts.length > 3) {
    const detail = lastError instanceof Error ? ` (${lastError.message})` : '';
    dialog.showErrorBox(
      'Aplos Mail stopped',
      `The mailbox keeps stopping unexpectedly${detail}. Quit and reopen Aplos Mail.`,
    );
    return;
  }
  void startEngine(init).then(
    next => {
      if (closing) {
        void next.close();
        return;
      }
      service = next;
      void next.invoke('state.get').then(
        state => {
          latestState = state as AppState;
          applyAppearance(latestState);
          emit({ type: 'state', payload: latestState });
        },
        () => {
          /* If it stopped, its exit handler restarts it. */
        },
      );
    },
    error => {
      setTimeout(() => restartEngine(init, error), 1000);
    },
  );
}
/** `noteExit` counts an engine stop toward the park (lifecycle.ts); the legacy path keeps its own restart dialog. */
async function bootEngine(hooks: { noteExit(): boolean; noteRestart?(): void }) {
  const dataDir = dataFolder();
  // Folders an opened attachment left in the temp directory in earlier sessions (either engine path).
  void sweepAttachmentTemp().catch(() => undefined);
  if (realPath)
    return bootRealEngine({
      dataDir,
      noteExit: hooks.noteExit,
      ...(hooks.noteRestart ? { noteRestart: hooks.noteRestart } : {}),
    });
  service = await startEngine(await engineInit(dataDir));
  ipcMain.handle('aplos:invoke', async (event, method: unknown, payload: unknown) => {
    assertCaller(event);
    if (typeof method !== 'string') throw new Error('Invalid application method.');
    // Paste reads the clipboard here and hands the key straight to the engine, so it never passes through the renderer.
    if (method === 'ai.key.paste') {
      if (!service) throw new Error('The mailbox is restarting. Try again in a moment.');
      return service.invoke('ai.key.set', {
        provider: (payload as { provider?: unknown } | undefined)?.provider,
        key: clipboard.readText(),
      });
    }
    if (nativeMethods.has(method)) return invokeNative(event, method, payload);
    if (!methods.has(method)) throw new Error('Unsupported application method.');
    const draftId = draftMutationId(method, payload);
    if (draftId) claims.assertEditable(draftId, BrowserWindow.fromWebContents(event.sender)!.id);
    if (!service) throw new Error('The mailbox is restarting. Try again in a moment.');
    return service.invoke(method, payload);
  });
  latestState = (await service.invoke('state.get')) as AppState;
  applyAppearance(latestState);
}

export { latestState, service, bootEngine, realPath, realEngine };
