import { chmodSync, lstatSync, mkdirSync, unlinkSync, type Stats } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { CallEnvelope, Hello, toReply, type HelloReply } from '@aplos/contract';
import type { Caller } from '@aplos/contract/access';
import { ContractError } from '@aplos/contract/contract-error';
import {
  AUTH_REFUSED,
  authenticate,
  createSessionTracker,
  guardCall,
  type ClientRegistry,
  type DoorwayBackend,
  type DoorwayListener,
  type DoorwayLog,
  type SessionTracker,
} from './auth';

/*
 * The Unix socket half of the doorway (plan 10 E7 item 1, ARCH 9.4 and 12.3 item 1): `<dataDir>/run/engine.sock`, 0600
 * in a 0700 directory, NDJSON frames, a `Hello` carrying the client's token first. Only this Mac user can reach the
 * file, and even they need a token for a stored, unrevoked client.
 */

export const SOCKET_NAME = 'engine.sock';
/** macOS `sun_path` is 104 bytes including the NUL, so a path of 104 bytes or more cannot be bound. */
export const SUN_PATH_MAX = 104;

export interface SocketLimits {
  /** One NDJSON frame; a longer line closes the connection (memory exhaustion). */
  maxLineBytes: number;
  /** Calls running at once per connection; past it the connection stops reading until one finishes. */
  maxInFlight: number;
  /** Time to send a good `Hello`; a silent or half-open connection is closed (connection-slot exhaustion). */
  helloTimeoutMs: number;
  maxConnections: number;
  /** Replies and frames queued to a client that does not read; past it the connection is dropped. */
  maxOutboundBytes: number;
}

export const defaultSocketLimits: SocketLimits = {
  maxLineBytes: 1024 * 1024,
  maxInFlight: 64,
  helloTimeoutMs: 5_000,
  maxConnections: 32,
  maxOutboundBytes: 16 * 1024 * 1024,
};

/** Why the listener would not start. The message is a plain sentence for the Settings pane and the log. */
export class DoorwayError extends Error {
  constructor(
    readonly code: 'unsafeDirectory' | 'inUse' | 'pathTooLong' | 'notSocket' | 'unsafeSocket',
    message: string,
  ) {
    super(message);
    this.name = 'DoorwayError';
  }
}

/** The file system calls the socket's placement makes, injectable for tests. */
export interface SocketFs {
  mkdirSync(path: string, options: { recursive: boolean; mode: number }): unknown;
  lstatSync(path: string): Stats;
  chmodSync(path: string, mode: number): void;
  unlinkSync(path: string): void;
}

const nodeFs: SocketFs = {
  mkdirSync: (path, options) => mkdirSync(path, options),
  lstatSync: path => lstatSync(path),
  chmodSync: (path, mode) => chmodSync(path, mode),
  unlinkSync: path => unlinkSync(path),
};

export interface SocketListenerOptions {
  dataDir: string;
  registry: ClientRegistry;
  backend: DoorwayBackend;
  limits?: Partial<SocketLimits>;
  /** The current user's uid; injectable so a test can simulate a directory another user owns. */
  uid?: number;
  /** Where the short fallback directory goes when `<dataDir>/run/engine.sock` is too long; `/tmp`. */
  tmpRoot?: string;
  fs?: SocketFs;
  log?: DoorwayLog;
}

export interface SocketListener extends DoorwayListener {
  path: string;
  /** Open connections, authenticated or not. */
  connections(): number;
}

export interface SocketPlacement {
  dir: string;
  path: string;
  /** True when the data directory's path was too long and the socket lives in `/tmp/aplos-<uid>/`. */
  fallback: boolean;
}

/** Where the socket goes: `<dataDir>/run/engine.sock`, or `/tmp/aplos-<uid>/engine.sock` when that is too long to bind. */
export function socketPlacement(
  dataDir: string,
  options: { uid: number; tmpRoot?: string },
): SocketPlacement {
  const dir = join(dataDir, 'run');
  const path = join(dir, SOCKET_NAME);
  if (Buffer.byteLength(path) < SUN_PATH_MAX) return { dir, path, fallback: false };
  const fallbackDir = join(options.tmpRoot ?? '/tmp', `aplos-${options.uid}`);
  const fallbackPath = join(fallbackDir, SOCKET_NAME);
  if (Buffer.byteLength(fallbackPath) >= SUN_PATH_MAX)
    throw new DoorwayError('pathTooLong', 'There is no short enough place for the tools socket.');
  return { dir: fallbackDir, path: fallbackPath, fallback: true };
}

