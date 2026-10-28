import type { Listener } from '@aplos/contract/legacy/types';

/** One side of a message channel: Electron's utility process port, or a worker_threads port in tests. */
export interface Port {
  post(message: unknown): void;
  listen(handler: (message: unknown) => void): void;
}

/** What the engine needs at start that only the main process has. */
export interface EngineInit {
  dataDir: string;
  symbolTool?: string;
  /** The data key for credential encryption, unwrapped by the OS keychain in the main process. */
  key?: Uint8Array;
  /** Why there is no key, shown when an account needs one. */
  keyError?: string;
}

/** Services the main process keeps because the engine process cannot reach them. */
export type MainCall = 'openExternal';

interface Engine {
  invoke(method: string, payload?: unknown): Promise<unknown>;
  subscribe(listener: Listener): () => void;
  close(): Promise<void>;
}

type Message =
  | { kind: 'init'; init: EngineInit }
  | { kind: 'ready' }
  | { kind: 'fatal'; message: string }
  | { kind: 'invoke'; id: number; method: string; payload?: unknown }
  | { kind: 'result'; id: number; value?: unknown }
  | { kind: 'error'; id: number; message: string }
  | { kind: 'event'; event: Parameters<Listener>[0] }
  | { kind: 'call'; id: number; method: MainCall; args: unknown[] }
  | { kind: 'reply'; id: number; value?: unknown; error?: string }
  | { kind: 'close' }
  | { kind: 'closed' };

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : 'The request failed.';

/** Run the engine behind a port. `start` builds the service once the main process sends its settings. */
export function serveEngine(
  port: Port,
  start: (
    init: EngineInit,
    call: (method: MainCall, ...args: unknown[]) => Promise<unknown>,
  ) => Promise<Engine>,
  exit: () => void = () => {},
) {
  let engine: Engine | undefined,
    starting: Promise<Engine> | undefined,
    nextCall = 0;
  const calls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const post = (message: Message) => port.post(message);
  const call = (method: MainCall, ...args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++nextCall;
      calls.set(id, { resolve, reject });
      post({ kind: 'call', id, method, args });
    });
  port.listen(raw => {
    const message = raw as Message;
    if (message.kind === 'init' && !starting) {
      starting = start(message.init, call);
      starting.then(
        started => {
          engine = started;
          started.subscribe(event => post({ kind: 'event', event }));
          post({ kind: 'ready' });
        },
        error => post({ kind: 'fatal', message: messageOf(error) }),
      );
    } else if (message.kind === 'invoke') {
      const { id } = message;
      if (!engine) {
        post({ kind: 'error', id, message: 'The mailbox is still opening.' });
        return;
      }
      engine.invoke(message.method, message.payload).then(
        value => post({ kind: 'result', id, value }),
        error => post({ kind: 'error', id, message: messageOf(error) }),
      );
    } else if (message.kind === 'reply') {
      const pending = calls.get(message.id);
      if (!pending) return;
      calls.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(message.error));
      else pending.resolve(message.value);
    } else if (message.kind === 'close') {
      void (async () => {
        try {
          await (engine ?? (await starting?.catch(() => undefined)))?.close();
        } finally {
          post({ kind: 'closed' });
          exit();
        }
      })();
    }
  });
}

/**
 * The main process's handle on an engine behind a port. `handle` answers the engine's calls into the
 * main process. If the engine stops, `fail` rejects everything in flight so no window waits forever.
 */
export function connectEngine(
  port: Port,
  init: EngineInit,
  handle: (method: MainCall, args: unknown[]) => Promise<unknown>,
) {
  const listeners = new Set<Listener>(),
    pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 0,
    failure: Error | undefined,
    closed: (() => void) | undefined;
  let ready!: { resolve(): void; reject(error: Error): void };
  const started = new Promise<void>((resolve, reject) => {
    ready = { resolve, reject };
  });
  started.catch(() => {});
  const post = (message: Message) => port.post(message);
  port.listen(raw => {
    const message = raw as Message;
    if (message.kind === 'ready') ready.resolve();
    else if (message.kind === 'fatal') {
      failure = new Error(message.message);
      ready.reject(failure);
    } else if (message.kind === 'result' || message.kind === 'error') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.kind === 'result') request.resolve(message.value);
      else request.reject(new Error(message.message));
    } else if (message.kind === 'event') {
      for (const listener of listeners) {
        try {
          listener(message.event);
        } catch {
          /* One window's failure must not stop the others. */
        }
      }
    } else if (message.kind === 'call') {
      const { id } = message;
      handle(message.method, message.args).then(
        value => post({ kind: 'reply', id, value }),
        error => post({ kind: 'reply', id, error: messageOf(error) }),
      );
    } else if (message.kind === 'closed') closed?.();
  });
  post({ kind: 'init', init });
  return {
    started,
    invoke(method: string, payload?: unknown): Promise<unknown> {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        post({ kind: 'invoke', id, method, payload });
      });
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** The engine stopped: reject waiting requests and refuse new ones. */
    fail(error: Error) {
      failure ??= error;
      ready.reject(failure);
      for (const request of pending.values()) request.reject(failure);
      pending.clear();
      closed?.();
    },
    /** Ask the engine to finish its work and close the database; resolves when it has, or after `timeoutMs`. */
    close(timeoutMs = 15_000): Promise<void> {
      if (failure) return Promise.resolve();
      return new Promise<void>(resolve => {
        const timer = setTimeout(resolve, timeoutMs);
        closed = () => {
          clearTimeout(timer);
          resolve();
        };
        post({ kind: 'close' });
      });
    },
  };
}
