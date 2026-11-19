/**
 * The renderer's real transport (plan 30 4.1): the contract's `EngineSession` over `window.aplosEngine`, which
 * preload exposes only on the real-engine path (`host/transports/port.ts` `exposeEngineBridge`). Inside the exposed
 * `call`, engine methods go down this window's own MessagePort and desktop methods go to main, so one session serves
 * the data layer whole. In a development build `main.tsx` connects the new roots to it instead of the in-process
 * stand-in; a release build boots the legacy renderer before any of this runs, and the browser preview's tokenised
 * HTTP and SSE transport is still to come.
 *
 * Everything that comes back is untrusted data from another world. Every frame is validated against the contract's
 * `Frame` schema before a listener sees it — an invalid one is dropped silently — and a throwing listener never
 * affects the others. A failed call rejects with a `ContractError` built from the validated error body; anything
 * unrecognised becomes `unavailable` with the one transport-failure sentence, so foreign text beyond a schema-valid
 * `message` (itself capped) never crosses. The session keeps only the two members it calls — `call` and `subscribe`;
 * the exposed `position()` is left alone because nothing needs it: the data layer learns the `dbEpoch` from
 * `Session/get` and every frame carries its own `{dbEpoch, seq}`. Nothing is logged and no arguments, results or the
 * bridge object itself are exposed or retained past `close()`.
 */
import {
  configureZodForCsp,
  ContractError,
  ErrorBodySchema,
  Frame,
  type ErrorBody,
} from '@aplos/contract';
import type { EngineSession } from '@aplos/contract/client';
import { UNREACHABLE_MESSAGE } from './data/client';

/** The members of `window.aplosEngine` this session uses (`position` is deliberately absent). */
interface EngineBridge {
  call(method: string, args: unknown, transfer?: ArrayBuffer[]): unknown;
  subscribe(listener: (frame: unknown) => void): unknown;
}

/** The longest error message the bridge carries across; the data layer shows it verbatim. */
const MAX_MESSAGE_CHARS = 500;

const noop = () => {};

/**
 * Attaches a swallowing catch to a foreign thenable — the unsubscribe value `subscribe` hands back or the value
 * the unsubscribe call returns — so its rejection can never surface as an unhandled rejection. Non-thenables and
 * an object whose `then` getter throws are left alone.
 */
function swallowRejection(value: unknown): void {
  try {
    if (
      value !== null &&
      (typeof value === 'object' || typeof value === 'function') &&
      typeof (value as { then?: unknown }).then === 'function'
    )
      void Promise.resolve(value).catch(noop);
  } catch {
    // A hostile object whose `then` getter throws was never chained, so there is nothing to swallow.
  }
}

/** `message` capped at MAX_MESSAGE_CHARS code points, so a cap never leaves a lone surrogate. */
function capMessage(message: string): string {
  return message.length > MAX_MESSAGE_CHARS
    ? Array.from(message).slice(0, MAX_MESSAGE_CHARS).join('')
    : message;
}

/**
 * `host`'s `aplosEngine` when it is an object whose `call` and `subscribe` are functions, else null. Never throws:
 * a non-object, missing members or a getter that throws all read as "no bridge".
 */
function readBridge(host: unknown): EngineBridge | null {
  try {
    const api = (host as { aplosEngine?: unknown } | null | undefined)?.aplosEngine;
    if (api === null || typeof api !== 'object') return null;
    const bridge = api as EngineBridge;
    if (typeof bridge.call !== 'function' || typeof bridge.subscribe !== 'function') return null;
    return bridge;
  } catch {
    return null;
  }
}

/** Whether `host` (default: this window's `globalThis`) carries the preload's engine bridge. */
export function hasEngineBridge(host: unknown = globalThis): boolean {
  return readBridge(host) !== null;
}

/** The `body` a rejection carries (a cloned `ContractError` keeps its body when its own fields are lost). */
function innerBody(reason: unknown): unknown {
  return reason !== null && typeof reason === 'object'
    ? (reason as { body?: unknown }).body
    : undefined;
}

