/**
 * The data layer's one link to the engine: the F2 typed client over an injected transport (plan 30 4.1 `client.ts`).
 * The transport is the stand-in engine in-process or `../bridge.ts`'s `window.aplosEngine` session in Electron; the
 * browser preview's tokenised HTTP and SSE transport plugs in here the same way when it arrives.
 */
import { configureZodForCsp } from '@aplos/contract';
import {
  createClient,
  type Api,
  type EngineConnection,
  type EngineSession,
} from '@aplos/contract/client';
import type { ErrorBody, Frame, Input, MethodName, Output } from './contract-shapes';

/** The F2 client plus what the data layer needs around it. */
export interface DataClient {
  /** The F2 typed client's API (`api.view.watch(...)`). */
  readonly api: Api;
  call<M extends MethodName>(
    method: M,
    args: Input<M>,
    options?: { transfer?: ArrayBuffer[] },
  ): Promise<Output<M>>;
  /** Every frame on the connection, in order. */
  subscribe(listener: (frame: Frame) => void): () => void;
  close(): void;
  /** Calls sent and not yet answered (tests wait for 0). */
  readonly inFlight: number;
  /** A fresh id for an `opId`, `undoOpId` or `requestId`. */
  mintId(prefix: string): string;
}

/** The in-process transport: one session on an engine connection (the stand-in engine, F6). */
export function inProcessTransport(engine: EngineConnection): EngineSession {
  return engine.connect();
}

let mintCounter = 0;
const mintSalt = Math.random().toString(36).slice(2, 8);

/** A client-minted id, unique per renderer: `op-1a2b3c-7`. */
export function mintId(prefix: string): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${mintSalt}-${++mintCounter}`;
  return `${prefix}-${uuid}`;
}

/** Wraps a transport in the typed client. The renderer's CSP forbids eval, so zod runs jitless before anything parses. */
export function createDataClient(
  session: EngineSession,
  options: { mintId?: (prefix: string) => string } = {},
): DataClient {
  configureZodForCsp();
  let inFlight = 0;
  const counted: EngineSession = {
    call(method, args, callOptions) {
      inFlight++;
      const done = () => {
        inFlight--;
      };
      const pending = session.call(method, args, callOptions);
      pending.then(done, done);
      return pending;
    },
    subscribe: listener => session.subscribe(listener),
    close: () => session.close(),
  };
  const client = createClient(counted);
  return {
    api: client.api,
    call: (method, args, callOptions) => client.call(method, args, callOptions),
    subscribe: listener => client.subscribe(listener),
    close: () => client.close(),
    get inFlight() {
      return inFlight;
    },
    mintId: options.mintId ?? mintId,
  };
}

/** The sentence shown when the transport itself fails (DESIGN 7.15). */
export const UNREACHABLE_MESSAGE = "Aplos can't reach its mail engine.";

/** Any thrown value as the contract's `ErrorBody`: a `ContractError`'s body, else a plain transport failure. */
export function toErrorBody(error: unknown): ErrorBody {
  if (typeof error === 'object' && error !== null) {
    const body = (error as { body?: unknown }).body;
    if (
      typeof body === 'object' &&
      body !== null &&
      typeof (body as ErrorBody).type === 'string' &&
      typeof (body as ErrorBody).message === 'string'
    )
      return body as ErrorBody;
  }
  return { type: 'unavailable', message: UNREACHABLE_MESSAGE };
}
