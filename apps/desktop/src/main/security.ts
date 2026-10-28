import {
  app,
  BrowserWindow,
  session,
  shell,
  systemPreferences,
  type IpcMainInvokeEvent,
  type PermissionCheckHandlerHandlerDetails,
  type Session,
  type WebContents,
} from 'electron';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseBuild } from './oauth-config';

/**
 * Exit code of a release build started with a debugging switch (ADR 40-6); EX_CONFIG in sysexits.h.
 * scripts/verify-hardening.mjs (DEBUG_GUARD_EXIT_CODE) accepts only this code as proof; change both together.
 */
const DEBUG_GUARD_EXIT_CODE = 78;
// Switches Chromium parses itself (it also accepts a single leading dash), checked as a second source.
const DEBUG_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'inspect',
  'inspect-brk',
  'inspect-port',
  'inspect-wait',
  'debug-port',
];
/** The first debugging switch in `argv` (argv[0] is the executable), or undefined. */
function debugSwitch(argv: readonly string[]): string | undefined {
  for (const arg of argv.slice(1)) {
    const match = /^--?([^=]+)(?:=([\s\S]*))?$/.exec(arg);
    if (!match) continue;
    const name = match[1].toLowerCase();
    if (
      name.startsWith('remote-debugging-') ||
      name.startsWith('inspect') ||
      name === 'debug-port' ||
      (name === 'js-flags' && /inspect/i.test(match[2] ?? ''))
    )
      return `--${name}`;
  }
  return undefined;
}
/**
 * A packaged release build refuses to start with a debugging switch: with RunAsNode off, a debugger is
 * the remaining way to drive Aplos with its Keychain trust. Dev runs, local `npm run package` builds and
 * E2E runs (no APLOS_RELEASE_BUILD define) keep debugging so Playwright can attach.
 */
function refuseDebugging(): void {
  if (!releaseBuild || !app.isPackaged) return;
  const found =
    debugSwitch(process.argv) ?? DEBUG_SWITCHES.find(name => app.commandLine.hasSwitch(name));
  if (!found) return;
  process.stderr.write(`Aplos Mail: a release build does not start with ${found}.\n`);
  process.exit(DEBUG_GUARD_EXIT_CODE);
}
// Runs on import, so before lifecycle.ts's body (single-instance lock, whenReady, any window): lifecycle.ts
// imports this module ahead of every module that does work at load time. Chromium opens a
// --remote-debugging-port listener only after the main script has run, so exiting here keeps it closed.
refuseDebugging();

const rendererFile = resolve(__dirname, '../renderer/index.html');
const rendererURL = pathToFileURL(rendererFile);
const devURL = process.env.APLOS_RENDERER_URL;
function trustedURL(raw: string): boolean {
  try {
    const url = new URL(raw);
    return devURL
      ? url.origin === new URL(devURL).origin
      : url.protocol === 'file:' && url.pathname === rendererURL.pathname;
  } catch {
    return false;
  }
}
function assertCaller(event: IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  if (
    !frame ||
    frame !== event.sender.mainFrame ||
    !trustedURL(frame.url) ||
    !BrowserWindow.fromWebContents(event.sender)
  )
    throw new Error('Untrusted application window.');
}
function record(input: unknown): Record<string, unknown> {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid request.');
  return input as Record<string, unknown>;
}
function text(input: unknown, label: string, max = 10000): string {
  if (typeof input !== 'string' || input.length > max) throw new Error(`Invalid ${label}.`);
  return input;
}
async function external(raw: unknown) {
  const value = text(raw, 'link', 10000);
  const url = new URL(value);
  if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only web and email links can be opened.');
  await shell.openExternal(url.href);
}

