// The `#mailkey` page of the browser spec: one MailFrameView on the stand-in sealed frame, with a fake preload bridge
// on `window.aplos` (its `subscribe` is the port `useSealedMailKeys` reads) and handles on `window.__mailkey` for the
// spec: deliver a `mail-key` event as preload would, open a composer layer or a dialog above the reader, make the
// letter inert (off paper), add a pending letter, remount, and read which keydown listeners the mount installed.
import { flushSync } from 'react-dom';
import type { Root } from 'react-dom/client';
import type { ContextName } from '../../commands';
import { addKeyLayer } from '../../shell/store-keys';
import { MailFrameView } from '../MailFrameView';
import type { BridgeEvent } from '../sealedKeys';
import type { FrameSource, MailFrameKey, MailFrameReady } from '../types';

/** What the spec drives. */
export interface MailKeyHarness {
  /** Hands every subscriber `{ type, payload }`, as preload does. */
  deliver(payload: unknown, type?: string): void;
  /** Subscribers now. */
  listeners(): number;
  /** Calls made to `window.aplos.subscribe` since the page loaded (a mounted srcdoc slot must add none). */
  subscribes(): number;
  /** Every keydown, keyup or keypress listener added after the root was created, as `<target>:<type>`. */
  keyListeners: string[];
  /** Adds a key layer (`compose`, `dialog`, ...); `clearLayers` removes them all. */
  layer(contexts: ContextName[]): void;
  clearLayers(): void;
  /** Opens or closes a `role="dialog"` overlay in the host document. */
  dialog(open: boolean): void;
  /** Makes the letter's wrapper inert, as the reader does to its off-paper letter. */
  inert(on: boolean): void;
  /** Asks for a second letter, which stays pending (hidden) because it never reports. */
  pend(): void;
  /** Asks for a srcdoc letter (the stand-in path) in place of the sealed one. */
  srcdoc(): void;
  /** Unmounts and mounts the view `times` times. */
  remount(times: number): void;
  unmount(): void;
}

/** The stand-in sealed frame's tokens (the spec repeats the first). */
const SHOWN_TOKEN = '5ea1ed005ea1ed005ea1ed005ea1ed00';
const PENDING_TOKEN = 'be1a7ed0be1a7ed0be1a7ed0be1a7ed0';

function sealed(token: string, key: string): FrameSource {
  return { kind: 'url', key, url: `${location.origin}/sealed/${token}`, token, blocked: 0 };
}

interface Sink {
  ready: MailFrameReady[];
  keys: MailFrameKey[];
}

interface FakeBridge {
  listeners: Set<(event: BridgeEvent) => void>;
  calls: { count: number };
}

function fakeBridge(): FakeBridge {
  const listeners = new Set<(event: BridgeEvent) => void>();
  const calls = { count: 0 };
  const subscribe = (listener: (event: BridgeEvent) => void) => {
    calls.count += 1;
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  (window as unknown as { aplos: unknown }).aplos = { invoke: () => Promise.resolve(), subscribe };
  return { listeners, calls };
}

/** Records key listeners added from now on (the root's own delegation listeners are already in place). */
function watchKeyListeners(into: string[]): void {
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type, ...rest) {
    if (/^key/.test(type))
      into.push(`${this === window ? 'window' : (this as Node).nodeName}:${type}`);
    return add.call(this, type, ...rest);
  };
}

/** Mounts the page on `root` and returns the spec's handles. */
export function mountMailKeyHarness(root: Root, sink: Sink): MailKeyHarness {
  const { listeners, calls } = fakeBridge();
  const keyListeners: string[] = [];
  watchKeyListeners(keyListeners);
  const layers: (() => void)[] = [];
  const state = { inert: false, source: sealed(SHOWN_TOKEN, 'sealed') };
  const view = () => (
    <div inert={state.inert}>
      <MailFrameView
        source={state.source}
        timeoutMs={60_000}
        onReady={ready => sink.ready.push(ready)}
        onKey={key => {
          sink.keys.push(key);
          return true;
        }}
      />
    </div>
  );
  const render = () => flushSync(() => root.render(view()));
  let overlay: HTMLElement | null = null;
  render();
  return {
    deliver: (payload, type = 'mail-key') => listeners.forEach(l => l({ type, payload })),
    listeners: () => listeners.size,
    subscribes: () => calls.count,
    keyListeners,
    layer: contexts => void layers.push(addKeyLayer({ contexts })),
    clearLayers: () => layers.splice(0).forEach(remove => remove()),
    dialog: open => {
      overlay?.remove();
      overlay = null;
      if (!open) return;
      overlay = document.createElement('section');
      overlay.setAttribute('role', 'dialog');
      document.body.append(overlay);
    },
    inert: on => {
      state.inert = on;
      render();
    },
    pend: () => {
      state.source = sealed(PENDING_TOKEN, 'pending');
      render();
    },
    srcdoc: () => {
      state.source = {
        kind: 'srcdoc',
        key: 'srcdoc',
        html: '<p>Stand-in letter</p>',
        imagePolicy: 'block',
      };
      render();
    },
    remount: times => {
      for (let i = 0; i < times; i++) {
        flushSync(() => root.render(null));
        render();
      }
    },
    unmount: () => flushSync(() => root.render(null)),
  };
}
