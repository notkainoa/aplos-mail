import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  MessageChannelMain,
  safeStorage,
  shell,
  utilityProcess,
  type IpcMainInvokeEvent,
  type MessagePortMain,
} from 'electron';
import os from 'node:os';
import { join } from 'node:path';
import { HostEvent, NotificationItem, parseArgs, type MethodName } from '@aplos/contract';
import type { PendingWork, SessionFacts } from '../host/lifecycle';
import { engineSyncFacts, type SyncFacts } from '../host/menu-bar';
import {
  createEngineLink,
  createEngineSupervisor,
  createPortBroker,
  draftOpenable,
  REAL_ENGINE_ARG,
  REAL_ENGINE_SERVICE,
  revokeOnNewDocument,
  signInURL,
  trustedCaller,
  type DesktopFrame,
  type EngineLink,
  type PortWindow,
  type Timers,
  type UtilityInit,
  type UtilityRequest,
} from '../host/transports/port';
import { KeyringError, loadDataKey } from './keyring';
import { invokeNative, nativeMethods, notify, openBytes, saveBytes } from './native-methods';
import { guardedDesktopCall } from '../shared/desktop-error';
import { SNIFFED_EXTENSIONS } from '../shared/file-sniff';
import { extensionOf, fileNameOf, legacyNames, v1Result } from '../shared/desktop-v1';
import { allowMailFrames, assertCaller, trustedURL } from './security';
import { installMailProtocol } from './mail-protocol';
import { limitInFlight, SERVE_TIMEOUT_MS, type ServeArgs } from '../host/protocol/relay';
import { isTest } from './test-mode';
import { hostTheme, popout } from './windows';

/**
 * Main's half of the real engine path (lane eng-contract, contract-4), the default (`realEngineRequested`). Main forks the
 * new engine in a utility process, gives each window's trusted main frame its own MessagePort, and keeps only its control
 * connection, the native methods and the host channel. Main holds no copy of mail state here; the transport logic is
 * in `host/transports/port.ts`, which this file wires to Electron.
 */

const timers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: handle => clearTimeout(handle as NodeJS.Timeout),
};

let supervisor: ReturnType<typeof createEngineSupervisor> | undefined;
const link = () => supervisor?.current();
const ok = { ok: true } as const;

function portWindow(win: BrowserWindow): PortWindow {
  const contents = win.webContents;
  return {
    id: win.id,
    isDestroyed: () => win.isDestroyed() || contents.isDestroyed(),
    trusted: () => !contents.isDestroyed() && trustedURL(contents.mainFrame.url),
    deliver: (port, generation) =>
      contents.mainFrame.postMessage('aplos:engine-port', { generation }, [
        port as MessagePortMain,
      ]),
    desktop: frame => contents.send('aplos:desktop', frame),
  };
}

const broker = createPortBroker({
  channel: () => {
    const { port1, port2 } = new MessageChannelMain();
    return { engineEnd: port1, windowEnd: port2 };
  },
  link,
});

const engineFrame = (state: 'connecting' | 'ready' | 'parked'): DesktopFrame => ({
  frame: 'desktop',
  event: {
    type: 'engine',
    state,
    at: Date.now(),
    ...(state === 'parked' ? { reasonCode: 'engine.parked', canRetry: true } : {}),
  },
});

function openSignIn(raw: unknown) {
  const url = signInURL(raw);
  if (!url) throw new Error('Only a provider sign-in page can be opened.');
  return shell.openExternal(url);
}

const themes: ReadonlySet<string> = new Set(['light', 'dark', 'system']);

/** Typed host-channel events (plan 10 E3 item 6). Anything that fails the contract's schema is ignored. */
function hostEvent(raw: unknown) {
  const parsed = HostEvent.safeParse(raw);
  if (!parsed.success) return;
  const event = parsed.data;
  if (event.type === 'badge' && !isTest) app.setBadgeCount(event.count);
  // An open enum: a theme a newer engine adds is ignored here.
  if (event.type === 'appearance' && themes.has(event.theme))
    hostTheme(event.theme as 'light' | 'dark' | 'system');
  if (event.type === 'openExternal') void Promise.resolve(openSignIn(event.url)).catch(() => {});
  if (event.type === 'reminder')
    notify(event.item.title, event.item.body ?? '', event.item.threadId);
  if (event.type === 'parked') broker.desktop(engineFrame('parked'));
  // `notify {pending}`: the claim loop runs beside the engine (host/compose.ts) and posts each item through the
  // `notify` request below, so main has nothing to claim itself. `clock` concerns windows only.
}

async function request(input: UtilityRequest): Promise<unknown> {
  if (input.op === 'openExternal') {
    await openSignIn(input.url);
    return ok;
  }
  const parsed = NotificationItem.safeParse(input.item);
  if (!parsed.success) throw new Error('Not a notification.');
  notify(parsed.data.title, parsed.data.body ?? '', parsed.data.threadId);
  return 'posted';
}