// Denied whoever asks. Only 'media' (the trusted window's microphone) is ever allowed; this list keeps the
// sensitive ones refused even if that rule is widened later. 'bluetooth' is not an Electron permission
// name today; Web Bluetooth goes through select-bluetooth-device below.
const DENIED_PERMISSIONS: ReadonlySet<string> = new Set([
  'display-capture',
  'geolocation',
  'geolocation-approximate',
  'notifications',
  'clipboard-read',
  'hid',
  'serial',
  'usb',
  'bluetooth',
  'openExternal',
]);
// Today's rule, unchanged: only the trusted window may use the microphone, never the camera. Subframes
// (a future mail frame) are also held back by Chromium's permissions policy: microphone defaults to 'self'.
function permissionCheck(
  contents: WebContents | null,
  permission: string,
  _origin: string,
  details: Partial<PermissionCheckHandlerHandlerDetails> = {},
): boolean {
  if (DENIED_PERMISSIONS.has(permission) || details.mediaType === 'video') return false;
  return Boolean(contents && trustedURL(contents.getURL()) && permission === 'media');
}
function permissionRequest(
  contents: WebContents,
  permission: string,
  callback: (granted: boolean) => void,
  details: unknown,
): void {
  const media = details as { mediaTypes?: string[] };
  if (
    DENIED_PERMISSIONS.has(permission) ||
    !trustedURL(contents.getURL()) ||
    permission !== 'media' ||
    media.mediaTypes?.includes('video')
  ) {
    callback(false);
    return;
  }
  if (process.platform === 'darwin')
    void systemPreferences
      .askForMediaAccess('microphone')
      .then(callback)
      .catch(() => callback(false));
  else callback(true);
}
const hardenedSessions = new WeakSet<Session>();
/** Permission and device handlers for one session (the default one, or a partition a future view uses). */
function hardenSession(ses: Session) {
  if (hardenedSessions.has(ses)) return;
  hardenedSessions.add(ses);
  ses.setPermissionCheckHandler(permissionCheck);
  ses.setPermissionRequestHandler(permissionRequest);
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback(null));
  // Every device chooser is cancelled, so no page can be handed a HID, serial or USB device.
  ses.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault();
    callback(null);
  });
  ses.on('select-serial-port', (event, _ports, _contents, callback) => {
    event.preventDefault();
    callback('');
  });
  ses.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
}

// Inert documents a subframe may hold (about:srcdoc for srcdoc frames). A future mail frame scheme
// (aplos-mail:, ARCHITECTURE 12.1) is added here when it is registered.
const SUBFRAME_DOCUMENTS = new Set(['about:blank', 'about:srcdoc']);
function navigationAllowed(url: string, mainFrame: boolean): boolean {
  return trustedURL(url) || (!mainFrame && SUBFRAME_DOCUMENTS.has(url));
}
/**
 * Lockdown for every webContents (windows, pop-outs, print views, future mail-frame views, webviews):
 * navigation only to the renderer, no new windows (web and mail links open in the browser), no <webview>.
 * windows.ts keeps its own per-window handlers; those open a blocked top-level link externally.
 */
function guardContents(contents: WebContents) {
  hardenSession(contents.session);
  contents.on('will-navigate', event => {
    if (!trustedURL(event.url)) event.preventDefault();
  });
  contents.on('will-frame-navigate', event => {
    if (!navigationAllowed(event.url, event.isMainFrame)) event.preventDefault();
  });
  contents.on('will-redirect', event => {
    if (!navigationAllowed(event.url, event.isMainFrame)) event.preventDefault();
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  // Without this listener Electron hands Web Bluetooth the first device it finds.
  contents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault();
    callback('');
  });
  contents.setWindowOpenHandler(({ url }) => {
    void external(url).catch(() => {});
    return { action: 'deny' };
  });
}
let guarded = false;
/**
 * Called once from lifecycle.ts at ready, before the first window: the default session's handlers now,
 * then every later session and webContents as Electron creates it.
 */
function installPermissionHandlers() {
  if (guarded) return;
  guarded = true;
  hardenSession(session.defaultSession);
  app.on('session-created', hardenSession);
  app.on('web-contents-created', (_event, contents) => guardContents(contents));
}

export {
  rendererFile,
  devURL,
  trustedURL,
  assertCaller,
  record,
  text,
  external,
  installPermissionHandlers,
  DEBUG_GUARD_EXIT_CODE,
  debugSwitch,
  refuseDebugging,
};
