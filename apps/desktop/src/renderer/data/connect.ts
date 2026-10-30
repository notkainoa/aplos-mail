/**
 * Connects the data layer to a transport and installs it behind `./index.ts`, so every hook and `api` method works.
 * `renderer/main.tsx` (and `bridge.ts` once it chooses MessagePort or HTTP) calls this once per window.
 */
import { createHooks } from './hooks';
import { installDataRuntime } from './index';
import { createDataLayer, type DataLayer, type DataLayerOptions } from './layer';

/** One connected data layer. */
export interface DataConnection {
  readonly layer: DataLayer;
  /** Uninstall and close the transport. */
  close(): void;
}

export function connectDataLayer(options: DataLayerOptions): DataConnection {
  const layer = createDataLayer(options);
  installDataRuntime(createHooks(layer));
  return {
    layer,
    close() {
      installDataRuntime(null);
      layer.close();
    },
  };
}
