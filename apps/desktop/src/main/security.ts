import {
  app,
  BrowserWindow,
  session,
  shell,
  systemPreferences,
  type IpcMainInvokeEvent,
} from 'electron';
import { writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ADR 40-6 (plan 40 Q2 item 6): a packaged build refuses to start with a debugging switch. The fuses already
// stop `--inspect*`, `NODE_OPTIONS` and `ELECTRON_RUN_AS_NODE`, but no fuse covers Chromium's
// `--remote-debugging-*`, which would hand any local process the trusted renderer (and the preload bridge
// behind it). Only the E2E build variant (`APLOS_E2E=1`, which scripts/build-main.mjs refuses to combine with
// APLOS_RELEASE_BUILD=1) keeps the switches, for scripts/verify-release.mjs; `electron .` runs are unaffected.
declare const __APLOS_E2E__: boolean | undefined;
const e2eBuild = typeof __APLOS_E2E__ === 'boolean' && __APLOS_E2E__;
/** scripts/verify-hardening-launch.mjs DEBUG_GUARD_EXIT_CODE must match (EX_CONFIG in sysexits.h). */
const DEBUG_GUARD_EXIT_CODE = 78;
// Chromium also takes a single leading dash on macOS, so `-remote-debugging-port=0` counts too.
const DEBUG_ARGUMENT = /^--?(?:inspect|remote-debugging-|debug(?:-brk)?(?:=|$))/i;
const CHROMIUM_DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe'];
/** The first debugging switch in `argv` (name only, no value), or undefined. */
function debugSwitch(argv: readonly string[], hasSwitch: (name: string) => boolean = () => false) {
  const arg = argv.find(value => DEBUG_ARGUMENT.test(value));
  if (arg) return arg.split('=')[0];
  const name = CHROMIUM_DEBUG_SWITCHES.find(hasSwitch);
  return name && `--${name}`;
}
/**
 * Exits with DEBUG_GUARD_EXIT_CODE before the app is ready (so before Chromium opens a DevTools port and
 * before the single-instance hand-off). It runs when this module is first imported, which happens while
 * lifecycle.ts loads, ahead of everything lifecycle.ts does; keep it that way.
 */
function refuseDebugSwitches() {
  if (!app?.isPackaged || e2eBuild) return;
  const found = debugSwitch(process.argv.slice(1), name => app.commandLine.hasSwitch(name));
  if (!found) return;
  writeSync(2, `Aplos Mail: refusing to start with ${found}; debugging is off in this build.\n`);
  app.exit(DEBUG_GUARD_EXIT_CODE);
  process.exit(DEBUG_GUARD_EXIT_CODE);
}
refuseDebugSwitches();

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
function installPermissionHandlers() {
  session.defaultSession.setPermissionCheckHandler((contents, permission) =>
    Boolean(contents && trustedURL(contents.getURL()) && permission === 'media'),
  );
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const media = details as { mediaTypes?: string[] };
    if (
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
  });
}

export {
  DEBUG_GUARD_EXIT_CODE,
  debugSwitch,
  rendererFile,
  devURL,
  trustedURL,
  assertCaller,
  record,
  text,
  external,
  installPermissionHandlers,
};
