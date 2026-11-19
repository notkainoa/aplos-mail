import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { EngineSession } from '@aplos/contract/client';
import { appScopes } from '@aplos/contract/access';
import { windowCaller, type HostFacts } from '@aplos/engine';
import { mailHtml } from '@aplos/mail-html';
import { systemClock } from '@aplos/engine/clock/system';
import { composeEngineHost, type ComposedHost, type ComposeOptions } from '../host/compose';
import { createAiHost } from '../host/ai/index';
import { createImageProxy } from '../host/proxy/fetch';
import { openSqlite } from '../host/sqlite';
import {
  checkDatabase,
  DAMAGED_REASON,
  DB_FILE,
  isCorruptError,
  markClosed,
  markOpen,
  needsCheck,
  setAside,
} from '../host/damaged';
import type { AiProviderId } from '../host/ai/providers';
import type { GoogleTokenBundle } from '../host/providers/oauth/token-source';
import {
  controlMethods,
  createPortHost,
  hostServeArgs,
  type EnginePortEnd,
  type FromUtility,
  type ToUtility,
  type UtilityInit,
  type UtilityRequest,
} from '../host/transports/port';
import { createCipher } from './keyring';
import { bundledOAuth, oauthEnv } from './oauth-config';
import { createVault } from './vault';

/**
 * The new engine's utility process (lane eng-contract, contract-4). `engine-process.ts` starts it instead of the legacy
 * service when main forks with `REAL_ENGINE_ARG`. It composes the real engine host (`host/compose.ts`), serves each
 * window's MessagePort, answers main's control connection, and sends main typed host-channel events and requests.
 * Everything process-bound comes in through `UtilityParent` and `UtilityDeps`, so it runs under node:test.
 */

/** `process.parentPort` as this module needs it. */
export interface UtilityParent {
  post(message: FromUtility): void;
  onMessage(handler: (data: unknown, ports: readonly unknown[]) => void): void;
}

export interface UtilityDeps {
  /** The clock for the damaged copy's name (default `Date.now`). */
  now?: () => number;
  /** Default `composeEngineHost`. */
  compose?: (options: ComposeOptions) => Promise<ComposedHost>;
  /** The compose options for `init`. Default: `realComposeOptions`, the production ports. */
  options?: (init: UtilityInit, bridge: HostBridge) => Promise<ComposeOptions>;
  /** Wraps a transferred port (Electron's `MessagePortMain`). */
  wrapPort(port: unknown): EnginePortEnd;
  exit(code: number): void;
}

/** What compose's host ports ask main for, over the parent port. */
export interface HostBridge {
  request(request: UtilityRequest): Promise<unknown>;
  /** Electron's power monitor lives in main; main forwards `resume` and `unlock-screen` here. */
  power: EventEmitter;
}

/** Main's control connection: the app principal with every scope, `host` included (ARCH 12.3). */
const controlCaller = Object.freeze({
  kind: 'host' as const,
  scopes: Object.freeze([...appScopes]),
});

