import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge, Listener } from './contract-types';
import { legacyMethods } from '@aplos/contract/allowlists';

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
