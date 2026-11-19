/**
 * The direct MessagePort transport (lane eng-contract, contract-4; plan 10 E3 items 5 and 6, ARCH 9.4 and 12.1).
 *
 * One channel per window: main creates it, hands one end to the engine's utility process and the other to the window's
 * trusted main frame, then steps out of the data path. Main keeps only its own control connection (a few named
 * queries), the native methods, and the host channel (typed events the engine sends main).
 *
 * This file imports no Electron, no Node module and no zod. Preload bundles the client half into a sandboxed page, the
 * utility process runs the serving half, and main runs the broker, the link and the supervisor. Every Electron object
 * comes in as a small interface, so all of it runs under node:test with fakes.
 */
import type { DesktopEvent, ErrorBody, Frame } from '@aplos/contract';
import { failureOf } from '../../shared/desktop-error';
import type { EngineSession } from '@aplos/contract/client';
import {
  desktopMethods,
  engineMethods,
  hostMethods,
  rendererMethods,
} from '@aplos/contract/allowlists';
import { MAX_WINDOW_NODES, messageBytes } from '@aplos/contract/measure';

// ---- wire ---------------------------------------------------------------------------------------------------------

/** The argument main passes the utility process to start the new engine instead of the legacy one. */
export const REAL_ENGINE_ARG = '--aplos-engine=real';
/** The utility process's service name; the legacy engine's is `Aplos Mail Engine`, so their exits are counted apart. */
export const REAL_ENGINE_SERVICE = 'Aplos Mail Engine (new)';

/** No engine-to-window message may be larger than this, except a blob route's reply (plan 10 E3 acceptance). */
export const MAX_WINDOW_MESSAGE_BYTES = 256 * 1024;
/** A blob route's reply carries bytes (25 MB at most, `Blob/put`'s cap) plus a small envelope. */
export const MAX_BLOB_MESSAGE_BYTES = 26 * 1024 * 1024;
/** Calls one window may have open at once; more are refused until some answer. */
export const MAX_IN_FLIGHT = 256;
/**
 * The arguments of one port's open calls may add up to at most this many bytes; more are refused until some answer.
 * Without it 256 open 26 MB uploads would hold about 6.6 GB per window.
 */
export const MAX_IN_FLIGHT_BYTES = 64 * 1024 * 1024;
/** A window's call arguments may be at most this large, except an upload route's (a draft's HTML is at most 1M chars). */
export const MAX_ARGS_BYTES = 4 * 1024 * 1024;
/** Methods whose arguments carry `Bytes` from a window (25 MB at most). */
export const uploadRoutes: ReadonlySet<string> = new Set(['Blob/put']);
/** Methods whose reply carries `Bytes` to a window. Each moves as binary, never base64. */
export const blobRoutes: ReadonlySet<string> = new Set(['Blob/get']);

const desktopSet: ReadonlySet<string> = new Set(desktopMethods);
const hostSet: ReadonlySet<string> = new Set(hostMethods);
const engineSet: ReadonlySet<string> = new Set(engineMethods);

/**
 * What a window may send down its engine port: the generated renderer table's engine methods. Never a `host` method
 * (main's own), never a desktop method (preload sends those to main), never a name the registry does not know.
 */
export const portMethods: ReadonlySet<string> = new Set(
  rendererMethods.filter(m => engineSet.has(m) && !hostSet.has(m) && !desktopSet.has(m)),
);

/** True for a desktop method, which preload routes to main and never down the engine port. */
export const isDesktopMethod = (method: string) => desktopSet.has(method);

/**
 * Which engine runs (plan 10 4.1, the switch): the real engine, in every build. Aplos has no 0.2.x users (every 0.2.x
 * release stayed a draft; owner, 2026-11-18), so there is no importer and no hold for a folder with `aplos.db`: the new
 * engine starts its own `mail.db` beside it and leaves the old file untouched.
 *
 * `APLOS_ENGINE=legacy` brings the old engine back in a development or local build only, for the legacy verify scripts.
 * A release build ignores the environment, as it does `APLOS_TEST` and `APLOS_DATA_DIR`.
 */
export function realEngineRequested(
  env: Record<string, string | undefined>,
  release: boolean,
): boolean {
  return release || env.APLOS_ENGINE !== 'legacy';
}

/** A window's call down its port (ARCH 9.1's envelope). */
export interface PortCall {
  v: 1;
  id: number;
  method: string;
  args?: unknown;
}

/** A failed call's error as it crosses a port: the contract's error body. */
export type PortError = ErrorBody;

/** What the engine sends down a window's port. `hello` comes first, once per port. */
export type PortMessage =
  | { kind: 'hello'; dbEpoch: string; seq: number }
  | { kind: 'reply'; id: number; ok: true; result: unknown }
  | { kind: 'reply'; id: number; ok: false; error: PortError }
  | { kind: 'frame'; frame: Frame };

