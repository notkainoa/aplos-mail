import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, type MethodName, type NotificationItem } from '@aplos/contract';
import {
  createEngine,
  laneExtensions,
  type Engine,
  type EngineOptions,
  type HostPorts,
} from '@aplos/engine';
import { createLogger, type LogSink } from '@aplos/engine/diag/log';
import type {
  Clock,
  KeyProvider,
  Logger,
  PlanEnv,
  ProviderFactory,
  StorePort,
} from '@aplos/engine/ports';
import { openStore } from '@aplos/engine/store';
import type { SqlDatabase } from '@aplos/engine/store/sql';
import { createTimerLoop, type TimerLoop } from '../../../../packages/engine/src/clock/loop';
import { accountIds } from '../../../../packages/engine/src/sync/account-read';
import { disposeConnectSessions } from '../../../../packages/engine/src/sync/connect-sessions';
import { Governor } from '../../../../packages/engine/src/sync/governor';
import { ActorHost, type ActorHostOptions } from '../../../../packages/engine/src/sync/host';
import { storeLookup } from '../../../../packages/engine/src/sync/lookup';
import { createLogSink, logDir } from './logsink';
import { runNotificationLoop, type PostNotification } from './notifications';
import { watchPowerResume, type PowerSource } from './power';
import { createGoogleProvider } from './providers/google/adapter';
import { googleWorkflowChannel, googleWorkflowMerged } from './providers/google/workflow-host';
import { resolveGoogleClient, type GoogleClientInputs } from './providers/oauth/client';
import { createGoogleHostConnect } from './providers/oauth/host-connect';
import { boundedKnownSubject } from './providers/oauth/known-subject';
import {
  GoogleTokenSource,
  type CredentialVault,
  type GoogleTokenBundle,
} from './providers/oauth/token-source';
import { createHttpClient, type HttpClient } from './providers/shared/http';
import { announceMissedReminders } from './reminders';
import { openSqlite } from './sqlite';

/**
 * The composition root of the new engine's host (lane eng-host). Everything the environment decides is injected, so it
 * runs under tsx with fakes: the database file, the network, the clock, the log, Electron's power monitor, the
 * keychain, the browser and the banner. It builds the object graph the prov-gmail rigs build by hand, with the
 * production choices the rigs replace by test doubles: the real Google sign-in with a store-backed `knownSubject`, the
 * engine's own timer loop, and the engine's frame-emitting store under the actors.
 *
 * Not called from `src/main` yet: main still runs the legacy engine.
 */

/** What the owner's Mac says about itself when a sync plans a step (`PlanEnv` without the time). */
export type HostEnv = Omit<PlanEnv, 'now'>;

/** Lets go of whatever `lock` acquired (the single-instance lock of eng-host, when it lands). */
export type ReleaseLock = () => void | Promise<void>;

export interface ComposeOptions {
  /** The data folder: `mail.db` lives here, and the log folder when no `logSink` is injected. */
  dataDir: string;
  /** Opens the SQLite file with the host's pragmas. Default: `openSqlite`. */
  openDatabase?: (path: string) => SqlDatabase;
  /** The network. Every Google call, token refresh and sign-in exchange goes through it. */
  fetch: typeof fetch;
  clock: Clock;
  /** Where log records go. Default: the rotating file sink in `<dataDir>/logs`. */
  logSink?: LogSink & { close?(): void };
  /** Stable id of this Mac among the owner's devices. */
  deviceId: string;
  /** Electron's `powerMonitor`, or anything that emits `resume` and `unlock-screen`. */
  power: PowerSource;
  /** The keychain-backed vault of Google token bundles (`main/vault.ts` fits). */
  vault: CredentialVault<GoogleTokenBundle>;
  /** Opens the consent URL in the owner's browser. */
  openExternal(url: string): Promise<void> | void;
  /** The environment, the Settings client and the bundled one, read again at each sign-in. */
  googleClient: () => GoogleClientInputs;
  /** The banner: the notification loop posts claimed items through it, and so do missed reminders. */
  postNotification: PostNotification;
  /** Focus, window and battery as the Mac sees them, read at every planning step. Default: no window, unfocused, on mains. */
  env?: () => HostEnv;
  /**
   * The engine's data key. With it the Gmail workflow channel (the lease and the state shared between devices) is on,
   * and the engine gets the key too. Without it accounts run as primary and nothing is shared.
   */
  keys?: KeyProvider;
  /** Ports the host has besides the ones composed here (`send`, `html`, `images`, ...). */
  ports?: Omit<HostPorts, 'accounts' | 'drafts' | 'deadlines' | 'keys'>;
  /** The single-instance lock: taken first, released last. Absent: no lock (`host/lock.ts` is not on this base). */
  lock?: () => ReleaseLock | Promise<ReleaseLock>;
}

