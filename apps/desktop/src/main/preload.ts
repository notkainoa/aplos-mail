import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge, Listener } from '@aplos/contract/legacy/types';
import { legacyMethods } from '@aplos/contract/allowlists';
import {
  createPortClient,
  isDesktopMethod,
  portMethods,
  type PortCall,
} from '../host/transports/port';

const allowed = new Set<string>(legacyMethods);
const listeners = new Set<Listener>();
const queued: Parameters<Listener>[0][] = [];
ipcRenderer.on(
  'aplos:event',
  (_event: Electron.IpcRendererEvent, event: Parameters<Listener>[0]) => {
    if (
      !listeners.size &&
      (event.type === 'deep-link' || event.type === 'command' || event.type === 'prepare-close')
    ) {
      queued.push(event);
      if (queued.length > 50) queued.shift();
    }
    for (const listener of listeners) listener(event);
  },
);
const bridge: Bridge = {
  invoke: async <T>(method: string, payload?: unknown): Promise<T> => {
    if (!allowed.has(method)) throw new Error('Unsupported application method.');
    return ipcRenderer.invoke('aplos:invoke', method, payload) as Promise<T>;
  },
  subscribe: (listener: Listener) => {
    listeners.add(listener);
    for (const event of queued.splice(0)) listener(event);
    return () => {
      listeners.delete(listener);
    };
  },
};
contextBridge.exposeInMainWorld('aplos', bridge);

// ---- The real engine's direct port (APLOS_ENGINE=real, contract-4) ----------------------------------------------
// The page never sees a MessagePort or an Electron object: only `call`, `subscribe` and `position`. Engine methods go
// down this window's own port after the generated allowlist check; desktop methods go to main. Main hands the port only
// to this window's trusted main frame, so a mail frame, a subframe or another origin never gets one.

let asked: Promise<unknown> | undefined;
// A port that closes under the page (revoked, engine stopped) fails its open calls; the next call asks main again.
const engine = createPortClient(portMethods, { onLost: () => (asked = undefined) });
/** Asks main for this window's port once; a refusal (no real engine, an untrusted frame) fails the waiting calls. */
function connect() {
  asked ??= ipcRenderer.invoke('aplos:engine-connect').catch(() => {
    asked = undefined;
    engine.fail({ type: 'unavailable', message: 'The new mailbox engine is not running.' });
  });
}
ipcRenderer.on('aplos:engine-port', (event: Electron.IpcRendererEvent) => {
  const [port] = event.ports;
  if (!port) return;
  engine.attach({
    post: (message: PortCall, transfer: ArrayBuffer[]) => port.postMessage(message, transfer),
    onMessage: handler => {
      port.onmessage = message => handler(message.data);
    },
    onClose: handler => port.addEventListener('close', handler),
    close: () => port.close(),
  });
});
ipcRenderer.on('aplos:desktop', (_event: Electron.IpcRendererEvent, frame: unknown) =>
  engine.desktop(frame),
);
contextBridge.exposeInMainWorld('aplosEngine', {
  call: (method: unknown, args?: unknown, transfer?: unknown): Promise<unknown> => {
    if (typeof method === 'string' && isDesktopMethod(method))
      return ipcRenderer.invoke('aplos:desktop', method, args);
    // A refused name never even asks for a port.
    if (typeof method === 'string' && portMethods.has(method)) connect();
    return engine.call(method, args, transfer);
  },
  subscribe: (listener: Parameters<typeof engine.subscribe>[0]) => {
    connect();
    return engine.subscribe(frame => listener(frame));
  },
  position: () => engine.position(),
});