/** A stable id for this Mac among the owner's devices, kept in the data folder (0600). */
export function deviceIdOf(dataDir: string): string {
  const path = join(dataDir, 'device-id');
  try {
    const stored = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f-]{36}$/.test(stored)) return stored;
  } catch {
    // First start, or an unreadable file: a new id below.
  }
  const id = randomUUID();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${id}\n`, { mode: 0o600 });
  return id;
}

/** What `Session/get` says about this build and Mac: the version main gave, the device, the desktop's own capabilities. */
export function hostFacts(init: UtilityInit, deviceId: string): HostFacts {
  return {
    appVersion: init.appVersion,
    device: { id: deviceId, name: hostname().slice(0, 200) || 'This Mac' },
    // The menu-bar mode is main's (host-2); the utility cannot see it, and a window reads the desktop frame for it.
    resident: false,
    capabilities: {
      desktop: true,
      notifications: true,
      loginItem: true,
      menuBar: true,
      microphone: true,
    },
    // Names only: `Ai/providers` learns which provider keys the environment already holds (never a value).
    envKeys: AI_ENV_VARS.filter(name => process.env[name] !== undefined),
  };
}

/** The provider environment variables Settings → AI can read a key from. */
const AI_ENV_VARS = [
  'GROQ_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENCODE_API_KEY',
  'OLLAMA_API_KEY',
  'LM_STUDIO_API_KEY',
  'CUSTOM_AI_API_KEY',
] as const;

/**
 * The ports the real path adds beyond the ones `composeEngineHost` builds: the mail sanitiser (`html`, which every HTML
 * body needs for `MessageBody/get`, `Mail/frame` and prefetch) and the remote-image proxy (`images`, `Mail/serve`'s
 * `img/<n>`). Without `html` every HTML letter answered `unavailable` and the reader showed "Couldn't load this
 * email." (fix-bodies, 2026-11-11), so `tests/eng-contract/real-ports.test.ts` pins that both are here.
 */
export function realHostPorts(): NonNullable<ComposeOptions['ports']> {
  return { html: mailHtml, images: createImageProxy() };
}

/**
 * The production host ports. Real: the SQLite file, the network, the system clock, the rotating log, the Google
 * sign-in, the keychain-sealed token vault (main unwrapped the key), the mail sanitiser and the image proxy. Through
 * main: banners, the browser, power events. Left out for now (absent ports answer `unavailable`): the data key for the
 * Gmail workflow channel and the window layer's focus facts (DECISIONS.md, contract-4).
 */
export async function realComposeOptions(
  init: UtilityInit,
  bridge: HostBridge,
): Promise<ComposeOptions> {
  const cipher = init.key ? createCipher(init.key) : undefined;
  // Without the key the vault refuses every write: no token is ever stored in the clear.
  const vault = await createVault<GoogleTokenBundle>({
    dataDir: init.dataDir,
    file: 'google-tokens.v2.enc.json',
    ...(cipher ? { encrypt: cipher.encrypt, decrypt: cipher.decrypt } : {}),
  });
  const deviceId = deviceIdOf(init.dataDir);
  return {
    dataDir: init.dataDir,
    fetch: globalThis.fetch,
    clock: systemClock(),
    deviceId,
    host: hostFacts(init, deviceId),
    power: bridge.power,
    vault,
    openExternal: async url => void (await bridge.request({ op: 'openExternal', url })),
    googleClient: () => ({ env: oauthEnv(process.env), bundled: bundledOAuth.google }),
    // AI keys are read in this process only, from the env thunk at bind time — never in HostFacts, a log
    // field or a window. The vault and saved provider addresses live under dataDir like the token vault.
    aiEnv,
    aiTransport: createAiHost({
      fetch: globalThis.fetch,
      env: aiEnv(),
      vaultPath: join(init.dataDir, 'ai-keys.json'),
      addresses: () => aiAddressesOf(init.dataDir),
    }),
    postNotification: async item =>
      (await bridge.request({ op: 'notify', item })) === 'posted' ? 'posted' : 'dropped',
    ports: realHostPorts(),
  };
}

/** The process env for AI keys, a thunk like the other ComposeOptions envs so tests can swap it. */
const aiEnv = (): NodeJS.ProcessEnv => process.env;

/** Saved provider addresses from `settings` (id 1), re-read per request — a Settings → AI edit is live. */
function aiAddressesOf(dataDir: string): Partial<Record<AiProviderId, string>> {
  try {
    const db = openSqlite(join(dataDir, 'mail.db'), { readOnly: true, busyTimeoutMs: 250 });
    try {
      const row = db.prepare('SELECT data FROM settings WHERE id = 1').get() as
        { data?: string } | undefined;
      const providers = (JSON.parse(row?.data ?? '{}') as { ai?: { providers?: unknown } }).ai
        ?.providers;
      const out: Partial<Record<AiProviderId, string>> = {};
      for (const id of ['ollama', 'lmstudio', 'custom'] as const) {
        const address = (providers as Record<string, { address?: unknown }> | undefined)?.[id]
          ?.address;
        if (typeof address === 'string' && address) out[id] = address;
      }
      return out;
    } finally {
      db.close();
    }
  } catch {
    return {};
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
/** How long a process parked on a damaged database waits for main to stop it before it exits on its own. */
const DAMAGED_EXIT_MS = 2000;

function createBridge(parent: UtilityParent) {
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let counter = 0;
  const bridge: HostBridge = {
    power: new EventEmitter(),
    request: request =>
      new Promise((resolve, reject) => {
        const id = ++counter;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error('Aplos did not answer.'));
        }, REQUEST_TIMEOUT_MS);
        timer.unref?.();
        const done = (fn: () => void) => {
          clearTimeout(timer);
          waiting.delete(id);
          fn();
        };
        waiting.set(id, {
          resolve: value => done(() => resolve(value)),
          reject: error => done(() => reject(error)),
        });
        parent.post({ kind: 'request', id, ...request });
      }),
  };
  const answer = (message: ToUtility & { kind: 'answer' }) => {
    const call = waiting.get(message.id);
    if (!call) return;
    if (message.ok) call.resolve(message.result);
    else call.reject(new Error(message.message));
  };
  return { bridge, answer };
}

/** A window's engine connection id by its Electron window id (the port host's), for `Mail/serve`. */
type ConnectionOf = (windowId: number) => string | undefined;

/**
 * Main's control calls: `controlMethods` only, answered with the contract's error body on failure. `Mail/serve` names
 * the Electron window main stamped; it is translated to that window's connection id here, never passed through.
 */
function serveControl(
  parent: UtilityParent,
  control: EngineSession,
  message: ToUtility,
  connectionOf: ConnectionOf,
) {
  if (message.kind !== 'call') return;
  const { id, method } = message;
  if (!controlMethods.has(method)) {
    const error = { type: 'forbidden', message: 'Not a control method.' };
    return parent.post({ kind: 'reply', id, ok: false, error });
  }
  const args = method === 'Mail/serve' ? hostServeArgs(message.args, connectionOf) : message.args;
  control.call(method, args ?? {}).then(
    result => parent.post({ kind: 'reply', id, ok: true, result }),
    error => {
      const body = (error as { body?: { type?: unknown; message?: unknown } }).body;
      const safe =
        typeof body?.type === 'string' && typeof body.message === 'string'
          ? { type: body.type, message: body.message }
          : { type: 'internal', message: 'Something went wrong. Try again.' };
      parent.post({ kind: 'reply', id, ok: false, error: safe });
    },
  );
}

/**
 * Main holds no settings copy on this path: the stored theme is pushed once after `ready`, on the same host channel a
 * `Settings/set` theme change uses, so `nativeTheme` follows an explicit Light/Dark from the first paint. A refused
 * read is skipped: the next change still emits the event.
 */
async function seedAppearance(parent: UtilityParent, control: EngineSession): Promise<void> {
  try {
    const settings = (await control.call('Settings/get', {})) as { ui?: { theme?: unknown } };
    const theme = settings.ui?.theme;
    if (theme === 'light' || theme === 'dark' || theme === 'system')
      parent.post({ kind: 'host', event: { type: 'appearance', theme } });
  } catch {
    // Not fatal: a later Settings/set still emits the event.
  }
}

/** Starts listening on the parent port; `init` starts the engine, `quit` closes it and exits. */
export function runEngineUtility(parent: UtilityParent, deps: UtilityDeps): void {
  const { bridge, answer } = createBridge(parent);
  let host: ComposedHost | undefined;
  let control: EngineSession | undefined;
  let ports: ReturnType<typeof createPortHost> | undefined;
  let starting = false;
  let quitting = false;
  /** Set once the engine is up: a clean quit clears the open mark there. */
  let dataDir: string | undefined;

  /**
   * A damaged `mail.db` parks instead of starting (plan 10 Decision 6): the file is copied aside and main shows the
   * damaged-database screen. Nothing is rebuilt here. Main is told with a fixed sentence and the reason code only.
   */
  class Damaged extends Error {}
  function park(dataDir: string): never {
    try {
      setAside(dataDir, (deps.now ?? Date.now)());
    } catch {
      // A copy that cannot be made (a full disk) still parks: the file itself stays where it is, untouched.
    }
    throw new Damaged();
  }

  async function start(init: UtilityInit) {
    // The file is checked only after an unclean exit; a corrupt read during open parks the same way.
    if (needsCheck(init.dataDir) && !checkDatabase(join(init.dataDir, DB_FILE)).ok)
      park(init.dataDir);
    markOpen(init.dataDir);
    const options = await (deps.options ?? realComposeOptions)(init, bridge);
    try {
      host = await (deps.compose ?? composeEngineHost)(options);
    } catch (error) {
      if (isCorruptError(error)) park(init.dataDir);
      throw error;
    }
    dataDir = init.dataDir;
    const store = host.engine.services.store;
    const engine = host.engine;
    control = engine.connect(controlCaller);
    control.subscribe(frame => {
      if (frame.frame === 'host') parent.post({ kind: 'host', event: frame.event });
    });
    ports = createPortHost(() => engine.connect(windowCaller), {
      position: () => ({ dbEpoch: store.dbEpoch, seq: store.seq() }),
    });
    parent.post({ kind: 'ready', dbEpoch: store.dbEpoch, seq: store.seq() });
    void seedAppearance(parent, control);
  }

  async function quit() {
    if (quitting) return;
    quitting = true;
    ports?.closeAll();
    control?.close();
    const closed = await host?.close().then(
      () => true,
      () => false,
    );
    if (closed && dataDir) markClosed(dataDir);
    parent.post({ kind: 'closed' });
    deps.exit(0);
  }

  function receive(message: ToUtility, transferred: readonly unknown[]) {
    if (message.kind === 'init' && !starting) {
      starting = true;
      start(message.init).catch(error => {
        // The message is fixed: a raw error could name the data folder or carry provider text.
        if (error instanceof Damaged) {
          parent.post({
            kind: 'failed',
            message: 'The mail database on this Mac is damaged.',
            reason: DAMAGED_REASON,
          });
          // Main must hear why before this process goes (it kills it on receipt): exiting in the same turn can drop
          // the message, and main would then report a plain failed start.
          setTimeout(() => deps.exit(1), DAMAGED_EXIT_MS);
          return;
        }
        parent.post({ kind: 'failed', message: 'The new mailbox engine could not start.' });
        deps.exit(1);
      });
      return;
    }
    if (message.kind === 'attach' && ports && transferred.length === 1)
      return ports.attach(message.windowId, deps.wrapPort(transferred[0]));
    // A port before the engine is ready (main re-issues on `ready`), or with any other message, is closed unused.
    for (const port of transferred) deps.wrapPort(port).close();
    if (message.kind === 'detach') return ports?.detach(message.windowId);
    if (message.kind === 'answer') return answer(message);
    if (message.kind === 'power') return void bridge.power.emit(message.event);
    if (message.kind === 'quit') return void quit();
    if (message.kind === 'call' && control)
      serveControl(parent, control, message, windowId => ports?.connectionOf(windowId));
  }

  parent.onMessage((data, transferred) => {
    if (quitting || !data || typeof data !== 'object') return;
    receive(data as ToUtility, transferred);
  });
}

/** Electron's `MessagePortMain`, as much as this file uses. */
interface MainPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  start(): void;
  close(): void;
}

/** The utility process entry: `process.parentPort` and the transferred `MessagePortMain`s. */
export function startEngineUtility(): void {
  const parentPort = (
    process as unknown as {
      parentPort: {
        postMessage(message: unknown): void;
        on(
          event: 'message',
          listener: (event: { data: unknown; ports: readonly unknown[] }) => void,
        ): void;
      };
    }
  ).parentPort;
  runEngineUtility(
    {
      post: message => parentPort.postMessage(message),
      onMessage: handler => parentPort.on('message', event => handler(event.data, event.ports)),
    },
    {
      wrapPort: raw => {
        const port = raw as MainPort;
        const end: EnginePortEnd = {
          // `MessagePortMain.postMessage` moves only ports (a buffer in its list throws), so a blob reply's
          // `transfer` is left out here: the bytes are cloned across the process boundary once.
          post: message => port.postMessage(message),
          onMessage: handler => void port.on('message', event => handler(event.data)),
          onClose: handler => void port.on('close', handler),
          close: () => port.close(),
        };
        port.start();
        return end;
      },
      exit: code => process.exit(code),
    },
  );
}
