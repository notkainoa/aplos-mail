import type { Frame } from '../wire';
import type { Input, MethodName, Output } from '../registry';
import { ContractError } from '../contract-error';
import { desktopMethods, engineMethods } from '../../generated/methods.generated';

/**
 * The framework-neutral typed client (`@aplos/contract/client`). It imports no zod at runtime: method names come from the
 * generated tables and types from the registry, so a renderer bundle stays small. A renderer that also validates inputs
 * with the registry's schemas must call `configureZodForCsp()` first, because its CSP forbids eval (ARCH 9.3).
 */

/** One open connection to an engine (MessagePort, socket, HTTP and SSE, the stand-in engine in a test). */
export interface EngineSession {
  /** Resolves with the result or rejects with a `ContractError`. `transfer` lists buffers a MessagePort may move instead of copy. */
  call(method: string, args: unknown, options?: { transfer?: ArrayBuffer[] }): Promise<unknown>;
  /** Every frame on the connection's one stream, in order. Returns the unsubscribe function. */
  subscribe(listener: (frame: Frame) => void): () => void;
  close(): void;
}

/** What every transport and the stand-in engine implement (plan 10 section 4.1). */
export interface EngineConnection {
  connect(): EngineSession;
}

type Verbs<T extends string> = { [M in MethodName as M extends `${T}/${infer V}` ? V : never]: M };
type TypeOf<M> = M extends `${infer T}/${string}` ? T : never;
type Call<M extends MethodName> =
  // `{} extends X` is the type-level test for "X has no required field", so the arguments may be omitted.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- a type test, not a value type
  {} extends Input<M>
    ? (args?: Input<M>, options?: { transfer?: ArrayBuffer[] }) => Promise<Output<M>>
    : (args: Input<M>, options?: { transfer?: ArrayBuffer[] }) => Promise<Output<M>>;

/** `api.thread.act(args)`, `api.messageBody.get(args)`, `api.view.watch(args)`: one namespace per contract type, lower camel case. */
export type Api = {
  [T in TypeOf<MethodName> as Uncapitalize<T>]: {
    [V in keyof Verbs<T>]: Verbs<T>[V] extends MethodName ? Call<Verbs<T>[V]> : never;
  };
};

const known = new Set<string>([...engineMethods, ...desktopMethods]);
const desktopSet = new Set<string>(desktopMethods);

export interface Client {
  api: Api;
  /** The same call by name, for code that holds a method name (a command registry, a test). */
  call<M extends MethodName>(
    method: M,
    args: Input<M>,
    options?: { transfer?: ArrayBuffer[] },
  ): Promise<Output<M>>;
  subscribe(listener: (frame: Frame) => void): () => void;
  close(): void;
}

/**
 * Wraps a session in the typed API. `validate`, when given (e.g. the registry's `parseArgs`), runs before a call leaves,
 * so a bad argument fails with the same sentence the host would send.
 */
export function createClient(
  session: EngineSession,
  options: { validate?: (method: MethodName, args: unknown) => unknown } = {},
): Client {
  const call = <M extends MethodName>(
    method: M,
    args: unknown,
    callOptions?: { transfer?: ArrayBuffer[] },
  ) => {
    if (!known.has(method))
      return Promise.reject(
        new ContractError({ type: 'unsupported', message: 'Unsupported application method.' }),
      );
    try {
      options.validate?.(method, args ?? {});
    } catch (error) {
      return Promise.reject(error);
    }
    return session.call(method, args ?? {}, callOptions) as Promise<Output<M>>;
  };
  const namespaces = new Map<string, Record<string, unknown>>();
  const api = new Proxy({} as Api, {
    get(_target, type) {
      if (typeof type !== 'string') return undefined;
      let ns = namespaces.get(type);
      if (!ns) {
        const prefix = `${type[0]!.toUpperCase()}${type.slice(1)}/`;
        ns = new Proxy(
          {},
          {
            get: (_t, verb) =>
              typeof verb === 'string'
                ? (args?: unknown, o?: { transfer?: ArrayBuffer[] }) =>
                    call(`${prefix}${verb}` as MethodName, args, o)
                : undefined,
          },
        );
        namespaces.set(type, ns);
      }
      return ns;
    },
  });
  return {
    api,
    call: (method, args, o) => call(method, args, o),
    subscribe: listener => session.subscribe(listener),
    close: () => session.close(),
  };
}

/**
 * One session over two: desktop methods go to main (preload's invoke), everything else to the engine port, following the
 * generated host table. Frames come from the engine, plus main's own `desktop` frames, which still arrive when the engine
 * cannot answer.
 */
export function routeByHost(sessions: {
  engine: EngineSession;
  desktop: EngineSession;
}): EngineSession {
  return {
    call: (method, args, options) =>
      (desktopSet.has(method) ? sessions.desktop : sessions.engine).call(method, args, options),
    subscribe: listener => {
      const off = [
        sessions.engine.subscribe(listener),
        sessions.desktop.subscribe(frame => {
          if (frame.frame === 'desktop') listener(frame);
        }),
      ];
      return () => off.forEach(stop => stop());
    },
    close: () => {
      sessions.engine.close();
      sessions.desktop.close();
    },
  };
}
