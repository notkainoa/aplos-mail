// `window.aplos`: main's native methods over `aplos:invoke`, and its events (prepare-close, menus, main-navigate,
// updates, fullscreen, sealed-frame mail keys). Mail itself goes over `window.aplosEngine` (host/transports/port.ts).

export type Listener = (event: { type: string; payload?: unknown }) => void;
export interface Bridge {
  invoke<T = unknown>(method: string, payload?: unknown): Promise<T>;
  /** `options.only` names the event types this listener wants; it hears only those, live, and never takes the events held for the app's first plain subscribe. */
  subscribe(listener: Listener, options?: { only?: readonly string[] }): () => void;
}
declare global {
  interface Window {
    aplos?: Bridge;
  }
}

/** The handler names main answers on `aplos:invoke` (main/native-methods.ts); preload lets a window call only these. */
export const nativeMethodNames = [
  'app.info',
  'file.open',
  'file.save',
  'notification.test',
  'shell.open',
  'system.defaultMail',
  'system.login',
  'system.microphone',
  'update.check',
  'update.later',
  'update.restart',
  'update.status',
  'window.claim',
  'window.closeCancel',
  'window.closeReady',
  'window.release',
] as const;
