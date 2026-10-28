import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Client, Frame, State } from '@aplos/contract';
import { checkAccess, listenerCaller, type Caller } from '@aplos/contract/access';
import { ContractError } from '@aplos/contract/contract-error';

/*
 * The doorway's shared half (plan 10 E7 items 1-4, ARCH 12.3): client tokens, the uniform authentication path, the
 * method guard both transports run before the engine sees a call, revocation tracking, and the listener switch. Socket
 * (`socket.ts`) and loopback HTTP (`http.ts`) both build their `Caller` here and only here, from the stored client row
 * the token's hash matched (freeze R2B-3, R2H-7), never from anything the client sent.
 */

/** 256 random bits (ARCH 12.3 item 2). */
export const TOKEN_BYTES = 32;
/** Anything longer is not one of ours; refuse it before hashing so a huge header or field costs nothing. */
export const TOKEN_MAX = 256;
/** The one sentence every failed authentication gets, so missing, unknown and revoked tokens look the same. */
export const AUTH_REFUSED =
  'This tool is not allowed in Aplos. Ask the owner to add it in Settings.';

const HASH_HEX = /^[0-9a-f]{64}$/;
const TOKEN_CHARS = /^[A-Za-z0-9._~+/=-]+$/;

/** A fresh client token: 32 random bytes, base64url. Shown once to the owner or written to a 0600 file, never logged. */
export function generateToken(random: (size: number) => Buffer = randomBytes): string {
  return random(TOKEN_BYTES).toString('base64url');
}

/** The only form a token is stored in (`clients.tokenHash`): SHA-256, lower-case hex. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A string that could be a token: bounded and from the token alphabet (no spaces, controls or separators). */
export function isTokenShape(token: unknown): token is string {
  return (
    typeof token === 'string' &&
    token.length > 0 &&
    token.length <= TOKEN_MAX &&
    TOKEN_CHARS.test(token)
  );
}

/**
 * Constant-time check of a presented token against a stored hash. The presented token is hashed first, so both sides are
 * always 32 bytes and the compare never short-circuits on a length difference; a malformed input still pays for one hash
 * and one compare against a dummy, so it does not answer faster than a wrong token.
 */
export function matchToken(token: unknown, storedHash: unknown): boolean {
  const usable = isTokenShape(token) && typeof storedHash === 'string' && HASH_HEX.test(storedHash);
  const presented = Buffer.from(hashToken(usable ? token : DUMMY_TOKEN), 'hex');
  const stored = Buffer.from(usable ? storedHash : DUMMY_HASH, 'hex');
  return timingSafeEqual(presented, stored) && usable;
}

/** Looked up when no usable token was presented, so "no token" walks the same hash-and-lookup path as a wrong one. */
const DUMMY_TOKEN = generateToken();
const DUMMY_HASH = hashToken(generateToken());

/** The stored client row the doorway needs: who it is, what it may do, whether it is revoked, and its token's hash. */
export type StoredClient = Pick<Client, 'id' | 'kind' | 'scopes' | 'revokedAt'> & {
  /** `hashToken` of the client's token; re-checked with `timingSafeEqual` after the lookup. */
  tokenHash: string;
};

/**
 * The port host-5 implements over the `clients` table. `onRevoked` lets a revoke close the client's open socket sessions
 * and SSE streams within a second (E7 item 3) instead of waiting for their next request.
 */
export interface ClientRegistry {
  findByTokenHash(hash: string): Promise<StoredClient | undefined>;
  /** Records `lastSeenAt`. Best effort: a failure never refuses the call. */
  touch(clientId: string): Promise<void> | void;
  onRevoked(listener: (clientId: string) => void): () => void;
}

/** The engine's `reset` frame, which a subscription sends when the cursor it was given is too old or foreign. */
export type ResetFrame = Extract<Frame, { frame: 'reset' }>;

export interface BlobMeta {
  mime: string;
  name?: string;
}

/**
 * What the transports need from the engine (contract-4's connection or a test fake). The transport only frames JSON and
 * enforces the doorway's own rules; `call` still validates with `parseArgs` and re-checks access with `checkAccess`
 * itself, so a transport bug exposes nothing (ARCH 9.3, default deny).
 */
export interface DoorwayBackend {
  call(
    caller: Caller,
    method: string,
    args: unknown,
    opts: { opId?: string; signal: AbortSignal },
  ): Promise<unknown>;
  /** Frames for this caller from `since` (undefined: from now). `onReset` when `since` cannot be honoured. */
  subscribe(
    caller: Caller,
    since: State | undefined,
    onFrame: (frame: Frame) => void,
    onReset: (frame: ResetFrame) => void,
  ): () => void;
  blob: {
    /** `notFound` for a blob another principal made (`principalOf`, FR-6). */
    get(caller: Caller, id: string): Promise<BlobMeta & { bytes: Uint8Array }>;
    put(
      caller: Caller,
      bytes: Uint8Array,
      meta: BlobMeta,
    ): Promise<{ blobId: string; size: number }>;
  };
  session(): { apiVersion: number; dbEpoch: string; appVersion: string };
  openapi(): string;
}

/**
 * Codes only, never values: callers pass a fixed event code plus ids, so a token, an `Authorization` header or a body
 * cannot reach the log through the doorway.
 */
export type DoorwayLog = (
  code: string,
  fields?: { clientId?: string; method?: string; transport?: string; status?: number },
) => void;

export type Transport = 'socket' | 'http';

const refused = () => new ContractError({ type: 'forbidden', message: AUTH_REFUSED });