/** A frame main sends a window itself (`desktop`), outside the engine's change log. */
export type DesktopFrame = { frame: 'desktop'; event: DesktopEvent };

const refusal = (id: number, type: string, message: string): PortMessage => ({
  kind: 'reply',
  id,
  ok: false,
  error: { type, message },
});

export { MAX_MEASURED_NODES, MAX_WINDOW_NODES, messageBytes } from '@aplos/contract/measure';

/** The largest arguments a window's call to `method` may carry: an upload route's bytes, or `MAX_ARGS_BYTES`. */
const argsLimit = (method: string) =>
  uploadRoutes.has(method) ? MAX_BLOB_MESSAGE_BYTES : MAX_ARGS_BYTES;

/**
 * How many bytes of a call's arguments, binary payloads aside, are allowed. An upload route's big allowance is for its
 * bytes only: text (a string, a key) in its arguments stays at `MAX_ARGS_BYTES`, where it costs 4 ms to decode.
 */
const ARGS_TEXT_BYTES = MAX_ARGS_BYTES;

/** What the arguments of a window's call to `method` cost, or infinity when too many values or too many bytes. */
function argsBytes(method: string, args: unknown): number {
  return messageBytes(args ?? {}, argsLimit(method), MAX_WINDOW_NODES, ARGS_TEXT_BYTES);
}

function errorBody(error: unknown): PortError {
  const body = (error as { body?: unknown } | null)?.body as Partial<PortError> | undefined;
  if (body && typeof body.type === 'string' && typeof body.message === 'string')
    return body as PortError;
  return { type: 'internal', message: 'Something went wrong. Try again.' };
}

function parseCall(data: unknown): PortCall | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const call = data as Partial<PortCall>;
  if (call.v !== 1 || typeof call.id !== 'number' || !Number.isSafeInteger(call.id))
    return undefined;
  if (typeof call.method !== 'string' || call.method.length > 100) return undefined;
  return call as PortCall;
}

// ---- engine side (the utility process) ----------------------------------------------------------------------------

/** The engine's end of one window's channel (Electron's `MessagePortMain` in the utility process). */
export interface EnginePortEnd {
  /**
   * `transfer` lists a blob reply's buffer, moved instead of copied where the port can move it (a DOM or Node
   * `MessagePort`). Electron's `MessagePortMain` moves only ports, so the utility process's end ignores it and the
   * reply is cloned across the process boundary as before.
   */
  post(message: PortMessage, transfer?: ArrayBuffer[]): void;
  onMessage(handler: (data: unknown) => void): void;
  /** May be called more than once; every handler runs when the other end goes away. */
  onClose(handler: () => void): void;
  close(): void;
}

export interface ServeOptions {
  /** Where the store's change log stands now, for the port's `hello`. */
  position(): { dbEpoch: string; seq: number };
  /** A message that did not go out: too large, or a call that was not even an envelope. Never logs arguments. */
  onDrop?(reason: 'tooLarge' | 'badCall', what?: string): void;
}

export interface ServedPort {
  close(): void;
  readonly closed: boolean;
  /** The engine connection serving this window (`ConnectedSession.connectionId`), if the session names one. */
  readonly connectionId: string | undefined;
}

/** The `connectionId` an engine session names, or undefined (a fake or a foreign session names none). */
function connectionIdOf(session: EngineSession): string | undefined {
  const id = (session as { connectionId?: unknown }).connectionId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * The buffer a blob route's reply may move instead of copy: its `bytes` when they are a whole, unshared `ArrayBuffer`
 * (a view onto part of a larger buffer is copied, so a transfer never takes bytes the reply does not carry). The engine
 * hands out a fresh buffer per call (`BlobFiles.get`), so moving it can never detach one the engine still holds.
 */
export function replyTransfer(result: unknown): ArrayBuffer[] {
  const bytes = (result as { bytes?: unknown } | null)?.bytes;
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) return [];
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  return whole && bytes.byteLength > 0 ? [bytes.buffer] : [];
}

/** A frame too large to send becomes a `reset` at the same position: the window re-reads instead of missing it. */
function voidWindows(frame: Frame, position: { dbEpoch: string; seq: number }): Frame {
  const at = 'seq' in frame ? { dbEpoch: frame.dbEpoch, seq: frame.seq } : position;
  return { frame: 'reset', ...at, reason: 'cannotCalculateChanges' };
}

/**
 * Serves one window over its port: a session opened as an Electron window (`open`), one `hello`, then replies and
 * frames. Only `portMethods` reach the session, whose own dispatch checks scope again. Nothing larger than 256 KB goes
 * out except a blob route's reply. Once closed (the window went away, main revoked the port, or the session ended)
 * nothing more is sent or dispatched.
 */
