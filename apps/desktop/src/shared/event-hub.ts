import { MAIL_KEY_EVENT } from './mail-keys';

// The window's event fan-out behind `window.aplos.subscribe` (preload). No Electron import, so node:test runs it.
//
// Three event types are held until the app is listening, because main may send them before the app has subscribed: a
// deep link, a command and a prepare-close. The first general listener (one that did not name its types) takes the
// whole queue. A listener that names its types (`only`) hears those types live and never touches the queue, so a helper
// that listens for one narrow thing (the sealed letter's mail keys) cannot swallow the app's queued events by
// subscribing first, whatever it names.

export type HubEvent = { type: string; payload?: unknown };
export type HubListener = (event: HubEvent) => void;
export interface HubSubscribeOptions {
  /** Only these event types are delivered to this listener, and it never drains the queue. Absent: every type. */
  only?: readonly string[];
}

export interface EventHub {
  /** A frame from main: delivered to every listener that accepts its type, and held when no general listener exists. */
  emit(event: HubEvent): void;
  /** A frame that is never held (a mail key): delivered to the listeners that accept it now, or dropped. */
  deliver(event: HubEvent): void;
  /** The same function subscribed twice is one registration, as in the plain Set this replaced. */
  subscribe(listener: HubListener, options?: HubSubscribeOptions): () => void;
}

const WAITS: ReadonlySet<string> = new Set(['deep-link', 'command', 'prepare-close']);
const MAX_QUEUED = 50;
/**
 * Held until a listener NAMES the type (`only`), then given to the first such listener: a screen change main asks for
 * (`navigate`) or the window's fullscreen state (`fullscreen`) may arrive before the app has mounted the one place
 * that can act on it. Plain listeners hear it live and never take it, so the app's own first plain subscribe cannot
 * swallow it without opening a route. It is single-consumer (the first listener that names it takes the held copy)
 * and trusted to come from main only: nothing renderer-side can emit.
 */
const NAMED_WAITS: ReadonlySet<string> = new Set(['navigate', 'fullscreen']);
const MAX_NAMED = 10;

type Only = ReadonlySet<string> | undefined;
const accepts = (only: Only, type: string) => !only || only.has(type);

export function createEventHub(): EventHub {
  const entries = new Map<HubListener, Only>();
  const unsubscribers = new Map<HubListener, () => void>();
  const queued: HubEvent[] = [];
  const named: HubEvent[] = [];
  const reach = (event: HubEvent) => {
    for (const [listener, only] of [...entries])
      // Still registered: a listener removed by an earlier one in this same pass is skipped, as in a live Set.
      if (entries.has(listener) && accepts(only, event.type)) listener(event);
  };
  const takeNamed = (only: ReadonlySet<string>) => {
    const taken = named.filter(event => only.has(event.type));
    for (const event of taken) named.splice(named.indexOf(event), 1);
    return taken;
  };
  const hasGeneral = () => [...entries.values()].some(only => !only);
  return {
    emit(event) {
      // Mail keys come only through `deliver` (main's key relay, validated): a `mail-key` on the general event channel
      // is not one, so it is dropped here rather than forged into the key hook.
      if (event.type === MAIL_KEY_EVENT) return;
      if (WAITS.has(event.type) && !hasGeneral()) {
        // A copy: a typed listener that hears this event live cannot change the one held for the app.
        queued.push({ ...event });
        if (queued.length > MAX_QUEUED) queued.shift();
      }
      if (
        NAMED_WAITS.has(event.type) &&
        ![...entries.values()].some(only => only?.has(event.type))
      ) {
        named.push({ ...event });
        if (named.length > MAX_NAMED) named.shift();
      }
      reach(event);
    },
    deliver: reach,
    subscribe(listener, options) {
      const known = unsubscribers.get(listener);
      if (known) return known;
      const only: Only = options?.only ? new Set(options.only) : undefined;
      entries.set(listener, only);
      const off = () => {
        entries.delete(listener);
        unsubscribers.delete(listener);
      };
      unsubscribers.set(listener, off);
      // The whole queue is taken before anything is delivered, so a listener that subscribes from inside its replay
      // cannot take events from the one being served.
      const mine = only ? takeNamed(only) : queued.splice(0);
      for (const [i, event] of mine.entries()) {
        try {
          listener(event);
        } catch (error) {
          // This listener is unregistered and the events it did not get wait for the next one.
          off();
          const rest = mine.slice(i + 1);
          queued.unshift(...rest.filter(e => !NAMED_WAITS.has(e.type)));
          named.unshift(...rest.filter(e => NAMED_WAITS.has(e.type)));
          throw error;
        }
      }
      return off;
    },
  };
}
