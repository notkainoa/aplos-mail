import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, type MethodName, type NotificationItem } from '@aplos/contract';
import { logCodePattern } from '@aplos/contract/log/events';
import {
  createEngine,
  laneExtensions,
  type Engine,
  type EngineOptions,
  type HostFacts,
  type HostPorts,
} from '@aplos/engine';
import { withDemoDelivery } from '@aplos/engine/ai/demo/send';
import { laneFor } from '@aplos/engine/ai/lanes';
import { createLogger, type LogSink } from '@aplos/engine/diag/log';
import { hashAddress } from '@aplos/engine/diag/redact';
import {
  BlobFilesError,
  ProviderError,
  type BlobFiles,
  type Clock,
  type KeyProvider,
  type Logger,
  type PlanEnv,
  type ProviderFactory,
  type StorePort,
} from '@aplos/engine/ports';
import { openStore } from '@aplos/engine/store';
import type { AiTransport } from '@aplos/engine';
import type { SqlDatabase } from '@aplos/engine/store/sql';
import { createTimerLoop, type TimerLoop } from '@aplos/engine/clock/loop';
import { accountIds } from '@aplos/engine/sync/account-read';
import { disposeConnectSessions } from '@aplos/engine/sync/connect-sessions';
import * as engineConnectSessions from '@aplos/engine/sync/connect-sessions';
import { Governor } from '@aplos/engine/sync/governor';
import { ActorHost, type ActorHostOptions } from '@aplos/engine/sync/host';
import { storeLookup } from '@aplos/engine/sync/lookup';
import { openBlobFiles } from './blobs';
import { createLogSink, logDir } from './logsink';
import { runNotificationLoop, type PostNotification } from './notifications';
import { createClientTokens } from './transports/auth';
import { watchPowerResume, type PowerSource, type WakeClock } from './power';
import { createGoogleProvider } from './providers/google/adapter';
import { googleWorkflowChannel, googleWorkflowMerged } from './providers/google/workflow-host';
import { resolveGoogleClient, type GoogleClientInputs } from './providers/oauth/client';
import { createGoogleHostConnect } from './providers/oauth/host-connect';
import { scopesForFeatures } from './providers/oauth/scopes';
import { boundedKnownSubject } from './providers/oauth/known-subject';
import { createOauthReturns } from './providers/oauth/returns';
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
  /**
   * The clock and repeating timer behind the wake fallback (a 31 s wall-clock jump is a wake; wakes within 5 s are one).
   * Default: the real one (`Date.now` and `setInterval`). Tests pass a fake; the root never defaults to one.
   */
  wakeClock?: WakeClock;
  /** The keychain-backed vault of Google token bundles (`main/vault.ts` fits). */
  vault: CredentialVault<GoogleTokenBundle>;
  /** Opens the consent URL in the owner's browser. */
  openExternal(url: string): Promise<void> | void;
  /** The environment, the Settings client and the bundled one, read again at each sign-in. */
  googleClient: () => GoogleClientInputs;
  /**
   * The AI provider keys' environment, read at bind time in the utility process only — the values never enter
   * HostFacts, a log field or a window. Thunk like `googleClient`; default `() => process.env`.
   */
  aiEnv?: () => NodeJS.ProcessEnv;
  /**
   * The AI provider transport (`host/ai`), built by `realComposeOptions`. Absent: every `Ai/*` answers
   * `unavailable` through the detached stand-in.
   */
  aiTransport?: AiTransport;
  /** The banner: the notification loop posts claimed items through it, and so do missed reminders. */
  postNotification: PostNotification;
  /** Focus, window and battery as the Mac sees them, read at every planning step. Default: no window, unfocused, on mains. */
  env?: () => HostEnv;
  /**
   * The engine's data key. With it the Gmail workflow channel (the lease and the state shared between devices) is on,
   * and the engine gets the key too. Without it accounts run as primary and nothing is shared.
   */
  keys?: KeyProvider;
  /** What `Session/get` says about this build and Mac. Absent: a bare build named 'This Mac'. */
  host?: HostFacts;
  /** Ports the host has besides the ones composed here (`html`, `images`, ...). */
  ports?: Omit<HostPorts, 'accounts' | 'drafts' | 'deadlines' | 'keys'>;
  /** The single-instance lock: taken first, released last. Absent: no lock (`host/lock.ts` is not on this base). */
  lock?: () => ReleaseLock | Promise<ReleaseLock>;
}