export function serveWindowPort(
  open: () => EngineSession,
  end: EnginePortEnd,
  options: ServeOptions,
): ServedPort {
  const session = open();
  let closed = false;
  const send = (message: PortMessage, limit: number, transfer?: ArrayBuffer[]) => {
    if (closed) return true;
    if (messageBytes(message, limit) > limit) return false;
    if (transfer?.length) end.post(message, transfer);
    else end.post(message);
    return true;
  };
  const answer = (method: string, message: PortMessage & { kind: 'reply' }) => {
    const blob = blobRoutes.has(method);
    const limit = blob ? MAX_BLOB_MESSAGE_BYTES : MAX_WINDOW_MESSAGE_BYTES;
    // A blob reply's buffer is listed for transfer. Only a DOM or Node `MessagePort` end moves it; on the real path
    // the utility process's `MessagePortMain` ignores the list and the reply is cloned once across the process boundary.
    const transfer = blob && message.ok ? replyTransfer(message.result) : undefined;
    if (send(message, limit, transfer)) return;
    options.onDrop?.('tooLarge', method);
    const sentence = 'This answer is too large to send to the window.';
    send(refusal(message.id, 'tooLarge', sentence), MAX_WINDOW_MESSAGE_BYTES);
  };
  let inFlight = 0;
  let inFlightBytes = 0;
  const refuse = (call: PortCall, type: string, sentence: string) =>
    void send(refusal(call.id, type, sentence), MAX_WINDOW_MESSAGE_BYTES);
  const dispatch = (call: PortCall) => {
    if (!portMethods.has(call.method))
      return refuse(call, 'unsupported', 'Unsupported application method.');
    const size = argsBytes(call.method, call.args);
    if (size > argsLimit(call.method))
      return refuse(call, 'tooLarge', 'This request is too large to send.');
    if (inFlight >= MAX_IN_FLIGHT || inFlightBytes + size > MAX_IN_FLIGHT_BYTES)
      return refuse(call, 'unavailable', 'Too many requests at once. Try again in a moment.');
    inFlight++;
    inFlightBytes += size;
    const done = () => {
      inFlight--;
      inFlightBytes -= size;
    };
    session.call(call.method, call.args ?? {}).then(
      result => (done(), answer(call.method, { kind: 'reply', id: call.id, ok: true, result })),
      error => (
        done(),
        answer(call.method, { kind: 'reply', id: call.id, ok: false, error: errorBody(error) })
      ),
    );
  };
  send({ kind: 'hello', ...options.position() }, MAX_WINDOW_MESSAGE_BYTES);
  const unsubscribe = session.subscribe(frame => {
    if (send({ kind: 'frame', frame }, MAX_WINDOW_MESSAGE_BYTES)) return;
    options.onDrop?.('tooLarge', frame.frame);
    send(
      { kind: 'frame', frame: voidWindows(frame, options.position()) },
      MAX_WINDOW_MESSAGE_BYTES,
    );
  });
  end.onMessage(data => {
    if (closed) return;
    const call = parseCall(data);
    if (call) dispatch(call);
    else options.onDrop?.('badCall');
  });
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    session.close();
    end.close();
  };
  end.onClose(close);
  return {
    close,
    get closed() {
      return closed;
    },
    connectionId: connectionIdOf(session),
  };
}

/** Every window's served port in the utility process, by window id. A window has at most one. */
export function createPortHost(open: () => EngineSession, options: ServeOptions) {
  const served = new Map<number, ServedPort>();
  const detach = (windowId: number) => {
    served.get(windowId)?.close();
    served.delete(windowId);
  };
  return {
    attach(windowId: number, end: EnginePortEnd) {
      detach(windowId);
      const port = serveWindowPort(open, end, options);
      served.set(windowId, port);
      end.onClose(() => {
        if (served.get(windowId) === port) served.delete(windowId);
      });
    },
    detach,
    closeAll() {
      for (const id of [...served.keys()]) detach(id);
    },
    windows: () => [...served.keys()],
    /** The engine connection of the window's open port, or undefined when it has none (never attached, detached, closed). */
    connectionOf(windowId: number): string | undefined {
      const port = served.get(windowId);
      return port && !port.closed ? port.connectionId : undefined;
    },
  };
}

/** An Electron window id as main sends it in `Mail/serve`'s `windowId`: a positive safe integer, or its decimal text. */
function electronWindowId(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,15}$/.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : undefined;
}

/**
 * `Mail/serve`'s arguments as the engine must see them (html-5). Main knows only the Electron window id of the frame
 * that asked; the engine binds tokens to window connection ids, made in this process. So the window id is replaced by
 * that window's connection id, or by `''` (the engine's uniform 404) when the id is malformed or the window has no
 * open port. Main's value is never passed through, and only `token`, `path` and `windowId` are kept.
 */
export function hostServeArgs(
  args: unknown,
  connectionOf: (windowId: number) => string | undefined,
): { token: unknown; path: unknown; windowId: string } {
  const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const window = electronWindowId(input.windowId);
  const windowId = window === undefined ? '' : (connectionOf(window) ?? '');
  return { token: input.token, path: input.path, windowId };
}