export interface ComposedHost {
  engine: Engine;
  /** The account actors, which are also the engine's draft sync port. */
  accounts: ActorHost;
  /** Stops everything in the reverse order it started. Runs once; a later call returns the first one's promise. */
  close(): Promise<void>;
}

type Undo = () => void | Promise<void>;
type HostCaller = NonNullable<Parameters<Engine['connect']>[0]>;

/** The caller of the host's own connection: it claims notifications and lists reminders, nothing else. */
const hostCaller: HostCaller = Object.freeze({
  kind: 'host',
  scopes: Object.freeze(['host', 'read'] as const),
});

/** With no word from the window layer the Mac counts as idle: no window, no focus, on mains. */
const defaultEnv: HostEnv = { focused: false, windowVisible: false, onBattery: false };

/**
 * A store whose commits can be re-pointed. The actors are built before the engine, because the engine takes them as
 * a port, yet their commits must go through the engine's own store or no window ever hears of a sync. Until `use`
 * runs they commit to the raw store, which nothing watches yet.
 */
function lateStore(raw: StorePort): { port: StorePort; use(store: StorePort): void } {
  let target = raw;
  const port = Object.create(raw) as StorePort;
  const commit = (input: Parameters<StorePort['commit']>[0]) => target.commit(input);
  Object.defineProperty(port, 'commit', { value: commit });
  return {
    port,
    use: store => {
      target = store;
    },
  };
}

function installSalt(store: StorePort): string {
  const sql = "SELECT value FROM meta WHERE key = 'install_salt'";
  return store.read(q => q.get<{ value: string }>(sql))?.value ?? '';
}

const holdsAccount = (store: StorePort, id: string) =>
  store.read(q => q.get('SELECT 1 FROM accounts WHERE id = ?', id) !== undefined);

const holdsSubject = (store: StorePort, subject: string) =>
  store.read(q => q.get('SELECT 1 FROM accounts WHERE remote_subject = ?', subject) !== undefined);

/** Google access tokens over the vault, and the one HTTP client that sign-in and refresh share. */
function googleTokens(options: ComposeOptions) {
  const { clock, vault } = options;
  const http = createHttpClient({ fetch: options.fetch, clock, userAgent: 'AplosMail/0.3' });
  const client = () => resolveGoogleClient(options.googleClient());
  return { http, tokens: new GoogleTokenSource({ vault, http, clock, client }) };
}

/** The Google factory: the real sign-in (with a store-backed `knownSubject`) and the adapter, over the injected network. */
function googleFactory(
  options: ComposeOptions,
  store: StorePort,
  governor: Governor,
  http: HttpClient,
): ProviderFactory {
  const connect = createGoogleHostConnect({
    http,
    vault: options.vault,
    openExternal: options.openExternal,
    clientInputs: options.googleClient,
    governor,
    accountIsCommitted: id => holdsAccount(store, id),
    knownSubject: boundedKnownSubject(subject => holdsSubject(store, subject), {
      clock: options.clock,
    }),
  });
  return createGoogleProvider({
    fetch: options.fetch,
    pace: false,
    connect: connect.connect,
    discardCredential: connect.discardCredential,
    ...(options.keys ? { workflow: {} } : {}),
  });
}

function workflowOptions(
  options: ComposeOptions,
  store: StorePort,
  log: Logger,
): Partial<ActorHostOptions> {
  if (!options.keys) return {};
  return {
    workflowChannel: googleWorkflowChannel({ keys: options.keys, device: options.deviceId }),
    onWorkflowMerged: googleWorkflowMerged({
      store,
      lookup: account => storeLookup(store, account),
      log,
    }),
  };
}

/** Starts the actor of every account the store holds. One that fails to start is logged and left stopped. */
async function startAccounts(host: ActorHost, store: StorePort, log: Logger): Promise<void> {
  for (const id of accountIds(store)) {
    try {
      await host.start(id);
    } catch {
      log.event('rpc.failed', { method: 'Host/startAccount', reason: 'startFailed' });
    }
  }
}