/**
 * Makes `dir` a private directory: a real directory (not a symlink), owned by this user, mode 0700. In the data
 * directory (`repair`) a loose mode is tightened; in the shared `/tmp` fallback anything but an exact match is refused,
 * because another local user could have planted the directory or a symlink there first to catch the socket.
 */
export function ensurePrivateDir(
  dir: string,
  options: { uid: number; repair: boolean; fs?: SocketFs },
): void {
  const fs = options.fs ?? nodeFs;
  makeDir(fs, dir, options.repair);
  let stats = lstatOrUndefined(fs, dir);
  if (!stats?.isDirectory() || stats.isSymbolicLink() || stats.uid !== options.uid)
    throw unsafeDirectory();
  if ((stats.mode & 0o777) === 0o700) return;
  if (!options.repair) throw unsafeDirectory();
  fs.chmodSync(dir, 0o700);
  stats = fs.lstatSync(dir);
  if (!stats.isDirectory() || (stats.mode & 0o777) !== 0o700) throw unsafeDirectory();
}

function makeDir(fs: SocketFs, dir: string, recursive: boolean): void {
  try {
    fs.mkdirSync(dir, { recursive, mode: 0o700 });
  } catch (error) {
    // An existing entry is examined next, never trusted: whoever made it, it must pass the same checks.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

const unsafeDirectory = () =>
  new DoorwayError(
    'unsafeDirectory',
    'The folder for the tools socket is not private to you, so Aplos did not open it.',
  );

function lstatOrUndefined(fs: SocketFs, path: string): Stats | undefined {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Removes a socket file left by a process that died, but only after a connect attempt is refused: a live listener
 * means a second Aplos is running on this data, and stealing its socket would split the tools between two engines.
 */
export async function reclaimStaleSocket(path: string, fs: SocketFs = nodeFs): Promise<void> {
  const stats = lstatOrUndefined(fs, path);
  if (!stats) return;
  if (!stats.isSocket())
    throw new DoorwayError('notSocket', 'Something other than the tools socket is in its place.');
  const probe = await probeSocket(path);
  if (probe === 'gone') return;
  if (probe !== 'dead')
    throw new DoorwayError('inUse', 'Another copy of Aplos is already letting tools in.');
  fs.unlinkSync(path);
}

function probeSocket(path: string): Promise<'live' | 'dead' | 'gone' | 'unknown'> {
  return new Promise(resolve => {
    const socket = connect(path);
    const done = (result: 'live' | 'dead' | 'gone' | 'unknown') => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done('unknown'), 1_000);
    socket.once('connect', () => done('live'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') return done('dead');
      done(error.code === 'ENOENT' ? 'gone' : 'unknown');
    });
  });
}

/** Binds with umask 0177 so the socket is never 0666 for even a moment, however `listen` creates it. */
function listenPrivately(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new DoorwayError('inUse', 'Another copy of Aplos is already letting tools in.')
          : error,
      );
    };
    server.once('error', onError);
    const previous = process.umask(0o177);
    try {
      server.listen(path, () => {
        server.off('error', onError);
        resolve();
      });
    } finally {
      process.umask(previous);
    }
  });
}

/** Belt and braces after `listen`: the socket file is a socket, ours, and 0600. */
function secureSocketFile(path: string, uid: number, fs: SocketFs): void {
  fs.chmodSync(path, 0o600);
  const stats = fs.lstatSync(path);
  if (!stats.isSocket() || stats.uid !== uid || (stats.mode & 0o777) !== 0o600)
    throw new DoorwayError('unsafeSocket', 'The tools socket could not be made private.');
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('The tools socket needs a Unix user id.');
  return uid;
}

/**
 * Binds the socket and serves sessions until `close`. Refuses to start (with a `DoorwayError`) when the directory is not
 * private, the path cannot be made short enough, or another live process holds the socket.
 */
export async function startSocketListener(options: SocketListenerOptions): Promise<SocketListener> {
  const fs = options.fs ?? nodeFs;
  const uid = options.uid ?? currentUid();
  const limits = { ...defaultSocketLimits, ...options.limits };
  const placement = socketPlacement(options.dataDir, { uid, tmpRoot: options.tmpRoot });
  ensurePrivateDir(placement.dir, { uid, repair: !placement.fallback, fs });
  await reclaimStaleSocket(placement.path, fs);
  const tracker = createSessionTracker(options.registry);
  const sockets = new Set<Socket>();
  const deps: SessionDeps = {
    registry: options.registry,
    backend: options.backend,
    tracker,
    limits,
    log: options.log,
    onClosed: socket => sockets.delete(socket),
  };
  const server = createServer({ allowHalfOpen: false }, socket => {
    sockets.add(socket);
    new SocketSession(socket, deps).start();
  });
  // Node refuses connections past this at accept time (connection-slot exhaustion by a local process).
  server.maxConnections = limits.maxConnections;
  try {
    await listenPrivately(server, placement.path);
    secureSocketFile(placement.path, uid, fs);
  } catch (error) {
    tracker.dispose();
    server.close();
    throw error;
  }
  options.log?.('doorway.socket.listening', { transport: 'socket' });
  return {
    path: placement.path,
    describe: () => ({ socketPath: placement.path }),
    connections: () => sockets.size,
    close: () => closeServer(server, tracker, sockets),
  };
}