// ---- main <-> utility process -------------------------------------------------------------------------------------

/** What the utility process needs to start the engine. `key` is the data key main unwrapped with the keychain. */
export interface UtilityInit {
  dataDir: string;
  appVersion: string;
  key?: Uint8Array;
  /** Why there is no key: a plain sentence, never a path. */
  keyError?: string;
}

/**
 * Main's own control connection may ask only these (plan 10 E3 item 6: `window.compose` uses `Draft/get`).
 * `Mail/serve` is the `aplos-mail://` relay (html-5); the utility rewrites its `windowId` with `hostServeArgs`.
 * `Blob/get` is main's `File/save`/`File/open` (plans/engine/blob-area.md decision 6): main reads the bytes itself, so
 * 25 MB never has to sit in a renderer to be saved. `Account/get` is the menu-bar item's status poll
 * (host/menu-bar.ts): without it here the link refuses the call before it leaves main, and the tray sits on
 * "Starting…" for the whole session. Main is the `app` principal, as every window is.
 */
export const controlMethods: ReadonlySet<string> = new Set([
  'Draft/get',
  'Outbox/pending',
  'Session/get',
  'Counts/get',
  'Account/get',
  'Mail/serve',
  'Blob/get',
]);

export type PowerEvent = 'resume' | 'unlock-screen';

export type ToUtility =
  | { kind: 'init'; init: UtilityInit }
  /** Carries exactly one transferred port: the engine's end of the window's channel. */
  | { kind: 'attach'; windowId: number }
  | { kind: 'detach'; windowId: number }
  | { kind: 'call'; id: number; method: string; args: unknown }
  | { kind: 'answer'; id: number; ok: true; result: unknown }
  | { kind: 'answer'; id: number; ok: false; message: string }
  | { kind: 'power'; event: PowerEvent }
  | { kind: 'quit' };

/** Requests the engine makes of main: post a banner, open a sign-in page. */
export type UtilityRequest = { op: 'notify'; item: unknown } | { op: 'openExternal'; url: unknown };

export type FromUtility =
  | { kind: 'ready'; dbEpoch: string; seq: number }
  /** `reason`: `store.corrupt` when the engine parked on a damaged database (main shows that screen). */
  | { kind: 'failed'; message: string; reason?: string }
  /** The engine is about to back up and migrate the database, which may take minutes: main waits longer for `ready`. */
  | { kind: 'upgrading' }
  /** The backup and migration returned: main's plain start timeout applies again to the rest of the start. */
  | { kind: 'upgraded' }
  | { kind: 'reply'; id: number; ok: true; result: unknown }
  | { kind: 'reply'; id: number; ok: false; error: PortError }
  /** A host-channel event (`HostEvent` in the contract); main validates it before acting. */
  | { kind: 'host'; event: unknown }
  | ({ kind: 'request'; id: number } & UtilityRequest)
  | { kind: 'closed' };

/** The utility process as main sees it (Electron's `UtilityProcess`). */
export interface UtilityChild {
  post(message: ToUtility, ports?: unknown[]): void;
  onMessage(handler: (message: unknown) => void): void;
  onExit(handler: (code: number) => void): void;
  kill(): void;
}

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface LinkHandlers {
  /** A host-channel event, still unvalidated. */
  hostEvent(event: unknown): void;
  /** A request, still unvalidated; the promise's value is the answer. */
  request(request: UtilityRequest): Promise<unknown>;
}

