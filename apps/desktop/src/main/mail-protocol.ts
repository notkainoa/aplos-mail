import {
  BrowserWindow,
  protocol,
  session as electronSession,
  webContents,
  type OnBeforeRequestListenerDetails,
  type Session,
} from 'electron';
import {
  MAIL_PRIVILEGES,
  MAIL_SCHEME,
  backstopCancels,
  createMailHandler,
  stampWindow,
  type ServeArgs,
} from '../host/protocol/relay';

/**
 * The `aplos-mail://` protocol in main (lane eng-html, html-5; ARCH 10), on the real engine path only. The decisions
 * live in `host/protocol/relay.ts`; this file only hands them to Electron.
 *
 * Where it runs: `engine-host.ts` calls `registerMailScheme()` at import (before app ready, as Electron requires) and
 * only when `realPath` is true; `engine-real.ts` calls `installMailProtocol()` from `bootRealEngine`. The legacy path
 * never imports a caller of either, so on it the scheme is unknown to Chromium and no `webRequest` listener exists.
 *
 * One listener per event. Electron keeps a single `onBeforeSendHeaders` and a single `onBeforeRequest` listener per
 * session and a second call silently replaces the first, so this module is the only place in `src/` that may call
 * `webRequest.*` (a test greps for any other), and installing twice is a no-op.
 */

/** Registers the scheme as `{standard: true, secure: true}` only. Must run before app ready; the real path only. */
export function registerMailScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MAIL_SCHEME, privileges: { ...MAIL_PRIVILEGES } },
  ]);
}

/** The requesting frame's URL; Electron may throw or give null once the frame has gone. */
function frameUrlOf(details: OnBeforeRequestListenerDetails): string | undefined {
  try {
    return details.frame?.url;
  } catch {
    return undefined;
  }
}

const guardedSessions = new WeakSet<Session>();

/**
 * The session's one `onBeforeSendHeaders` (the window stamp) and one `onBeforeRequest` (the backstop). Returns false
 * when this session already has them: a second install never replaces the first.
 */
export function installWebRequestGuards(ses: Session): boolean {
  if (guardedSessions.has(ses)) return false;
  guardedSessions.add(ses);
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: stampWindow(details) });
  });
  ses.webRequest.onBeforeRequest((details, callback) => {
    const facts = {
      url: details.url,
      initiatorOrigin: details.initiatorOrigin,
      frameUrl: frameUrlOf(details),
    };
    callback({ cancel: backstopCancels(facts) });
  });
  return true;
}

/**
 * The Electron window id of a window's OWN webContents; undefined for anything else (DevTools, a gone window, and a
 * WebContentsView hosted in a window, which Electron reports as type `window` and maps to its host window).
 */
function windowOf(contentsId: number): number | undefined {
  const contents = webContents.fromId(contentsId);
  if (!contents || contents.isDestroyed() || contents.getType() !== 'window') return undefined;
  const win = BrowserWindow.fromWebContents(contents);
  return win && win.webContents === contents ? win.id : undefined;
}

let installed = false;

/**
 * The real path's relay on the default session (every app window uses it): the window stamp, the backstop, and the
 * handler that asks the engine. `serve` is `Mail/serve` over main's control connection. Idempotent.
 */
export function installMailProtocol(serve: (args: ServeArgs) => Promise<unknown>): void {
  if (installed) return;
  installed = true;
  const ses = electronSession.defaultSession;
  installWebRequestGuards(ses);
  ses.protocol.handle(MAIL_SCHEME, createMailHandler({ serve, windowOf }));
}
