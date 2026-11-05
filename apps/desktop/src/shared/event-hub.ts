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

type Only = ReadonlySet<string> | undefined;
const accepts = (only: Only, type: string) => !only || only.has(type);

export function createEventHub(): EventHub {
  const entries = new Map<HubListener, Only>();
  const queued: HubEvent[] = [];
  const reach = (event: HubEvent) => {
    for (const [listener, only] of [...entries]) if (accepts(only, event.type)) listener(event);
  };
  const hasGeneral = () => [...entries.values()].some(only => !only);
  return {
    emit(event) {
      // Mail keys come only through `deliver` (main's key relay, validated): a `mail-key` on the general event channel
      // is not one, so it is dropped here rather than forged into the key hook.
      if (event.type === MAIL_KEY_EVENT) return;
      if (WAITS.has(event.type) && !hasGeneral()) {
        queued.push(event);
        if (queued.length > MAX_QUEUED) queued.shift();
      }
      reach(event);
    },
    deliver: reach,
    subscribe(listener, options) {
      const only: Only = options?.only ? new Set(options.only) : undefined;
      entries.set(listener, only);
      // The whole queue is taken before anything is delivered, so a listener that subscribes from inside its replay
      // cannot take events from the one being served.
      const mine = only ? [] : queued.splice(0);
      try {
        for (const event of mine) listener(event);
      } catch (error) {
        entries.delete(listener);
        throw error;
      }
      return () => {
        entries.delete(listener);
      };
    },
  };
}