function openDatabaseFile(options: ComposeOptions): StorePort {
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const db = (options.openDatabase ?? openSqlite)(join(options.dataDir, 'mail.db'));
  try {
    return openStore(db, { extensions: laneExtensions(), now: () => options.clock.now() });
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Runs the steps taken so far, newest first; one that fails does not stop the rest. */
async function unwind(steps: Undo[]): Promise<void> {
  for (const step of steps.splice(0).reverse()) {
    try {
      await step();
    } catch {
      // Closing must reach the database even when an earlier step fails; there is nowhere safe to report it.
    }
  }
}

/** The log sink, opened before the database so it closes after it and records the shutdown. */
function openSink(options: ComposeOptions, steps: Undo[]): LogSink {
  const dir = logDir({ dataDir: options.dataDir });
  const sink = options.logSink ?? createLogSink({ dir, now: () => options.clock.now() });
  steps.push(() => sink.close?.());
  return sink;
}

/** The account actors over the late store, with the Google provider and, given keys, the lease channel. */
function buildActors(options: ComposeOptions, store: StorePort, log: Logger, loop: TimerLoop) {
  const { clock } = options;
  const { http, tokens } = googleTokens(options);
  const governor = new Governor({ clock, tokens, log, role: 'secondary' });
  const env = options.env ?? (() => defaultEnv);
  const deps = {
    store,
    governor,
    providers: [googleFactory(options, store, governor, http)],
    tokens,
    clock,
    log,
    deadlines: loop,
    deviceId: options.deviceId,
    env: () => ({ ...env(), now: clock.now() }),
  };
  return new ActorHost(deps, workflowOptions(options, store, log));
}

function engineOptions(
  options: ComposeOptions,
  store: StorePort,
  log: Logger,
  accounts: ActorHost,
  loop: TimerLoop,
): EngineOptions {
  return {
    store,
    clock: options.clock,
    log,
    validate: (method, args) => parseArgs(method as MethodName, args),
    ports: {
      ...options.ports,
      accounts,
      drafts: accounts,
      deadlines: loop,
      ...(options.keys ? { keys: options.keys } : {}),
    },
  };
}

/** The pieces that need a running engine: the notification claim loop, missed reminders, and power resume. */
function feedHost(options: ComposeOptions, engine: Engine, log: Logger, steps: Undo[]): void {
  const session = engine.connect(hostCaller);
  steps.push(() => session.close());
  const failed = () =>
    log.event('rpc.failed', { method: 'Host/notifications', reason: 'loopFailed' });
  // A rejected banner must not become an unhandled rejection in the main process; the log line carries no error text.
  const note = (item: NotificationItem) =>
    void Promise.resolve()
      .then(() => options.postNotification(item))
      .catch(failed);
  steps.push(announceMissedReminders(session, note));
  steps.push(runNotificationLoop(session, options.postNotification, { log: failed }));
  steps.push(watchPowerResume(options.power, engine));
}

async function build(options: ComposeOptions, steps: Undo[]): Promise<ComposedHost> {
  if (options.lock) steps.push(await options.lock());
  const sink = openSink(options, steps);
  const raw = openDatabaseFile(options);
  steps.push(() => raw.close());
  const log = createLogger({ sink, salt: installSalt(raw), clock: options.clock });
  const late = lateStore(raw);
  const loop = createTimerLoop({ clock: options.clock, log });
  const accounts = buildActors(options, late.port, log, loop);
  steps.push(() => accounts.dispose());
  // Before the engine exists, so the first draft upload and the first sync find their actors.
  await startAccounts(accounts, late.port, log);
  steps.push(() => loop.stop());
  const engine = await createEngine(engineOptions(options, raw, log, accounts, loop));
  steps.push(() => engine.close());
  // Runs just before the engine closes: the engine has no lane module that does it (connect-sessions.ts says it must).
  steps.push(() => disposeConnectSessions(engine.services));
  late.use(engine.services.store);
  loop.start();
  feedHost(options, engine, log, steps);
  let closing: Promise<void> | undefined;
  return { engine, accounts, close: () => (closing ??= unwind(steps)) };
}

/**
 * Builds and starts the whole host. If a step fails, what was started is stopped again and the error is thrown. On
 * success `close()` runs the same steps in reverse, once: power, notifications and reminders, the engine, the timer
 * loop, the account actors, then the database, the log and the lock.
 */
export async function composeEngineHost(options: ComposeOptions): Promise<ComposedHost> {
  const steps: Undo[] = [];
  try {
    return await build(options, steps);
  } catch (error) {
    await unwind(steps);
    throw error;
  }
}