/**
 * Authenticates a presented token and returns the caller, built only with `listenerCaller` from the stored row (freeze
 * R2B-3): `clientId`, `via` (and the MCP limit for a `Client.kind` of `mcp`) and scopes come from the row. Missing,
 * malformed, unknown and revoked tokens all do one hash, one lookup and one constant-time compare, then throw the same
 * `forbidden`.
 */
export async function authenticate(
  registry: ClientRegistry,
  presented: unknown,
  transport: Transport,
): Promise<Caller> {
  const usable = isTokenShape(presented);
  const candidate = usable ? presented : DUMMY_TOKEN;
  const row = await registry.findByTokenHash(hashToken(candidate));
  const matched = matchToken(candidate, row?.tokenHash ?? DUMMY_HASH);
  if (!usable || !row || !matched || row.revokedAt !== undefined) throw refused();
  const caller = listenerCaller(row, transport);
  touchQuietly(registry, row.id);
  return caller;
}

function touchQuietly(registry: ClientRegistry, clientId: string): void {
  try {
    void Promise.resolve(registry.touch(clientId)).catch(() => undefined);
  } catch {
    // lastSeenAt is a convenience; it never refuses or breaks a call.
  }
}

/** Methods whose bytes cannot ride JSON (Bytes is never base64, ARCH 9.4): only the HTTP blob routes carry them. */
const BLOB_METHODS = new Set(['Blob/get', 'Blob/put']);

/**
 * The guard both transports run before the backend sees a call: the contract's own default-deny rule (`checkAccess`:
 * listener methods only, so no `secret`, `uiOnly`, `host` or desktop method, no prototype key, scopes, the MCP limit,
 * window-only arguments), then the doorway's transport rule for binary methods. Throws the `ContractError` to send.
 */
export function guardCall(method: string, caller: Caller, args?: unknown): void {
  checkAccess(method, caller, args);
  if (BLOB_METHODS.has(method))
    throw new ContractError({
      type: 'unsupported',
      message: 'Use the blob routes (GET /v1/blob/:id, PUT /v1/blob) for file bytes.',
    });
}

/**
 * Which open connections belong to which client, so a revoke closes them at once (E7 item 3: within 1 s). It also
 * remembers every revoke it has seen, which closes the race where a revoke lands between a token's lookup and its
 * connection being admitted.
 */
export interface SessionTracker {
  /** Registers a connection's closer. Returns its release, or undefined when the client was already revoked. */
  admit(clientId: string, close: () => void): (() => void) | undefined;
  /** Closes every tracked connection (the listener switched off). */
  closeAll(): void;
  dispose(): void;
}

export function createSessionTracker(registry: ClientRegistry): SessionTracker {
  const open = new Map<string, Set<() => void>>();
  const revoked = new Set<string>();
  const closeClient = (clientId: string) => {
    const closers = [...(open.get(clientId) ?? [])];
    open.delete(clientId);
    for (const close of closers) runQuietly(close);
  };
  const closeAll = () => {
    for (const clientId of [...open.keys()]) closeClient(clientId);
  };
  const stop = registry.onRevoked(clientId => {
    revoked.add(clientId);
    closeClient(clientId);
  });
  return {
    admit(clientId, close) {
      if (revoked.has(clientId)) return undefined;
      const set = open.get(clientId) ?? new Set();
      set.add(close);
      open.set(clientId, set);
      return () => {
        set.delete(close);
        if (set.size === 0 && open.get(clientId) === set) open.delete(clientId);
      };
    },
    closeAll,
    dispose() {
      stop();
      closeAll();
    },
  };
}

function runQuietly(fn: () => void): void {
  try {
    fn();
  } catch {
    // One connection failing to close must not keep the others open.
  }
}

/** A bound transport the switch can describe and close. */
export interface DoorwayListener {
  describe(): { socketPath?: string; port?: number };
  /** Unbinds and closes every open connection. */
  close(): Promise<void>;
}

export interface DoorwayOptions {
  /** "Allow tools on this Mac" (Decision 5): false in release builds until the owner turns it on. */
  enabled: () => boolean;
  /** The transports to bind when enabled, e.g. `[() => startSocketListener(...), () => startHttpListener(...)]`. */
  start: ReadonlyArray<() => Promise<DoorwayListener>>;
}

export interface Doorway {
  /** Reads `enabled()` and binds or unbinds to match. Serialised: concurrent calls run one after another. */
  sync(): Promise<void>;
  state(): { enabled: boolean; socketPath?: string; port?: number };
  close(): Promise<void>;
}

/**
 * The listener switch. Disabled means nothing is bound at all (no socket file, no port), not "bound and refusing";
 * turning it off closes the listeners and every open connection. Binding is all or nothing: if one transport fails to
 * start, the ones already started are closed and the error is thrown.
 */
export function createDoorway(options: DoorwayOptions): Doorway {
  let running: DoorwayListener[] = [];
  let queue: Promise<void> = Promise.resolve();
  const stopAll = async () => {
    const listeners = running;
    running = [];
    await Promise.allSettled(listeners.map(listener => listener.close()));
  };
  const apply = async () => {
    const want = options.enabled();
    if (!want) return stopAll();
    if (running.length > 0) return;
    running = await startAll(options.start);
  };
  const serial = (step: () => Promise<void>) => {
    const next = queue.then(step);
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    sync: () => serial(apply),
    state: () => Object.assign({ enabled: running.length > 0 }, ...running.map(l => l.describe())),
    close: () => serial(stopAll),
  };
}

async function startAll(
  starters: ReadonlyArray<() => Promise<DoorwayListener>>,
): Promise<DoorwayListener[]> {
  const started: DoorwayListener[] = [];
  try {
    for (const start of starters) started.push(await start());
    return started;
  } catch (error) {
    await Promise.allSettled(started.map(listener => listener.close()));
    throw error;
  }
}