/** Main's link to one engine process: its control calls, the ports it attaches, and its end. */
export interface EngineLink {
  /** Resolves when the engine answers `ready`; rejects when it fails or stops first. */
  readonly ready: Promise<{ dbEpoch: string; seq: number }>;
  readonly exited: boolean;
  /** The engine said it is backing up and migrating the database (the supervisor's longer start timeout applies). */
  readonly upgrading?: boolean;
  /** Called with true when the backup and migration begin and false when they return (`upgrading` / `upgraded`). */
  onUpgrading?(listener: (upgrading: boolean) => void): void;
  /** A control-connection call; `controlMethods` only, rejected after `timeoutMs` or when the engine stops. */
  /** `signal`: the caller gave up; the call rejects at once and a late engine answer is dropped (the engine's work is not cancelled). */
  call(method: string, args?: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown>;
  attach(windowId: number, port: unknown): void;
  detach(windowId: number): void;
  power(event: PowerEvent): void;
  /** Asks the engine to close its database and exit. */
  quit(): void;
  kill(): void;
  onExit(handler: () => void): void;
}

export class LinkError extends Error {
  constructor(
    readonly body: PortError,
    options?: { cause?: unknown },
  ) {
    super(body.message, options);
    this.name = 'LinkError';
  }
}

const unavailable = (message = 'The mailbox is restarting. Try again in a moment.') =>
  new LinkError({ type: 'unavailable', message });

const CALL_TIMEOUT_MS = 10_000;

type Pending = {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: unknown;
  /** Runs once when the call settles by any route: drops the caller's abort listener. */
  done?: () => void;
};

function isUtilityMessage(message: unknown): message is FromUtility {
  return (
    !!message && typeof message === 'object' && typeof (message as FromUtility).kind === 'string'
  );
}

/** Starts talking to a freshly forked utility process: sends `init`, routes replies, requests and host events. */
export function createEngineLink(
  child: UtilityChild,
  init: UtilityInit,
  handlers: LinkHandlers,
  timers: Timers,
): EngineLink {
  const pending = new Map<number, Pending>();
  const exitHandlers: (() => void)[] = [];
  let counter = 0;
  let exited = false;
  let upgrading = false;
  const upgradeListeners: ((upgrading: boolean) => void)[] = [];
  const setUpgrading = (on: boolean) => {
    if (upgrading === on) return;
    upgrading = on;
    for (const listener of upgradeListeners) listener(on);
  };
  let settle!: {
    resolve(at: { dbEpoch: string; seq: number }): void;
    reject(error: unknown): void;
  };
  const ready = new Promise<{ dbEpoch: string; seq: number }>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A failed start is the caller's to handle; nobody else may see an unhandled rejection.
  ready.catch(() => undefined);

  const finish = (id: number, outcome: { result: unknown } | { error: unknown }) => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    timers.clear(call.timer);
    call.done?.();
    if ('result' in outcome) call.resolve(outcome.result);
    else call.reject(outcome.error);
  };
  const answer = (id: number, request: UtilityRequest) => {
    handlers.request(request).then(
      result => !exited && child.post({ kind: 'answer', id, ok: true, result }),
      error =>
        !exited &&
        child.post({
          kind: 'answer',
          id,
          ok: false,
          message: error instanceof Error ? error.message : 'Refused.',
        }),
    );
  };
  const receive = (message: FromUtility) => {
    if (message.kind === 'ready')
      return settle.resolve({ dbEpoch: message.dbEpoch, seq: message.seq });
    if (message.kind === 'upgrading') return setUpgrading(true);
    if (message.kind === 'upgraded') return setUpgrading(false);
    if (message.kind === 'failed') {
      const reason = typeof message.reason === 'string' ? message.reason : undefined;
      settle.reject(Object.assign(new Error(String(message.message)), reason ? { reason } : {}));
      return child.kill();
    }
    if (message.kind === 'reply')
      return finish(
        message.id,
        message.ok
          ? { result: message.result }
          : { error: new LinkError(errorBody({ body: message.error })) },
      );
    if (message.kind === 'host') return handlers.hostEvent(message.event);
    if (message.kind === 'request' && typeof message.id === 'number') answer(message.id, message);
  };
  child.onMessage(message => {
    if (!exited && isUtilityMessage(message)) receive(message);
  });
  child.onExit(() => {
    exited = true;
    settle.reject(unavailable('The mailbox stopped before it was ready.'));
    for (const id of [...pending.keys()]) finish(id, { error: unavailable() });
    for (const handler of exitHandlers.splice(0)) handler();
  });
  child.post({ kind: 'init', init });

  return {
    ready,
    get exited() {
      return exited;
    },
    get upgrading() {
      return upgrading;
    },
    onUpgrading: listener => void upgradeListeners.push(listener),
    call(method, args = {}, timeoutMs = CALL_TIMEOUT_MS, signal) {
      if (!controlMethods.has(method))
        return Promise.reject(
          new LinkError({ type: 'forbidden', message: 'Not a control method.' }),
        );
      if (exited) return Promise.reject(unavailable());
      if (signal?.aborted) return Promise.reject(unavailable('The request was cancelled.'));
      const id = ++counter;
      return new Promise((resolve, reject) => {
        const timer = timers.set(() => finish(id, { error: unavailable() }), timeoutMs);
        const abort = () => finish(id, { error: unavailable('The request was cancelled.') });
        pending.set(id, {
          resolve,
          reject,
          timer,
          done: () => signal?.removeEventListener('abort', abort),
        });
        signal?.addEventListener('abort', abort, { once: true });
        child.post({ kind: 'call', id, method, args });
      });
    },
    attach: (windowId, port) => !exited && child.post({ kind: 'attach', windowId }, [port]),
    detach: windowId => !exited && child.post({ kind: 'detach', windowId }),
    power: event => !exited && child.post({ kind: 'power', event }),
    quit: () => !exited && child.post({ kind: 'quit' }),
    kill: () => child.kill(),
    onExit: handler => (exited ? handler() : exitHandlers.push(handler)),
  };
}

export * from '../../shared/engine-supervisor';

// ---- main: who gets a port ----------------------------------------------------------------------------------------

