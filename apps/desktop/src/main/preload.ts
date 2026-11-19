import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge, Listener } from '@aplos/contract/legacy/types';
import { legacyMethods } from '@aplos/contract/allowlists';
import { exposeEngineBridge } from '../host/transports/port';
import { createEventHub } from '../shared/event-hub';
import { MAIL_KEY_CHANNEL, mailKeyEvent } from '../shared/mail-keys';

const allowed = new Set<string>(legacyMethods);
const hub = createEventHub();
ipcRenderer.on('aplos:event', (_event: Electron.IpcRendererEvent, event: Parameters<Listener>[0]) =>
  hub.emit(event),
);
// A key main relayed from the sealed mail frame: one narrow message, validated again here, anything else dropped.
// Never queued: a key nobody is listening for is stale.
ipcRenderer.on(MAIL_KEY_CHANNEL, (_event: Electron.IpcRendererEvent, message: unknown) => {
  const event = mailKeyEvent(message);
  if (event) hub.deliver(event);
});
const bridge: Bridge = {
  invoke: async <T>(method: string, payload?: unknown): Promise<T> => {
    if (!allowed.has(method)) throw new Error('Unsupported application method.');
    return ipcRenderer.invoke('aplos:invoke', method, payload) as Promise<T>;
  },
  subscribe: (listener: Listener, options?: { only?: readonly string[] }) =>
    hub.subscribe(listener, options),
};
contextBridge.exposeInMainWorld('aplos', bridge);

// ---- The real engine's direct port (the default engine, contract-4) ---------------------------------------------
// Only when main passed `ENGINE_PORT_ARG` (the real path): the default path exposes nothing and listens on nothing new.
// The bridge itself lives in host/transports/port.ts, where it runs under node:test with fakes.
exposeEngineBridge({ contextBridge, ipcRenderer }, process.argv);
