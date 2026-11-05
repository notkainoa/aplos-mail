// The window's event fan-out behind `window.aplos.subscribe` (preload). No Electron import, so node:test runs it.
//
// Three event types are held until someone is listening, because main may send them before the app has subscribed: a
// deep link, a command and a prepare-close. The first listener that accepts such an event takes it; a later listener never
// sees it. A listener that names the types it wants (`only`) neither receives nor consumes any other type, so a helper that
// listens for one narrow thing (the sealed letter's mail keys) cannot swallow the app's queued events by subscribing first.

export type HubEvent = { type: string; payload?: unknown };
export type HubListener = (event: HubEvent) => void;
export interface HubSubscribeOptions {
  /** Only these event types are delivered, and only these can be taken from the queue. Absent: every type. */
  only?: readonly string[];
}

interface Entry {
  listener: HubListener;
  only?: ReadonlySet<string>;
}

export interface EventHub {
  /** A frame from main: delivered to every listener that accepts its type, or queued when it is one that waits. */
  emit(event: HubEvent): void;
  /** A frame that is never held (a mail key): delivered to the listeners that accept it now, or dropped. */
  deliver(event: HubEvent): void;
  subscribe(listener: HubListener, options?: HubSubscribeOptions): () => void;
}

const WAITS: ReadonlySet<string> = new Set(['deep-link', 'command', 'prepare-close']);
const MAX_QUEUED = 50;

const accepts = (entry: Entry, type: string) => !entry.only || entry.only.has(type);

export function createEventHub(): EventHub {
  const entries = new Set<Entry>();
  const queued: HubEvent[] = [];
  return {
    emit(event) {
      const heard = [...entries].filter(entry => accepts(entry, event.type));
      if (!heard.length && WAITS.has(event.type)) {
        queued.push(event);
        if (queued.length > MAX_QUEUED) queued.shift();
        return;
      }
      for (const entry of heard) entry.listener(event);
    },
    deliver(event) {
      for (const entry of [...entries]) if (accepts(entry, event.type)) entry.listener(event);
    },
    subscribe(listener, options) {
      const entry: Entry = { listener, ...(options?.only ? { only: new Set(options.only) } : {}) };
      entries.add(entry);
      for (let i = 0; i < queued.length;) {
        const event = queued[i]!;
        if (!accepts(entry, event.type)) i += 1;
        else {
          queued.splice(i, 1);
          listener(event);
        }
      }
      return () => {
        entries.delete(entry);
      };
    },
  };
}