/** A window as the broker sees it. `main/engine-real.ts` adapts a `BrowserWindow`. */
export interface PortWindow {
  readonly id: number;
  isDestroyed(): boolean;
  /** The window's main frame still shows the app's own renderer (re-checked before every port). */
  trusted(): boolean;
  /** Hands the window's end of a new channel to its main frame, and nothing else. */
  deliver(port: unknown, generation: number): void;
  desktop(frame: DesktopFrame): void;
}

export { trustedCaller, type CallerEvent } from '../../shared/trusted-caller';

export interface BrokerDeps {
  /** A new `MessageChannelMain`: one end for the engine, one for the window. */
  channel(): { engineEnd: unknown; windowEnd: unknown };
  /** The running engine, if any. */
  link(): EngineLink | undefined;
  /** The clock for the connect limit (default `Date.now`). */
  now?(): number;
}

/** A window may ask for a port this often: a reload asks once, so a loop of asks is not a page of ours. */
export const CONNECT_LIMIT = { count: 5, windowMs: 10_000 } as const;

/** One channel per window, re-issued after an engine restart, revoked when the window closes or navigates. */
export function createPortBroker(deps: BrokerDeps) {
  const holders = new Map<number, PortWindow>();
  const asked = new Map<number, number[]>();
  let generation = 0;

  /** Records an ask; false when the window has asked `CONNECT_LIMIT.count` times in the last `windowMs`. */
  const allowAsk = (windowId: number) => {
    const now = (deps.now ?? Date.now)();
    const recent = (asked.get(windowId) ?? []).filter(at => now - at < CONNECT_LIMIT.windowMs);
    if (recent.length >= CONNECT_LIMIT.count) {
      asked.set(windowId, recent);
      return false;
    }
    asked.set(windowId, [...recent, now]);
    return true;
  };

  const revoke = (windowId: number) => {
    if (!holders.delete(windowId)) return;
    deps.link()?.detach(windowId);
  };
  const issue = (win: PortWindow, link: EngineLink) => {
    const { engineEnd, windowEnd } = deps.channel();
    link.attach(win.id, engineEnd);
    holders.set(win.id, win);
    win.deliver(windowEnd, ++generation);
  };

  return {
    /** A window asked for its port (after `trustedCaller`). A second ask replaces the first port. */
    connect(win: PortWindow): void {
      const link = deps.link();
      if (!link || link.exited) throw unavailable();
      if (win.isDestroyed() || !win.trusted()) throw new Error('Untrusted application window.');
      if (!allowAsk(win.id)) throw unavailable();
      revoke(win.id);
      issue(win, link);
    },
    /** The window closed or its main frame navigated: its port stops at once. */
    revoke,
    /** A restarted engine: every window that held a port and still shows the app gets a new one. */
    reissue(): void {
      const link = deps.link();
      for (const win of [...holders.values()]) {
        holders.delete(win.id);
        if (link && !link.exited && !win.isDestroyed() && win.trusted()) issue(win, link);
      }
    },
    desktop(frame: DesktopFrame): void {
      for (const win of holders.values()) if (!win.isDestroyed()) win.desktop(frame);
    },
    holders: () => [...holders.keys()],
  };
}

/** The events of a window's webContents that end its port (`main/engine-real.ts` passes the real webContents). */
export interface RevokeSource {
  on(event: 'did-navigate' | 'render-process-gone' | 'destroyed', listener: () => void): unknown;
}

/**
 * Revokes a window's port when its main frame COMMITS a new document (`did-navigate`, main frame only, never in-page),
 * when its renderer dies, or when the webContents goes. Never on `did-start-navigation`: Electron fires that before
 * `will-navigate`, so a link the window layer cancels (opened in the browser instead) would leave the page without a
 * port. A committed document runs a fresh preload, which asks again.
 */
export function revokeOnNewDocument(contents: RevokeSource, revoke: () => void): void {
  contents.on('did-navigate', revoke);
  contents.on('render-process-gone', revoke);
  contents.on('destroyed', revoke);
}

/** `window.compose` through main's own connection: the draft must exist in the engine (`Draft/get`). */
export async function draftOpenable(
  link: EngineLink | undefined,
  draftId: string,
): Promise<boolean> {
  if (!link) throw unavailable();
  const result = (await link.call('Draft/get', { ids: [draftId] })) as {
    list?: { id?: unknown }[];
  };
  return Array.isArray(result?.list) && result.list.some(draft => draft?.id === draftId);
}

/** Sign-in pages the engine may ask main to open (the host channel's `openExternal`, purpose `oauth`). */
const signInPaths: ReadonlyMap<string, string> = new Map([
  ['accounts.google.com', '/o/oauth2/v2/auth'],
]);

/** The URL to open when it is a provider's https sign-in page, else undefined. */
export function signInURL(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 4000) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    return signInPaths.get(url.hostname) === url.pathname ? url.href : undefined;
  } catch {
    return undefined;
  }
}

