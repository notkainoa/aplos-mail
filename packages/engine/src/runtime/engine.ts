import { appScopes } from '@aplos/contract/access';
import type { EngineConnection, EngineSession } from '@aplos/contract/client';
import type { EngineMethodName } from '@aplos/contract';
import { dispatchWith, handlers as table } from '../methods/index';
import type { Caller, EngineHandlers } from '../methods/types';
import type { AiTransport } from '../ports/ai';
import type { Clock, Logger, StorePort } from '../ports';
import { openConnection, type ConnectedSession } from './connection';
import { contractError } from './errors';
import { createFrameHub, observeCommits } from './frames';
import type { EngineServices, HostFacts, LaneModule, LaneModuleSource } from './services';

/** Ports a host injects when it has them; each one left out is a stand-in that answers `unavailable`. */
export type HostPorts = Partial<
  Pick<
    EngineServices,
    | 'accounts'
    | 'send'
    | 'drafts'
    | 'calendar'
    | 'rules'
    | 'deadlines'
    | 'html'
    | 'laneFor'
    | 'images'
    | 'unsubscribe'
    | 'keys'
    | 'clientTokens'
    | 'blobFiles'
    | 'attachmentFiles'
  > & {
    /** The AI provider transport (`host/ai`, eng-ai); absent, the ai lane stays on its detached stand-in. */
    aiTransport: AiTransport;
  }
>;

export interface EngineOptions {
  /** Opened by the host with every lane's `extensions` (seam 2). The engine never closes it. */
  store: StorePort;
  clock: Clock;
  log: Logger;
  randomBytes?: (n: number) => Uint8Array;
  ports?: HostPorts;
  /** Facts about the build and this Mac for `Session/get`; absent: a bare build named 'This Mac'. */
  host?: HostFacts;
  /** The host's argument check, `parseArgs` from `@aplos/contract`; transports that validate themselves omit it. */
  validate?: (method: string, args: unknown) => unknown;
  /** Tests only: handlers that replace the F5 table's entries of the same name. */
  handlers?: Partial<EngineHandlers>;
}

/** The running engine: an `EngineConnection` (what the stand-in implements), its services, and shutdown. */
export interface Engine extends EngineConnection {
  /** A session as an Electron window (every scope), or as `caller`: main, or a listener client with its grant. */
  connect(caller?: Caller): ConnectedSession;
  readonly services: EngineServices;
  /**
   * The host's power-resume (or network, or clock-change) hook: re-reads every deadline now instead of at the next
   * capped timer turn. A no-op before the timer loop exists, with a host-injected registry that has no `wake`, or after `close`.
   */
  wake(): void;
  /** Closes every connection and stops the lane modules in reverse order. */
  close(): Promise<void>;
}

/** The caller `connect()` gets when none is named, as in the stand-in engine. */
export const windowCaller: Caller = Object.freeze({
  kind: 'window',
  scopes: Object.freeze([...appScopes]),
});

const unavailable = () =>
  contractError({ type: 'unavailable', message: 'This part of Aplos is not running yet.' });
const absentPorts = new WeakSet<object>();

/** A port the host has not injected: callable, and every member rejects with `unavailable`. */
function absent<T>(): T {
  const fail = () => {
    throw unavailable();
  };
  const port = new Proxy(fail, {
    // `then` stays undefined so awaiting the port itself does not call it.
    get: (_target, key) => (key === 'then' || typeof key === 'symbol' ? undefined : fail),
    apply: fail,
  });
  absentPorts.add(port);
  return port as T;
}

/** True for a stand-in from `createEngine`: a lane's `start` can skip work that needs a port the host has not given yet. */
export function isAbsent(port: unknown): boolean {
  return typeof port === 'function' && absentPorts.has(port);
}

const HOST_PORTS = [
  'accounts',
  'send',
  'drafts',
  'calendar',
  'rules',
  'deadlines',
  'html',
  'laneFor',
  'images',
  'unsubscribe',
  'keys',
  'clientTokens',
  'blobFiles',
  'attachmentFiles',
] as const satisfies readonly (keyof HostPorts)[];

/**
 * Builds the engine (seam 1): wraps the store so commits queue `state` frames, fills the services, then creates each lane
 * module in order and starts them all. The composition root (`src/index.ts`) passes the four lane modules.
 */
