/**
 * The window-close handshake. Main intercepts a window's close (main/windows.ts): it preventDefaults, disables
 * the window and sends `prepare-close` on the `aplos:event` channel, then waits for the renderer's answer —
 * `window.closeReady` finishes the close, `window.closeCancel` keeps the window (invokeNative in
 * main/native-methods.ts; the contract names `Window/closeReady` and `Window/closeCancel` map to those in
 * shared/desktop-v1.ts's `legacyNames`).
 *
 * The listener is PLAIN, unlike mainNavigate's typed one: preload's event hub (shared/event-hub.ts) holds a
 * `prepare-close` that arrives before the app listens in its general queue, and only a listener without `only`
 * ever drains that queue — a typed listener would leave a held close unanswered and the window disabled for
 * good. This subscription is therefore the app's first general one: a held deep-link or command replays here too
 * and is ignored (nothing else reads them yet), and while it is mounted nothing else queues.
 */

/** The part of preload's `window.aplos` this needs. */
export interface PrepareCloseBridge {
  subscribe(listener: (event: { type: string; payload?: unknown }) => void): () => void;
}

/** What the shell answers with: 'ready' finishes the close, 'cancel' keeps the window. */
export type CloseAnswer = 'ready' | 'cancel';

/** Flushes unsaved work (a draft save); resolving `true` means it is safe to close. */
export type CloseGuard = () => boolean | Promise<boolean>;

/** The longest a guard may take before it counts as not safe to close. */
export const CLOSE_GUARD_TIMEOUT_MS = 3000;

const guards = new Set<CloseGuard>();

/**
 * Registers `guard` for every later `prepare-close`; returns the unregister. The reader and compose screens
 * register their draft flush here when those lanes land — registering the same function twice is one
 * registration.
 */
export function registerCloseGuard(guard: CloseGuard): () => void {
  guards.add(guard);
  return () => void guards.delete(guard);
}

/** One guard's answer within `timeoutMs`: only a timely `true` is safe; a throw or a timeout is not. */
function guardSettles(guard: CloseGuard, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const done = (safe: boolean) => {
      clearTimeout(timer);
      resolve(safe);
    };
    try {
      void Promise.resolve(guard()).then(
        safe => done(safe === true),
        () => done(false),
      );
    } catch {
      done(false);
    }
  });
}

/** True when every guard in `list` is safe within `timeoutMs` each; an empty list is ready. Never rejects. */
async function guardsSettle(list: Iterable<CloseGuard>, timeoutMs: number): Promise<boolean> {
  const results = await Promise.all([...list].map(guard => guardSettles(guard, timeoutMs)));
  return results.every(Boolean);
}

/**
 * Answers main's held close on whatever transport the window has: `Window/closeReady|closeCancel` over
 * `window.aplosEngine` on the real engine (preload routes desktop methods to main — host/transports/port.ts —
 * and engine-real.ts's `desktopMethod` maps them through `legacyNames`), else the legacy
 * `window.aplos.invoke` a development Electron window still serves. A window with neither does nothing.
 */
export async function answerClose(answer: CloseAnswer): Promise<void> {
  const method = answer === 'ready' ? 'closeReady' : 'closeCancel';
  try {
    const { createEngineBridge, hasEngineBridge } = await import('../bridge');
    if (hasEngineBridge()) {
      const session = createEngineBridge();
      if (session) {
        try {
          await session.call(`Window/${method}`, {});
        } finally {
          session.close();
        }
        return;
      }
    }
  } catch {
    // No engine session, or the call was refused: the legacy invoke may still answer.
  }
  const invoke = (globalThis as { aplos?: { invoke?: unknown } }).aplos?.invoke;
  if (typeof invoke === 'function')
    await (invoke as (method: string, payload?: unknown) => unknown)(`window.${method}`);
}

export interface ListenPrepareCloseOptions {
  /** The guards to run instead of the registered set (tests inject theirs). */
  readonly guards?: Iterable<CloseGuard>;
  /** How long one guard may take before it counts as not safe (default CLOSE_GUARD_TIMEOUT_MS). */
  readonly guardTimeoutMs?: number;
}

/**
 * Subscribes for `prepare-close` and answers each after the close guards settle: `ready` when every guard is
 * safe (or there are none), `cancel` otherwise. One event gets one answer, a second event while the first is in
 * flight is ignored, and a throwing or rejecting answer is swallowed — the window stays as main left it. The
 * returned unsubscribe stops new events being answered; an answer already owed is still sent.
 */
export function listenPrepareClose(
  bridge: PrepareCloseBridge | undefined,
  answer: (answer: CloseAnswer) => unknown = answerClose,
  options?: ListenPrepareCloseOptions,
): () => void {
  if (!bridge || typeof bridge.subscribe !== 'function') return () => undefined;
  const timeoutMs = options?.guardTimeoutMs ?? CLOSE_GUARD_TIMEOUT_MS;
  let inFlight = false;
  let listening = true;
  const reply = (ready: boolean) => {
    try {
      void Promise.resolve(answer(ready ? 'ready' : 'cancel')).catch(() => undefined);
    } catch {
      // A throwing answer changes nothing: the window stays disabled as main left it.
    }
  };
  const off = bridge.subscribe(event => {
    if (!listening || event.type !== 'prepare-close' || inFlight) return;
    inFlight = true;
    void guardsSettle(options?.guards ?? guards, timeoutMs)
      .catch(() => false)
      .then(ready => {
        inFlight = false;
        reply(ready);
      });
  });
  return () => {
    listening = false;
    off();
  };
}