// ---- the window's side (preload) ----------------------------------------------------------------------------------

/** The window's end of its channel (a DOM `MessagePort` in preload's isolated world). */
export interface WindowPortEnd {
  post(message: PortCall, transfer: ArrayBuffer[]): void;
  onMessage(handler: (data: unknown) => void): void;
  /** The other end went away (main revoked the port, the engine stopped). */
  onClose?(handler: () => void): void;
  close(): void;
}

type Waiting = { resolve(value: unknown): void; reject(error: PortError): void };
type Queued = { method: string; args: unknown; transfer: ArrayBuffer[] } & Waiting;

const restarted: PortError = {
  type: 'unavailable',
  message: 'The mailbox restarted. Try again.',
};
const lost: PortError = {
  type: 'unavailable',
  message: 'The connection to the mailbox closed. Try again.',
};

/**
 * A window's engine connection over whatever port main delivered last. Calls wait for the first port. A new port
 * (an engine restart) answers the old port's open calls `unavailable` and resumes: on the same `dbEpoch` the window
 * keeps its state token and nothing is re-sent; on another one the window gets a `reset {reason: 'dbEpoch'}`.
 * Failed calls reject with the contract's error body, a plain object that crosses `contextBridge` intact. When the port
 * closes under the window, its open calls fail at once and `onLost` runs, so preload asks main for a new one.
 */
export function createPortClient(
  allow: ReadonlySet<string> = portMethods,
  options: { onLost?(): void } = {},
) {
  const listeners = new Set<(frame: Frame | DesktopFrame) => void>();
  const waiting = new Map<number, Waiting>();
  const queue: Queued[] = [];
  let end: WindowPortEnd | undefined;
  let open = false;
  let counter = 0;
  let dbEpoch: string | undefined;
  let seq: number | undefined;

  const emit = (frame: Frame | DesktopFrame) => {
    for (const listener of [...listeners]) {
      try {
        listener(frame);
      } catch {
        // A listener's bug is not the transport's.
      }
    }
  };
  const post = (call: Queued) => {
    const id = ++counter;
    waiting.set(id, call);
    try {
      end!.post({ v: 1, id, method: call.method, args: call.args }, call.transfer);
    } catch {
      waiting.delete(id);
      call.reject({ type: 'validation', message: 'These arguments cannot be sent.' });
    }
  };
  const hello = (message: { dbEpoch: string; seq: number }) => {
    if (dbEpoch !== undefined && message.dbEpoch !== dbEpoch)
      emit({ frame: 'reset', dbEpoch: message.dbEpoch, seq: message.seq, reason: 'dbEpoch' });
    if (message.dbEpoch !== dbEpoch) seq = message.seq;
    dbEpoch = message.dbEpoch;
    open = true;
    for (const call of queue.splice(0)) post(call);
  };
  const receive = (data: unknown) => {
    const message = data as PortMessage;
    if (!message || typeof message !== 'object') return;
    if (message.kind === 'hello') return hello(message);
    if (message.kind === 'frame') {
      const frame = message.frame;
      if (frame && 'seq' in frame && frame.dbEpoch === dbEpoch) seq = Math.max(seq ?? 0, frame.seq);
      return emit(frame);
    }
    if (message.kind !== 'reply') return;
    const call = waiting.get(message.id);
    if (!call) return;
    waiting.delete(message.id);
    if (message.ok) call.resolve(message.result);
    else call.reject(message.error);
  };

  return {
    /** Main delivered a port: the first one, or a new one after an engine restart or a reload. */
    attach(next: WindowPortEnd): void {
      end?.close();
      for (const call of waiting.values()) call.reject(restarted);
      waiting.clear();
      open = false;
      end = next;
      next.onMessage(data => {
        if (end === next) receive(data);
      });
      next.onClose?.(() => {
        if (end !== next) return;
        end = undefined;
        open = false;
        for (const call of waiting.values()) call.reject(lost);
        waiting.clear();
        options.onLost?.();
      });
    },
    /** A port is held (it may still be waiting for its `hello`). */
    connected: () => end !== undefined,
    call(method: unknown, args?: unknown, transfer?: unknown): Promise<unknown> {
      if (typeof method !== 'string' || !allow.has(method))
        return Promise.reject({ type: 'unsupported', message: 'Unsupported application method.' });
      // The engine refuses these too, but only after the port has copied them into its process: refuse them here.
      if (argsBytes(method, args) > argsLimit(method))
        return Promise.reject({ type: 'tooLarge', message: 'This request is too large to send.' });
      // Only ArrayBuffers move; a port or anything else in the list is dropped (the structured clone then copies or refuses).
      const buffers = Array.isArray(transfer)
        ? transfer.filter((item): item is ArrayBuffer => item instanceof ArrayBuffer)
        : [];
      return new Promise((resolve, reject) => {
        const call: Queued = { method, args: args ?? {}, transfer: buffers, resolve, reject };
        if (open && end) post(call);
        else queue.push(call);
      });
    },
    /** The window could not get a port at all (no real engine, or refused): every waiting call fails. */
    fail(error: PortError): void {
      for (const call of queue.splice(0)) call.reject(error);
    },
    /** A `desktop` frame from main (engine reachability, the window's own lifecycle). */
    desktop(frame: unknown): void {
      if ((frame as DesktopFrame | null)?.frame === 'desktop') emit(frame as DesktopFrame);
    },
    subscribe(listener: (frame: Frame | DesktopFrame) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** The window's state token: the `dbEpoch` and newest `seq` it has seen. */
    position: () => ({ dbEpoch, seq }),
    close(): void {
      end?.close();
      end = undefined;
      open = false;
      for (const call of waiting.values()) call.reject(restarted);
      waiting.clear();
      listeners.clear();
    },
  };
}

export type PortClient = ReturnType<typeof createPortClient>;

/**
 * The renderer argument main gives a window on the real path (`webPreferences.additionalArguments`). Without it
 * preload exposes no engine bridge and listens on no engine channel, so the default path shows a page nothing new.
 */
export const ENGINE_PORT_ARG = '--aplos-engine-port';

/** A window's `additionalArguments`: the engine bridge's flag on the real path, nothing otherwise. */
export const engineWindowArguments = (real: boolean): string[] => (real ? [ENGINE_PORT_ARG] : []);

/** The parts of Electron's `contextBridge` and `ipcRenderer` the engine bridge uses (preload passes the real ones). */
export interface PreloadElectron {
  contextBridge: { exposeInMainWorld(key: string, api: unknown): void };
  ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(
      channel: string,
      listener: (event: { ports: readonly unknown[] }, data?: unknown) => void,
    ): unknown;
  };
}

