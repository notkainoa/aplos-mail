import { connect, type Socket } from 'node:net';
import type { Frame } from '@aplos/contract';
import { checkAccess, principalOf, type Caller } from '@aplos/contract/access';
import { ContractError } from '@aplos/contract/contract-error';
import {
  generateToken,
  hashToken,
  type ClientRegistry,
  type DoorwayBackend,
  type ResetFrame,
  type StoredClient,
} from '../../src/host/transports/auth';

/*
 * Fakes for the doorway tests (host-4): a client registry over an in-memory table and an engine backend that records
 * every entry, so each refusal can assert the backend was never reached. The backend applies the contract's real
 * `checkAccess`, as the engine's `dispatch` does, before "executing".
 */

export interface FakeRegistry {
  registry: ClientRegistry;
  /** Every hash looked up, in order. */
  lookups: string[];
  touched: string[];
  grant(scopes: string[], kind?: string): { token: string; id: string };
  revoke(id: string): void;
  /** Overwrite a stored row's fields (a registry bug, a hash mismatch). */
  tamper(id: string, patch: Partial<StoredClient>): void;
}

export function fakeRegistry(): FakeRegistry {
  const rows = new Map<string, StoredClient>();
  const listeners = new Set<(id: string) => void>();
  const lookups: string[] = [];
  const touched: string[] = [];
  let next = 0;
  const byId = (id: string) => [...rows.values()].find(row => row.id === id);
  return {
    lookups,
    touched,
    registry: {
      findByTokenHash: async hash => {
        lookups.push(hash);
        return rows.get(hash);
      },
      touch: id => void touched.push(id),
      onRevoked: listener => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
    grant(scopes, kind = 'cli') {
      next += 1;
      const token = generateToken();
      const id = `client-${next}`;
      rows.set(hashToken(token), { id, kind, scopes, tokenHash: hashToken(token) });
      return { token, id };
    },
    revoke(id) {
      const row = byId(id);
      if (row) row.revokedAt = 1_000;
      for (const listener of listeners) listener(id);
    },
    tamper(id, patch) {
      const row = byId(id);
      if (row) Object.assign(row, patch);
    },
  };
}

interface Sink {
  caller: Caller;
  onFrame(frame: Frame): void;
  onReset(frame: ResetFrame): void;
}

export interface CallRecord {
  method: string;
  args: unknown;
  caller: Caller;
  opId?: string;
}

export interface FakeBackend {
  backend: DoorwayBackend;
  /** Every entry into the backend that could have an effect: calls, subscriptions, blob reads and writes, OpenAPI. */
  entered: string[];
  calls: CallRecord[];
  /** Calls that passed the engine's own `checkAccess` and "ran". */
  executed: string[];
  subscriptions: { caller: Caller; since?: { dbEpoch: string; seq: number } }[];
  /** Per-method behaviour; the default answers `{ method }`. */
  handlers: Map<string, (args: unknown, signal: AbortSignal) => Promise<unknown> | unknown>;
  emit(frame: Frame): void;
  reset(frame: ResetFrame): void;
  subscribers(): number;
  maxConcurrent(): number;
}

export const DB_EPOCH = 'epoch-test';

export function fakeBackend(): FakeBackend {
  const entered: string[] = [];
  const calls: CallRecord[] = [];
  const executed: string[] = [];
  const subscriptions: FakeBackend['subscriptions'] = [];
  const handlers: FakeBackend['handlers'] = new Map();
  const sinks = new Set<Sink>();
  const blobs = new Map<string, { owner: string; bytes: Uint8Array; mime: string }>();
  let running = 0;
  let peak = 0;
  let blobSeq = 0;
  const backend: DoorwayBackend = {
    async call(caller, method, args, opts) {
      entered.push(`call:${method}`);
      calls.push({ method, args, caller, opId: opts.opId });
      checkAccess(method, caller, args);
      executed.push(method);
      running += 1;
      peak = Math.max(peak, running);
      try {
        const handler = handlers.get(method);
        return handler ? await handler(args, opts.signal) : { method };
      } finally {
        running -= 1;
      }
    },
    subscribe(caller, since, onFrame, onReset) {
      entered.push('subscribe');
      subscriptions.push({ caller, since });
      const sink = { caller, onFrame, onReset };
      sinks.add(sink);
      return () => void sinks.delete(sink);
    },
    blob: {
      async get(caller, id) {
        entered.push(`blob.get:${id}`);
        const blob = blobs.get(id);
        if (!blob || blob.owner !== principalOf(caller))
          throw new ContractError({ type: 'notFound', message: 'That file is not here.' });
        return { bytes: blob.bytes, mime: blob.mime };
      },
      async put(caller, bytes, meta) {
        entered.push('blob.put');
        blobSeq += 1;
        const blobId = `b${blobSeq}x${'0'.repeat(30)}`;
        blobs.set(blobId, {
          owner: principalOf(caller),
          bytes: new Uint8Array(bytes),
          mime: meta.mime,
        });
        return { blobId, size: bytes.byteLength };
      },
    },
    session: () => ({ apiVersion: 1, dbEpoch: DB_EPOCH, appVersion: '0.0.0-test' }),
    openapi: () => {
      entered.push('openapi');
      return '{"openapi":"3.1.0"}';
    },
  };
  return {
    backend,
    entered,
    calls,
    executed,
    subscriptions,
    handlers,
    emit: frame => [...sinks].forEach(sink => sink.onFrame(frame)),
    reset: frame => [...sinks].forEach(sink => sink.onReset(frame)),
    subscribers: () => sinks.size,
    maxConcurrent: () => peak,
  };
}

/** A `state` frame at `seq`. */
export function stateFrame(seq: number): Frame {
  return { frame: 'state', dbEpoch: DB_EPOCH, seq, types: { Thread: seq } };
}

/** A raw connection that collects everything it receives, for byte-exact requests and streaming reads. */
export interface RawConnection {
  socket: Socket;
  text(): string;
  /** Resolves once `predicate(text)` holds, or rejects after `ms`. */
  waitFor(predicate: (text: string) => boolean, ms?: number): Promise<string>;
  /** Resolves with the time it took for the server to close the connection, or rejects after `ms`. */
  closed(ms?: number): Promise<number>;
  isClosed(): boolean;
}

export function rawConnect(target: { port: number } | { path: string }): Promise<RawConnection> {
  return new Promise((resolve, reject) => {
    const socket =
      'port' in target ? connect({ host: '127.0.0.1', port: target.port }) : connect(target.path);
    const started = Date.now();
    let received = '';
    let closedAt: number | undefined;
    const waiters = new Set<() => void>();
    const notify = () => [...waiters].forEach(waiter => waiter());
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      received += chunk;
      notify();
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      closedAt = Date.now();
      notify();
    });
    const until = <T>(check: () => T | undefined, ms: number, what: string) =>
      new Promise<T>((done, fail) => {
        const attempt = () => {
          const value = check();
          if (value === undefined) return false;
          clearTimeout(timer);
          waiters.delete(waiter);
          done(value);
          return true;
        };
        const waiter = () => void attempt();
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          fail(
            new Error(
              `timed out waiting for ${what}; got ${JSON.stringify(received.slice(0, 300))}`,
            ),
          );
        }, ms);
        waiters.add(waiter);
        attempt();
      });
    const connection: RawConnection = {
      socket,
      text: () => received,
      waitFor: (predicate, ms = 2_000) =>
        until(() => (predicate(received) ? received : undefined), ms, 'data'),
      closed: (ms = 2_000) =>
        until(() => (closedAt === undefined ? undefined : closedAt - started), ms, 'close'),
      isClosed: () => closedAt !== undefined,
    };
    socket.once('connect', () => resolve(connection));
    socket.once('error', reject);
  });
}

export const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