async function engineInit(dataDir: string): Promise<UtilityInit> {
  const init: UtilityInit = { dataDir, appVersion: app.getVersion() };
  const keychain = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value: string) => safeStorage.encryptString(value),
    decrypt: (value: Buffer) => safeStorage.decryptString(value),
  };
  try {
    init.key = await loadDataKey(dataDir, keychain);
  } catch (error) {
    // Only the keyring's own plain sentences go on; the engine then refuses to store any secret.
    init.keyError =
      error instanceof KeyringError ? error.message : 'Secure credential storage is unavailable.';
  }
  return init;
}

function spawn(init: UtilityInit): EngineLink {
  const child = utilityProcess.fork(join(__dirname, 'engine.cjs'), [REAL_ENGINE_ARG], {
    serviceName: REAL_ENGINE_SERVICE,
    env: process.env,
  });
  return createEngineLink(
    {
      post: (message, ports) => child.postMessage(message, ports as MessagePortMain[] | undefined),
      onMessage: handler => void child.on('message', handler),
      onExit: handler => void child.once('exit', handler),
      kill: () => void child.kill(),
    },
    init,
    { hostEvent, request },
    timers,
  );
}

const callerWindow = (event: IpcMainInvokeEvent) =>
  trustedCaller(event, {
    trustedURL,
    windowOf: sender => {
      const win = BrowserWindow.fromWebContents(sender as Electron.WebContents);
      return win ? portWindow(win) : undefined;
    },
  });

async function composeWindow(event: IpcMainInvokeEvent, draftId: string) {
  // Through main's own engine connection (`Draft/get`), never a copy of the mailbox in main.
  if (!(await draftOpenable(link(), draftId)))
    throw new Error('Save this draft before opening a separate window.');
  popout('draft', draftId, BrowserWindow.fromWebContents(event.sender)!.id);
  return ok;
}

/** The desktop methods main serves on this path today, by their v1 names; each maps to main's own handler. */
/** Main's host-only diagnostics: content-free facts about this install, for when the engine cannot give its own bundle. */
function hostBundle(): Record<string, unknown> {
  return {
    source: 'host',
    at: new Date().toISOString(),
    app: { name: app.getName(), version: app.getVersion() },
    runtime: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    system: { platform: process.platform, arch: process.arch, release: os.release() },
    engine: { running: Boolean(link() && !link()!.exited) },
  };
}

/** `Diagnostics/copy`: the content-free bundle to the clipboard. Today the host-only one (the engine's bundle is not on main's control connection). */
function copyDiagnostics() {
  // Test mode never writes the shared clipboard.
  if (!isTest) clipboard.writeText(JSON.stringify(hostBundle(), null, 2));
  return { source: 'host' as const };
}

/** The bytes of a blob, read through main's own control connection (`Blob/get`), never through a renderer. */
async function blobBytes(blobId: string): Promise<Buffer> {
  const current = link();
  if (!current) throw new Error('The mailbox is restarting. Try again in a moment.');
  const blob = (await current.call('Blob/get', { blobId }, 30_000)) as { bytes?: unknown };
  if (!(blob.bytes instanceof Uint8Array)) throw new Error('That file is no longer available.');
  return Buffer.from(blob.bytes);
}

function desktopMethod(event: IpcMainInvokeEvent, method: unknown, input: unknown) {
  // The caller check runs first and alone; what follows answers a failure as an envelope (shared/desktop-error.ts).
  return guardedDesktopCall(
    () => assertCaller(event),
    () => desktopMethodFor(event, method, input),
  );
}

async function desktopMethodFor(event: IpcMainInvokeEvent, method: unknown, input: unknown) {
  if (typeof method !== 'string') throw new Error('Unsupported application method.');
  const args = parseArgs(method as MethodName, input ?? {}) as Record<string, unknown>;
  if (method === 'Window/compose') return composeWindow(event, String(args.draftId));
  if (method === 'Engine/restart') {
    if (!supervisor) throw new Error('The mailbox engine is not running on this build.');
    await supervisor.restart();
    return ok;
  }
  if (method === 'Diagnostics/copy') return copyDiagnostics();
  if (method === 'File/save' || method === 'File/open') {
    const name = fileNameOf(args.name);
    // A type that would not be opened is refused before its bytes are read across the process boundary.
    if (method === 'File/open' && !SNIFFED_EXTENSIONS.has(extensionOf(name)))
      throw new Error('Save this attachment to inspect it before opening.');
    const data = await blobBytes(String(args.blobId));
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw new Error('That window was closed.');
    return method === 'File/save' ? saveBytes(win, name, data) : (await openBytes(name, data), ok);
  }
  const name = Object.hasOwn(legacyNames, method) ? legacyNames[method] : undefined;
  if (!name) throw new Error('This is not available on the new engine yet.');
  return v1Result(method, await invokeNative(event, name, args));
}