/** The DOM `MessagePort` preload receives, as far as the bridge uses it. */
interface DomMessagePort {
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  addEventListener(type: 'close', listener: () => void): void;
  close(): void;
}

function domWindowEnd(port: DomMessagePort): WindowPortEnd {
  return {
    post: (message, transfer) => port.postMessage(message, transfer),
    onMessage: handler => {
      port.onmessage = message => handler(message.data);
    },
    onClose: handler => port.addEventListener('close', handler),
    close: () => port.close(),
  };
}

/**
 * Exposes `window.aplosEngine` (only `call`, `subscribe` and `position`; never a port or an Electron object) when
 * main passed `ENGINE_PORT_ARG`, and returns whether it did. Engine methods go down this window's own port after the
 * allowlist and size checks; desktop methods go to main. Main hands the port only to this window's trusted main frame.
 */
export function exposeEngineBridge(electron: PreloadElectron, argv: readonly string[]): boolean {
  if (!argv.includes(ENGINE_PORT_ARG)) return false;
  const { contextBridge, ipcRenderer } = electron;
  let asked: Promise<unknown> | undefined;
  // A port that closes under the page (revoked, engine stopped) fails its open calls; the next call asks main again.
  const engine = createPortClient(portMethods, { onLost: () => (asked = undefined) });
  /** Asks main for this window's port once; a refusal (no real engine, an untrusted frame) fails the waiting calls. */
  const connect = () => {
    asked ??= ipcRenderer.invoke('aplos:engine-connect').catch(() => {
      asked = undefined;
      engine.fail({ type: 'unavailable', message: 'The new mailbox engine is not running.' });
    });
  };
  ipcRenderer.on('aplos:engine-port', event => {
    const [port] = event.ports;
    if (port) engine.attach(domWindowEnd(port as DomMessagePort));
  });
  ipcRenderer.on('aplos:desktop', (_event, frame) => engine.desktop(frame));
  contextBridge.exposeInMainWorld('aplosEngine', {
    call: (method: unknown, args?: unknown, transfer?: unknown): Promise<unknown> => {
      if (typeof method === 'string' && isDesktopMethod(method))
        // A failure comes back as an envelope (main answers it, so its reason survives); the page gets the plain error
        // body, as from any other failed call. A rejection here is main refusing the caller, which has no reason to give.
        return ipcRenderer.invoke('aplos:desktop', method, args).then(
          result => {
            const failure = failureOf(result);
            if (failure) return Promise.reject(failure);
            return result;
          },
          () => Promise.reject({ type: 'unavailable', message: 'That did not work. Try again.' }),
        );
      // A refused name never even asks for a port.
      if (typeof method === 'string' && portMethods.has(method)) connect();
      return engine.call(method, args, transfer);
    },
    subscribe: (listener: Parameters<typeof engine.subscribe>[0]) => {
      connect();
      return engine.subscribe(frame => listener(frame));
    },
    position: () => engine.position(),
  });
  return true;
}