/**
 * The validated `ErrorBody` inside a rejection: its `body` first — a real `ContractError` carries `reasonCode`,
 * `resumeAt`, `path` and `retryAfterMs` only there, and a cloned one may keep only `body` — then the rejection
 * itself, with the message capped. A `body` getter that throws forfeits only the inner candidate, and a candidate
 * that does not parse against `ErrorBodySchema` (a string, null, an object without `type` and `message`, a value
 * whose getters break the parser) is skipped; when neither parses the answer is undefined.
 */
function errorBody(reason: unknown): ErrorBody | undefined {
  let inner: unknown;
  try {
    inner = innerBody(reason);
  } catch {
    inner = undefined;
  }
  for (const candidate of [inner, reason]) {
    try {
      if (candidate === null || typeof candidate !== 'object') continue;
      const parsed = ErrorBodySchema.safeParse(candidate);
      if (parsed.success) return { ...parsed.data, message: capMessage(parsed.data.message) };
    } catch {
      // A candidate whose getters break the parser drops like any invalid body.
    }
  }
  return undefined;
}

/** A rejection as the `ContractError` the data layer understands: the engine's body, else the transport failure. */
function toContractError(reason: unknown): ContractError {
  return new ContractError(
    errorBody(reason) ?? { type: 'unavailable', message: UNREACHABLE_MESSAGE },
  );
}

/**
 * An `EngineSession` on the bridge, or null when `host` has none. One upstream subscription fans out to every
 * listener. `close()` unsubscribes it, drops every reference and is idempotent: later `call`s reject `unavailable`
 * and `subscribe` returns a no-op unsubscribe.
 */
export function createEngineBridge(host: unknown = globalThis): EngineSession | null {
  const api = readBridge(host);
  if (!api) return null;
  // The renderer's CSP forbids eval, so the frame and error schemas run jitless before the first parse.
  configureZodForCsp();

  const listeners = new Set<(frame: Frame) => void>();
  let bridge: EngineBridge | null = api;
  let closed = false;
  let upstreamFailed = false;
  let stopUpstream: (() => void) | null = null;

  const deliver = (raw: unknown) => {
    if (closed) return;
    let frame: Frame | undefined;
    try {
      const parsed = Frame.safeParse(raw);
      if (parsed.success) frame = parsed.data;
    } catch {
      // A value that breaks the parser (a throwing getter) drops like any invalid frame.
      return;
    }
    if (frame === undefined) return;
    for (const listener of [...listeners]) {
      // A listener that closed the session stops the rest of this frame.
      if (closed) return;
      try {
        listener(frame);
      } catch {
        // A listener's bug is not the transport's.
      }
    }
  };

  const openUpstream = () => {
    if (stopUpstream || upstreamFailed || closed || !bridge) return;
    let stop: unknown;
    try {
      stop = bridge.subscribe(deliver);
    } catch {
      // Never retried: the bridge may have registered `deliver` before throwing, so a second
      // `subscribe` on the next listener could deliver every frame twice.
      upstreamFailed = true;
      return;
    }
    stopUpstream = typeof stop === 'function' ? (stop as () => void) : noop;
    swallowRejection(stop);
  };

  return {
    call(method, args, options) {
      const api = bridge;
      if (!api)
        return Promise.reject(
          new ContractError({ type: 'unavailable', message: UNREACHABLE_MESSAGE }),
        );
      let sent: Promise<unknown>;
      try {
        // A transfer list passes through only whole: an array of ArrayBuffers, exactly as given.
        const transfer = options?.transfer;
        const buffers =
          Array.isArray(transfer) && transfer.every(item => item instanceof ArrayBuffer)
            ? transfer
            : undefined;
        sent = Promise.resolve(api.call(method, args, buffers));
      } catch (reason) {
        sent = Promise.reject(reason);
      }
      return sent.then(
        result => result,
        reason => {
          throw toContractError(reason);
        },
      );
    },
    subscribe(listener) {
      if (closed || typeof listener !== 'function') return noop;
      listeners.add(listener);
      openUpstream();
      return () => void listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      const stop = stopUpstream;
      stopUpstream = null;
      bridge = null;
      listeners.clear();
      try {
        swallowRejection(stop?.());
      } catch {
        // A foreign unsubscribe that throws changes nothing: the session is closed either way.
      }
    },
  };
}