export interface ComposedHost {
  engine: Engine;
  /** The account actors, which are also the engine's draft sync port. */
  accounts: ActorHost;
  /**
   * Stored accounts whose actor is not running (no provider factory, a budget that could not be read, ...), as of the
   * last attempt: salted id and error class only. One retry runs on each power resume. A UI or menu reads this.
   */
  startFailures(): readonly StartFailure[];
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
/** The real wall clock and `setInterval`; unref'd so a forgotten host never keeps the process alive. */
const realWakeClock: WakeClock = {
  now: () => Date.now(),
  every: (run, ms) => {
    const timer = setInterval(run, ms);
    timer.unref();
    return timer;
  },
  cancel: handle => clearInterval(handle as NodeJS.Timeout),
};

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

/** The verbose window's length (`Diagnostics/verbose`), and how often the meta row is re-read per log event. */
const VERBOSE_MS = 15 * 60_000;
const VERBOSE_CACHE_MS = 1_000;

/**
 * The logger's per-event level for the protocol log: the persisted deadline is read at most once a second (a
 * SQLite read on every log event was the cost Opus flagged), a deadline more than VERBOSE_MS out answers info
 * (a clock set back cannot stretch the window), and any store error fails closed to info.
 */
export function verboseLevel(store: StorePort, clock: ComposeOptions['clock']) {
  let checkedAt = -Infinity;
  let until = 0;
  return (): 'debug' | 'info' => {
    try {
      const now = clock.now();
      if (now - checkedAt >= VERBOSE_CACHE_MS) {
        const raw = store.read(
          q =>
            q.get<{ value: string }>("SELECT value FROM meta WHERE key = 'verbose_until'")?.value,
        );
        const next = raw === undefined ? 0 : Number(raw);
        until = Number.isFinite(next) ? next : 0;
        checkedAt = now;
      }
      return until > now && until - now <= VERBOSE_MS ? 'debug' : 'info';
    } catch {
      return 'info';
    }
  };
}

const holdsAccount = (store: StorePort, id: string) =>
  store.read(q => q.get('SELECT 1 FROM accounts WHERE id = ?', id) !== undefined);

const holdsSubject = (store: StorePort, subject: string) =>
  store.read(q => q.get('SELECT 1 FROM accounts WHERE remote_subject = ?', subject) !== undefined);

/**
 * The scopes an account's stored grant holds (`accounts.granted_scopes`): a reconnect asks for them again, or the
 * new grant would silently drop the optional ones. Undefined when there is no row to read — and also undefined on
 * malformed JSON, failing toward the narrower (safer) request.
 */
export const grantedScopesOf = (store: StorePort, id: string): string[] | undefined => {
  const raw = store.read(
    q =>
      q.get<{ granted_scopes: string | null }>(
        'SELECT granted_scopes FROM accounts WHERE id = ?',
        id,
      )?.granted_scopes,
  );
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((s): s is string => typeof s === 'string')
      : undefined;
  } catch {
    return undefined;
  }
};

/** A new sign-in asks for the calendar scopes too: the onboarding copy already tells the owner. */
const CALENDAR_CONNECT_SCOPES = scopesForFeatures('calendarList', 'calendarEvents');

/**
 * The optional scopes a connect asks for (the connect's `optionalScopes` dep): the calendar pair on a NEW sign-in,
 * undefined on anything else so the mode's default applies (a reconnect keeps the held ones, a re-grant asks every
 * requestable scope; the deferred `calendar.events` write scope is asked only by an explicit `grantPermissions` with
 * `enable: 'calendarWrite'`, which the connect reads from the request itself, never from this callback).
 */