/**
 * Today's renderer still runs on this path and still calls `aplos:invoke`. It keeps main's native methods (its window
 * closes, quits and pop-outs work), and every engine call is refused with a plain sentence: there is no legacy engine
 * here and main forwards nothing.
 */
async function legacyInvoke(event: IpcMainInvokeEvent, method: unknown, payload: unknown) {
  assertCaller(event);
  if (typeof method !== 'string' || !nativeMethods.has(method))
    throw new Error('This screen is not on the new engine yet.');
  if (method === 'window.compose') {
    const draftId = (payload as { draftId?: unknown } | undefined)?.draftId;
    if (typeof draftId !== 'string' || draftId.length > 200) throw new Error('Invalid draft ID.');
    await composeWindow(event, draftId);
    return true;
  }
  return invokeNative(event, method, payload);
}

function connectWindow(event: IpcMainInvokeEvent) {
  const win = callerWindow(event);
  if (!win) throw new Error('Untrusted application window.');
  broker.connect(win);
  return ok;
}

/** A window's port stops when the window closes, its main frame commits a new document, or its renderer dies. */
function watchWindows() {
  app.on('browser-window-created', (_event, win) => {
    const id = win.id;
    win.once('closed', () => broker.revoke(id));
    revokeOnNewDocument(win.webContents, () => broker.revoke(id));
  });
}

/** `Mail/serve` over main's control connection; no engine means the relay's uniform 404. */
function serveMail({ signal, ...args }: ServeArgs): Promise<unknown> {
  const current = link();
  if (!current) return Promise.reject(new Error('The mailbox is restarting.'));
  return current.call('Mail/serve', args, SERVE_TIMEOUT_MS, signal);
}

/** Set by the quit: from then on no engine is started, whatever stage the start-up had reached. */
let closeRequested = false;

/** Starts the new engine and the IPC that reaches it. `noteExit` is lifecycle's park counter (3 stops in 60 s). */
async function bootRealEngine(options: {
  dataDir: string;
  noteExit(): boolean;
  noteRestart?(): void;
}): Promise<void> {
  const init = await engineInit(options.dataDir);
  // A quit that landed while the start-up was still preparing: no engine is started without the data lock to cover it.
  if (closeRequested) return;
  supervisor = createEngineSupervisor({
    spawn: () => spawn(init),
    noteExit: options.noteExit,
    ...(options.noteRestart ? { onRestart: options.noteRestart } : {}),
    onUp: (_link, restarted) => {
      if (restarted) broker.reissue();
      broker.desktop(engineFrame('ready'));
    },
    onDown: parked => broker.desktop(engineFrame(parked ? 'parked' : 'connecting')),
    onKillFailed: error =>
      console.error('Aplos Mail: could not stop the engine process:', (error as Error)?.name),
    timers,
  });
  await supervisor.start();
  watchWindows();
  // The sealed mail frame (html-5): the `aplos-mail://` relay, its window stamp and backstop, and the subframe rule.
  // At most MAX_RELAY_IN_FLIGHT relays open at once: a page cannot queue unbounded engine work through main.
  installMailProtocol(limitInFlight(serveMail));
  allowMailFrames();
  ipcMain.handle('aplos:engine-connect', connectWindow);
  ipcMain.handle('aplos:desktop', desktopMethod);
  ipcMain.handle('aplos:invoke', legacyInvoke);
  if (isTest) console.error('Aplos Mail test: engine: real engine ready');
}

/** What lifecycle.ts needs from the real engine: power wakes, the quit warning's facts, and the quit itself. */
const realEngine = {
  wake: () => link()?.power('resume'),
  /**
   * `Account/get` on main's control connection rolled into the tray's status line (host/menu-bar.ts). Down or
   * slow answers undefined — the menu then keeps showing the last state, or "Starting…" before the first one.
   */
  sync: async (): Promise<SyncFacts | undefined> => {
    const current = link();
    if (!current) return undefined;
    return engineSyncFacts((method, args, timeoutMs) => current.call(method, args, timeoutMs));
  },
  /** `Session/get` on main's control connection: the first-run facts the window choice needs. */
  session: async (): Promise<SessionFacts> => {
    const current = link();
    if (!current) throw new Error('The mailbox is restarting.');
    const session = (await current.call('Session/get', {}, 3000)) as SessionFacts;
    return { hasAccounts: session.hasAccounts === true, setup: session.setup ?? {} };
  },
  /** Rejects when the engine is down or slow; the quit gate then quits without a warning (host/lifecycle.ts). */
  pending: async () => {
    const current = link();
    if (!current) throw new Error('The mailbox is restarting.');
    return (await current.call('Outbox/pending', {}, 3000)) as PendingWork;
  },
  /** Rejects unless the engine really exited, so the data lock is never released over a running engine. */
  close: async (): Promise<void> => {
    closeRequested = true;
    const result = (await supervisor?.close()) ?? 'exited';
    if (result !== 'exited') throw new Error('The mailbox engine did not stop.');
  },
};

export { bootRealEngine, realEngine };