export async function buildEngine(
  options: EngineOptions,
  modules: readonly LaneModuleSource[],
): Promise<Engine> {
  const hub = createFrameHub({ store: options.store, clock: options.clock });
  const draft = coreServices(options, hub);
  const started = composeModules(draft, modules, new Set(Object.keys(options.ports ?? {})));
  // Frozen once composed: no lane or handler swaps a port, the observed store or the log for everyone after it.
  const services = Object.freeze(draft);
  await startAll(started, hub);
  const dispatch = dispatcher(options.handlers);
  const open = new Set<EngineSession>();
  let counter = 0;
  let closed = false;
  return {
    services,
    connect(...args: [caller?: Caller]) {
      if (closed) throw unavailable();
      // No argument is the stand-in's window; an argument that is undefined is a transport that lost its caller, and
      // must not become a window with every scope.
      const caller = args.length === 0 ? windowCaller : args[0];
      if (!caller)
        throw contractError({
          type: 'forbidden',
          message: 'This connection is not allowed in Aplos.',
        });
      const connectionId = `c${++counter}`;
      const session = openConnection(
        {
          services,
          hub,
          dispatch,
          validate: options.validate,
          connectionId,
          onClose: () => {
            open.delete(session);
            connectionClosed(started, connectionId);
          },
        },
        caller,
      );
      open.add(session);
      return session;
    },
    wake() {
      if (closed || isAbsent(services.deadlines)) return;
      (services.deadlines as { wake?: () => void }).wake?.();
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const session of [...open]) session.close();
      for (const lane of [...started].reverse()) await lane.stop?.();
      hub.close();
    },
  };
}

function coreServices(options: EngineOptions, hub: ReturnType<typeof createFrameHub>) {
  const randomBytes =
    options.randomBytes ?? ((n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  const services = {
    // A commit that wrote job rows (a `job` write, the ingest sentinel) pokes the `jobs` deadline, so the queue
    // actually drains instead of waiting for its next scheduled re-read.
    store: observeCommits(options.store, {
      ...hub,
      changed: types => {
        if ('AiJob' in types && !isAbsent(services.deadlines))
          try {
            services.deadlines.changed('jobs');
          } catch {
            // The source re-reads on its own schedule; a registry fault never fails a commit's caller.
          }
        hub.changed(types);
      },
    }),
    clock: options.clock,
    log: options.log,
    frames: Object.freeze({ emit: hub.emit, changed: hub.changed, reset: hub.reset }),
    randomBytes,
    host: options.host ?? BARE_HOST,
  } as EngineServices;
  for (const name of HOST_PORTS)
    (services as unknown as Record<string, unknown>)[name] = options.ports?.[name] ?? absent();
  // The AI transport is copied, never proxied: unbound means the ai lane's own detached stand-in, which the
  // lane reads in createModule and answers 'unavailable' itself.
  if (options.ports?.aiTransport) services.aiTransport = options.ports.aiTransport;
  return services;
}

const CORE = new Set(['store', 'clock', 'log', 'frames', 'randomBytes', 'host']);

const BARE_HOST: HostFacts = Object.freeze({
  appVersion: '0.0.0',
  device: Object.freeze({ id: 'device', name: 'This Mac' }),
  resident: false,
  capabilities: Object.freeze({}),
});

/** Starts the lanes in order; when one fails, stops the ones already running, in reverse, and rethrows. */
async function startAll(lanes: readonly LaneModule[], hub: { close(): void }) {
  const running: LaneModule[] = [];
  try {
    for (const lane of lanes) {
      await lane.start?.();
      running.push(lane);
    }
  } catch (error) {
    for (const lane of running.reverse()) await lane.stop?.();
    hub.close();
    throw error;
  }
}

/** What `createModule` sees: every service built so far, read-only. A lane adds its own only by returning them. */
function readOnly(services: EngineServices): EngineServices {
  const refuse = (_target: object, key: string | symbol) => {
    throw new Error(`A lane module cannot change services.${String(key)}; return it instead`);
  };
  const traps: ProxyHandler<EngineServices> = {
    set: refuse,
    defineProperty: refuse,
    deleteProperty: refuse,
  };
  return new Proxy(services, traps);
}

/** Tells every lane a connection closed; one lane's failure never stops the others or the close. */
function connectionClosed(lanes: readonly LaneModule[], connectionId: string) {
  for (const lane of lanes) {
    try {
      lane.onConnectionClose?.(connectionId);
    } catch {
      // A lane's cleanup bug must not keep the connection open.
    }
  }
}

/** Runs each lane's `createModule` in order. A lane may fill a stand-in port, never replace a real one or another lane's. */
function composeModules(
  services: EngineServices,
  modules: readonly LaneModuleSource[],
  injected: ReadonlySet<string>,
): LaneModule[] {
  const owner = new Map<string, string>();
  const view = readOnly(services);
  return modules.map(source => {
    const lane = source.createModule(view);
    for (const [key, value] of Object.entries(lane.services ?? {})) {
      const holder = CORE.has(key) || injected.has(key) ? 'the host' : owner.get(key);
      if (holder) throw new Error(`${source.lane} cannot set services.${key}: ${holder} set it`);
      owner.set(key, source.lane);
      (services as unknown as Record<string, unknown>)[key] = value;
    }
    return lane;
  });
}

function dispatcher(overrides: Partial<EngineHandlers> = {}) {
  const merged = { ...table };
  for (const name of Object.keys(overrides) as EngineMethodName[])
    if (Object.hasOwn(table, name) && overrides[name])
      (merged as Record<string, unknown>)[name] = overrides[name];
  return (method: string, args: unknown, ctx: Parameters<typeof dispatchWith>[3]) =>
    dispatchWith(merged, method, args, ctx);
}