export const connectOptionalScopes = (req: {
  mode: 'new' | 'reconnect' | 'grantPermissions';
}): readonly string[] | undefined => (req.mode === 'new' ? CALENDAR_CONNECT_SCOPES : undefined);

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
    // A reconnect keeps the optional scopes the stored grant holds; a grant-only-asked subset would drop them.
    grantedScopes: id => grantedScopesOf(store, id),
    // New sign-ins ask for the calendar scopes (a re-grant asks every optional scope itself).
    optionalScopes: connectOptionalScopes,
    // The `aplos://oauth-return` nonce registry: written here in the utility, consumed by main.
    returns: createOauthReturns({ dir: join(options.dataDir, 'oauth-returns') }),
    // Which window a live sign-in returns to (`sync/connect-sessions`'s binding). Presence-checked:
    // an engine build without the helpers resolves 'mail', which can never surface the setup window.
    returnToFor: (req, accountId) => {
      const helpers = engineConnectSessions as {
        oauthReturnFor?(key: string): 'onboarding' | 'mail' | undefined;
        oauthReturnKey?(req: { mode: string; address?: string }, accountId: string): string;
      };
      const key = helpers.oauthReturnKey?.(req, accountId);
      return (key && helpers.oauthReturnFor?.(key)) || undefined;
    },
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

/** The part of the account actors this module drives: `ActorHost.start`, which is a no-op for a started account. */
export interface AccountStarter {
  start(id: string): Promise<void>;
}

/** One stored account whose actor is not running. Both fields are safe to show: no address, no message text. */
export interface StartFailure {
  /** The account id, salted like every id and address the host logger writes; not the raw id and never the address. */
  readonly accountId: string;
  /** The error's class (a provider error's class, else the error's name), never its message. */
  readonly errorClass: string;
}

export interface AccountStarts {
  /** Starts every stored account not yet running; one that fails is logged and listed in `failures`. */
  startAll(): Promise<void>;
  /** Tries the failed accounts once more (the Mac woke); no-op after `stop`. */
  retryFailed(): Promise<void>;
  /** The accounts that are stored but not running, as of the last attempt. A copy. */
  failures(): readonly StartFailure[];
  /** Ends retries and waits for one in flight, so the actors can be disposed after it. */
  stop(): Promise<void>;
}

/** A class name that is safe in a log line, or `unknown`. */
export function errorClassOf(error: unknown): string {
  const raw =
    error instanceof ProviderError ? error.error.class : error instanceof Error ? error.name : '';
  return logCodePattern.test(raw) ? raw : 'unknown';
}

export function createAccountStarts(options: {
  host: AccountStarter;
  store: StorePort;
  log: Logger;
  salt: string;
}): AccountStarts {
  const { host, store, log, salt } = options;
  const failed = new Map<string, string>();
  let stopped = false;
  let running: Promise<void> | undefined;

  async function attempt(id: string): Promise<void> {
    try {
      await host.start(id);
      failed.delete(id);
    } catch (error) {
      const errorClass = errorClassOf(error);
      failed.set(id, errorClass);
      log
        .with({ account: hashAddress(salt, id) })
        .event('rpc.failed', { method: 'Host/startAccount', reason: errorClass });
    }
  }

  async function attemptAll(ids: Iterable<string>): Promise<void> {
    for (const id of [...ids]) {
      if (stopped) return;
      await attempt(id);
    }
  }

  // One attempt at a time: a resume during a slow retry joins it instead of starting a second.
  const serial = (run: () => Promise<void>) =>
    (running ??= run().finally(() => (running = undefined)));

  return {
    startAll: () => attemptAll(accountIds(store)),
    retryFailed: () => serial(() => attemptAll(failed.keys())),
    failures: () =>
      [...failed].map(([id, errorClass]) => ({ accountId: hashAddress(salt, id), errorClass })),
    stop: async () => {
      stopped = true;
      await running;
    },
  };
}