function closeServer(server: Server, tracker: SessionTracker, sockets: Set<Socket>): Promise<void> {
  tracker.dispose();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  return new Promise(resolve => server.close(() => resolve()));
}

interface SessionDeps {
  registry: ClientRegistry;
  backend: DoorwayBackend;
  tracker: SessionTracker;
  limits: SocketLimits;
  log?: DoorwayLog;
  onClosed(socket: Socket): void;
}

type SessionState = 'hello' | 'auth' | 'open' | 'closed';

const VERSION_REFUSED =
  'This tool was made for a different version of Aplos. Update Aplos and the tool, then try again.';
const BAD_ENVELOPE = 'Send each call as {"v":1,"id":…,"method":"Type/verb","args":{…}}.';

/**
 * One connection: `Hello` first (within `helloTimeoutMs`), then request envelopes answered by reply envelopes, with
 * the caller's frames pushed on the same stream. Lines are parsed lazily from one buffer, so a client pipelining
 * thousands of calls costs bytes, not objects, while the connection is paused at `maxInFlight`.
 */
class SocketSession {
  private state: SessionState = 'hello';
  private pending: Buffer = Buffer.alloc(0);
  private inFlight = 0;
  private caller?: Caller;
  private release?: () => void;
  private unsubscribe?: () => void;
  private readonly abort = new AbortController();
  private helloTimer?: NodeJS.Timeout;

  constructor(
    private readonly socket: Socket,
    private readonly deps: SessionDeps,
  ) {}

  start(): void {
    const { socket } = this;
    this.helloTimer = setTimeout(() => this.close('helloTimeout'), this.deps.limits.helloTimeoutMs);
    socket.on('data', chunk => this.receive(chunk));
    socket.on('error', () => this.close('socketError'));
    socket.on('close', () => this.close('closed'));
  }

  private receive(chunk: Buffer): void {
    if (this.state === 'closed') return;
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    this.drain();
  }

  private blocked(): boolean {
    if (this.state === 'auth') return true;
    return this.state === 'open' && this.inFlight >= this.deps.limits.maxInFlight;
  }

  private drain(): void {
    while (this.state !== 'closed' && !this.blocked()) {
      const line = this.nextLine();
      if (line === undefined) break;
      try {
        this.handleLine(line);
      } catch {
        // A backend that throws synchronously (session(), subscribe()) must not take the listener down with it.
        this.close('internal');
      }
    }
    if (this.state === 'closed') return;
    if (this.blocked()) this.socket.pause();
    else this.socket.resume();
  }

  private nextLine(): Buffer | undefined {
    const max = this.deps.limits.maxLineBytes;
    const end = this.pending.indexOf(0x0a);
    // A line past the cap closes the connection whether or not its newline has arrived yet.
    if ((end === -1 && this.pending.length > max) || end > max) {
      this.close('lineTooLong');
      return undefined;
    }
    if (end === -1) return undefined;
    const line = this.pending.subarray(0, end);
    this.pending =
      end + 1 === this.pending.length ? Buffer.alloc(0) : this.pending.subarray(end + 1);
    return line;
  }

  private handleLine(line: Buffer): void {
    const text = line.toString('utf8').replace(/\r$/, '');
    if (text.trim() === '') return;
    const parsed = parseJson(text);
    if (this.state === 'hello') return this.hello(parsed.ok ? parsed.value : undefined);
    if (!parsed.ok) return this.close('malformed');
    this.request(parsed.value);
  }

  private hello(value: unknown): void {
    this.state = 'auth';
    if (this.versionMismatch(value)) {
      this.send({ ok: false, error: { type: 'unsupported', message: VERSION_REFUSED } });
      return this.close('unsupported', 'end');
    }
    const parsed = Hello.safeParse(value);
    // Anything that is not a well-formed Hello still walks the token path, with no token, so it is refused the same way.
    const token = parsed.success ? parsed.data.token : undefined;
    authenticate(this.deps.registry, token, 'socket')
      .then(
        caller => this.open(caller),
        () => this.refuse(),
      )
      .catch(() => this.close('internal'));
  }

