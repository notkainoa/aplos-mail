import {
  BrowserWindow,
  session,
  shell,
  systemPreferences,
  type IpcMainInvokeEvent,
} from 'electron';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  rendererFile,
  devURL,
  trustedURL,
  assertCaller,
  record,
  text,
  external,
  installPermissionHandlers,
};
