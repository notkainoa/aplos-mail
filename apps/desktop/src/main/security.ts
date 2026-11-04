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
import { writeSync } from 'node:fs';
import { url as inspectorURL } from 'node:inspector';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseBuild } from './oauth-config';
import { isMailDocumentUrl } from '../host/protocol/relay';

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
  'debug',
  'debug-brk',
];
// Node's legacy spellings (--debug, --debug-brk, --debug-port); not --debugger-ui or other look-alikes.
const NODE_DEBUG = new Set(['debug', 'debug-brk', 'debug-port']);
/** The first debugging switch in `argv` (argv[0] is the executable), or undefined. Only the name, never its value. */
function debugSwitch(argv: readonly string[]): string | undefined {
  for (const arg of argv.slice(1)) {
    const match = /^--?([^=]+)(?:=([\s\S]*))?$/.exec(arg);
    if (!match) continue;
    const name = match[1].toLowerCase();
    if (
      name.startsWith('remote-debugging-') ||
      name.startsWith('inspect') ||
      NODE_DEBUG.has(name) ||
      (name === 'js-flags' && /inspect/i.test(match[2] ?? ''))
    )
      return `--${name}`;
  }
  return undefined;
}
/**
 * A release build refuses to start with a debugging switch or an open inspector: with RunAsNode off, a
 * debugger is the remaining way to drive Aplos with its Keychain trust. Only the build-time release define
 * counts, never app.isPackaged: Electron derives that from the executable's name, so the same signed binary
 * linked as "electron" would skip the check. Dev runs, local `npm run package` builds and E2E runs (no
 * APLOS_RELEASE_BUILD define) keep debugging so Playwright can attach.
 *
 * Node's inspector starts before any JavaScript (--inspect prints its listener line first, --inspect-brk
 * pauses before this runs), so only the EnableNodeCliInspectArguments fuse (Q2.1) closes those fully; this
 * guard then still covers the Chromium switches (--remote-debugging-*), which open only after the main script.
 */
function refuseDebugging(): void {
  if (!releaseBuild) return;
  // A JavaScript listener replaces Node's SIGUSR1 handler, so `kill -USR1` cannot open the inspector on a
  // running release (the fuse above also turns that off; this covers a build without it).
  process.on('SIGUSR1', () => {});
  const parsed = DEBUG_SWITCHES.find(name => app.commandLine.hasSwitch(name));
  const found =
    debugSwitch(process.argv) ??
    (parsed && `--${parsed}`) ??
    (inspectorURL() ? 'an open inspector' : undefined);
  if (!found) return;
  // Written synchronously: process.stderr is asynchronous for a pipe on macOS, and the exit would drop it.
  try {
    writeSync(2, `Aplos Mail: a release build does not start with ${found}.\n`);
  } catch {
    // No usable stderr; exit anyway.
  }
  process.exit(DEBUG_GUARD_EXIT_CODE);
}
// Runs on import, so before lifecycle.ts's body (single-instance lock, whenReady, any window): lifecycle.ts
// imports this module ahead of every module that does work at load time. Chromium opens a
// --remote-debugging-port listener only after the main script has run, so exiting here keeps it closed.
refuseDebugging();

const rendererFile = resolve(__dirname, '../renderer/index.html');
const rendererURL = pathToFileURL(rendererFile);
// The Vite dev server; a release build never takes it, or one environment variable would make any origin
// the trusted renderer (navigation, the microphone, every IPC call).
const devURL = releaseBuild ? undefined : process.env.APLOS_RENDERER_URL;
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
// Today's rule: only the trusted window may use the microphone, never the camera. The asking frame must be
// that window's main frame too, so no subframe (a future mail frame) reaches the grant whatever its allow=.
function permissionCheck(
  contents: WebContents | null,
  permission: string,
  _origin: string,
  details: Partial<PermissionCheckHandlerHandlerDetails> = {},
): boolean {
  if (DENIED_PERMISSIONS.has(permission) || details.mediaType === 'video') return false;
  return Boolean(
    contents &&
    permission === 'media' &&
    details.isMainFrame !== false &&
    trustedURL(contents.getURL()) &&
    trustedURL(details.requestingUrl ?? contents.getURL()),
  );
}
function permissionRequest(
  contents: WebContents,
  permission: string,
  callback: (granted: boolean) => void,
  details: unknown,
): void {
  const media = details as { mediaTypes?: string[]; isMainFrame?: boolean; requestingUrl?: string };
  if (
    DENIED_PERMISSIONS.has(permission) ||
    !trustedURL(contents.getURL()) ||
    media.isMainFrame !== true ||
    !trustedURL(media.requestingUrl ?? '') ||
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

// Inert documents a subframe may hold (about:srcdoc for srcdoc frames).
const SUBFRAME_DOCUMENTS = new Set(['about:blank', 'about:srcdoc']);
function navigationAllowed(url: string, mainFrame: boolean): boolean {
  return trustedURL(url) || (!mainFrame && SUBFRAME_DOCUMENTS.has(url));
}
// The sealed mail frame's document (html-5, ARCH 10): only once the real engine path registered `aplos-mail:`, only in a
// subframe, only the exact issued form `aplos-mail://m/<32 lowercase hex>/` (slice 1's grammar, imported), and only
// when the app's own page started the navigation. A mail frame navigating itself (script or link) to another
// well-formed token is refused, and so is a redirect into one. Its `cid/<n>` and `img/<n>` are sub-resources, never
// documents; a main frame never shows `aplos-mail:`.
let mailFrames = false;
/** Called once by the real engine path after it installed the `aplos-mail://` relay (engine-real.ts). */
function allowMailFrames(): void {
  mailFrames = true;
}
/** The navigation's initiating frame URL; Electron gives null, or throws, once that frame has gone. */
function initiatorURL(event: { initiator?: { url: string } | null }): string | undefined {
  try {
    return event.initiator?.url;
  } catch {
    return undefined;
  }
}
function mailFrameAllowed(event: { url: string; initiator?: { url: string } | null }): boolean {
  const initiator = initiatorURL(event);
  return mailFrames && isMailDocumentUrl(event.url) && !!initiator && trustedURL(initiator);
}
/**
 * Lockdown for every webContents (windows, pop-outs, print views, future mail-frame views, webviews):
 * navigation only to the renderer, no new windows (web and mail links open in the browser), no <webview>.
 * windows.ts keeps its own per-window handlers; its will-navigate opens a blocked top-level link externally.
 */
function guardContents(contents: WebContents) {
  hardenSession(contents.session);
  contents.on('will-navigate', event => {
    if (!trustedURL(event.url)) event.preventDefault();
  });
  // Subframes only. Electron emits will-navigate for a main frame only when will-frame-navigate was not
  // prevented, so judging main frames here would hide the navigation from windows.ts's will-navigate (the
  // link would vanish instead of opening in the browser); will-navigate above blocks them instead.
  contents.on('will-frame-navigate', event => {
    if (event.isMainFrame || navigationAllowed(event.url, false) || mailFrameAllowed(event)) return;
    event.preventDefault();
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
  allowMailFrames,
  DEBUG_GUARD_EXIT_CODE,
  debugSwitch,
  refuseDebugging,
};