  private versionMismatch(value: unknown): boolean {
    if (!isRecord(value)) return false;
    const major = this.deps.backend.session().apiVersion;
    if (Object.hasOwn(value, 'v') && value.v !== major) return true;
    const asked = value.apiVersion;
    return typeof asked === 'number' && Number.isFinite(asked) && Math.trunc(asked) !== major;
  }

  private refuse(): void {
    if (this.state === 'closed') return;
    const reply: HelloReply = { ok: false, error: { type: 'forbidden', message: AUTH_REFUSED } };
    this.send(reply);
    this.close('forbidden', 'end');
  }

  private open(caller: Caller): void {
    if (this.state === 'closed') return;
    const release = this.deps.tracker.admit(caller.clientId ?? '', () => this.close('revoked'));
    if (!release) return this.refuse();
    this.release = release;
    this.caller = caller;
    clearTimeout(this.helloTimer);
    const session = this.deps.backend.session();
    const reply: HelloReply = {
      ok: true,
      session: {
        apiVersion: session.apiVersion,
        dbEpoch: session.dbEpoch,
        clientId: caller.clientId ?? '',
        scopes: [...caller.scopes],
      },
    };
    this.send(reply);
    this.state = 'open';
    this.deps.log?.('doorway.socket.open', { clientId: caller.clientId, transport: 'socket' });
    this.subscribe(caller);
    this.drain();
  }

  /** Frames carry mail data, so only a client holding `read` gets the stream. */
  private subscribe(caller: Caller): void {
    if (!caller.scopes.includes('read')) return;
    this.unsubscribe = this.deps.backend.subscribe(
      caller,
      undefined,
      frame => this.send(frame),
      reset => this.send(reset),
    );
  }

  private request(value: unknown): void {
    const envelope = CallEnvelope.safeParse(value);
    if (!envelope.success) {
      const id = replyId(value);
      if (id === undefined) return this.close('malformed');
      const error = new ContractError({ type: 'validation', message: BAD_ENVELOPE });
      return this.sendReply(id, { error });
    }
    this.inFlight += 1;
    void this.run(envelope.data).finally(() => {
      this.inFlight -= 1;
      this.drain();
    });
  }

  private async run({ id, method, args }: CallEnvelope): Promise<void> {
    const caller = this.caller as Caller;
    try {
      // Refused here, before the backend is called at all; the engine's dispatch checks again (default deny).
      guardCall(method, caller, args);
      const opts = { opId: opIdOf(args), signal: this.abort.signal };
      const result = await this.deps.backend.call(caller, method, args, opts);
      this.sendReply(id, { result });
    } catch (error) {
      this.sendReply(id, { error });
    }
  }

  private sendReply(id: string | number, outcome: { result: unknown } | { error: unknown }): void {
    if (this.send(toReply(id, outcome))) return;
    this.send(toReply(id, { error: new Error('unserialisable') }));
  }

  /** Writes one NDJSON line. False when the value could not be serialised. */
  private send(value: unknown): boolean {
    if (this.state === 'closed' || this.socket.destroyed) return true;
    const text = serialise(value);
    if (text === undefined) return false;
    this.socket.write(`${text}\n`);
    if (this.socket.writableLength > this.deps.limits.maxOutboundBytes) this.close('slowConsumer');
    return true;
  }

  /** `end` flushes a refusal before the FIN; everything else (revoke, overflow, timeout) drops the connection now. */
  private close(reason: string, mode: 'end' | 'destroy' = 'destroy'): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearTimeout(this.helloTimer);
    this.abort.abort();
    quietly(() => this.unsubscribe?.());
    quietly(() => this.release?.());
    this.deps.onClosed(this.socket);
    if (reason !== 'closed')
      this.deps.log?.(`doorway.socket.${reason}`, {
        clientId: this.caller?.clientId,
        transport: 'socket',
      });
    if (mode === 'destroy') return void this.socket.destroy();
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1_000).unref();
  }
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function serialise(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The id to answer a malformed envelope with, when it has a usable one; otherwise the connection is closed. */
function replyId(value: unknown): string | number | undefined {
  if (!isRecord(value) || !Object.hasOwn(value, 'id')) return undefined;
  const { id } = value;
  if (typeof id === 'number' && Number.isFinite(id)) return id;
  return typeof id === 'string' && id.length <= 200 ? id : undefined;
}

function opIdOf(args: unknown): string | undefined {
  if (!isRecord(args) || !Object.hasOwn(args, 'opId')) return undefined;
  return typeof args.opId === 'string' ? args.opId : undefined;
}

function quietly(fn: () => void): void {
  try {
    fn();
  } catch {
    // Teardown of one part never stops the rest.
  }
}