function openDatabaseFile(options: ComposeOptions): StorePort {
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const db = (options.openDatabase ?? openSqlite)(join(options.dataDir, 'mail.db'));
  try {
    return openStore(db, {
      extensions: laneExtensions(),
      // Without this the store never ranks a thread and Home shows every one of them under Do now.
      ingest: { laneFor },
      now: () => options.clock.now(),
    });
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

/**
 * The blob folder, `<dataDir>/blobs` (plans/engine/blob-area.md decision 1), unless the caller injected its own. An unsafe
 * folder (a link, not a directory, not ours) leaves the port out, so `Blob/*` answers `unavailable` and the rest of the
 * host still starts; the log line carries the reason code only, never the path.
 */
export async function openBlobPort(
  options: Pick<ComposeOptions, 'dataDir' | 'ports'>,
  log: Logger,
): Promise<BlobFiles | undefined> {
  if (options.ports?.blobFiles) return options.ports.blobFiles;
  try {
    return await openBlobFiles({ dir: join(options.dataDir, 'blobs') });
  } catch (error) {
    const reason = error instanceof BlobFilesError ? error.reason : 'io';
    log.event('rpc.failed', { method: 'Host/blobs', reason });
    return undefined;
  }
}

function engineOptions(
  options: ComposeOptions,
  store: StorePort,
  log: Logger,
  accounts: ActorHost,
  loop: TimerLoop,
  blobFiles: BlobFiles | undefined,
): EngineOptions {
  return {
    store,
    clock: options.clock,
    log,
    validate: (method, args) => parseArgs(method as MethodName, args),
    ...(options.host ? { host: options.host } : {}),
    ports: {
      ...options.ports,
      ...(options.aiTransport ? { aiTransport: options.aiTransport } : {}),
      ...(blobFiles ? { blobFiles } : {}),
      accounts,
      drafts: accounts,
      // Demo accounts have no provider: their sends are filed in their own Sent folder (ai/demo/send.ts).
      send:
        options.ports?.send ??
        withDemoDelivery(accounts.sendPort, store, () => options.clock.now()),
      calendar: accounts.calendarPort,
      deadlines: loop,
      ...(options.keys ? { keys: options.keys } : {}),
      clientTokens: options.ports?.clientTokens ?? createClientTokens({ dataDir: options.dataDir }),
    },
  };
}

/** The pieces that need a running engine: the notification claim loop, missed reminders, and power resume. */
function feedHost(
  options: ComposeOptions,
  engine: Engine,
  log: Logger,
  starts: AccountStarts,
  steps: Undo[],
): void {
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
  // A wake also gives a failed account start one more try; the wake itself is deduped by `watchPowerResume`.
  const wakeable = {
    wake: () => {
      void starts.retryFailed();
      return engine.wake();
    },
  };
  steps.push(watchPowerResume(options.power, wakeable, options.wakeClock ?? realWakeClock));
}

async function build(options: ComposeOptions, steps: Undo[]): Promise<ComposedHost> {
  if (options.lock) steps.push(await options.lock());
  const sink = openSink(options, steps);
  const raw = openDatabaseFile(options);
  steps.push(() => raw.close());
  const salt = installSalt(raw);
  const log = createLogger({
    sink,
    salt,
    clock: options.clock,
    level: verboseLevel(raw, options.clock),
  });
  const late = lateStore(raw);
  const loop = createTimerLoop({ clock: options.clock, log });
  const accounts = buildActors(options, late.port, log, loop);
  steps.push(() => accounts.dispose());
  const starts = createAccountStarts({ host: accounts, store: late.port, log, salt });
  // Runs just before the actors are disposed: no retry may start an actor on a disposed host.
  steps.push(() => starts.stop());
  // Before the engine exists, so the first draft upload and the first sync find their actors.
  await starts.startAll();
  steps.push(() => loop.stop());
  const blobFiles = await openBlobPort(options, log);
  const engine = await createEngine(engineOptions(options, raw, log, accounts, loop, blobFiles));
  steps.push(() => engine.close());
  // Runs just before the engine closes: the engine has no lane module that does it (connect-sessions.ts says it must).
  steps.push(() => disposeConnectSessions(engine.services));
  late.use(engine.services.store);
  loop.start();
  feedHost(options, engine, log, starts, steps);
  let closing: Promise<void> | undefined;
  return {
    engine,
    accounts,
    startFailures: starts.failures,
    close: () => (closing ??= unwind(steps)),
  };
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
