import {
  app,
  BrowserWindow,
  dialog,
  Notification,
  shell,
  systemPreferences,
  type IpcMainInvokeEvent,
} from 'electron';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { record, text, external } from './security';
import {
  claims,
  pendingClose,
  permittedClose,
  main,
  emit,
  focusMain,
  onboarding,
  sendWhenReady,
} from './windows';
import { updates, restartToUpdate, cancelInstall } from './updater';
import { latestState } from './engine-host';
import { cancelQuit } from './lifecycle';
import { legacyDesktopMethods, type desktopMethods } from '@aplos/contract/allowlists';
import { isTest, recordNotification } from './test-mode';
import { finishOptionsOf, settingsPaneUrl } from '../host/lifecycle';
import { fileNameOf } from '../shared/desktop-v1';
import { openAttachment, saveAttachment, sweepTemp, type FileIo } from '../shared/attachment-files';
import { markQuarantined } from '../shared/quarantine';

const nativeMethods = new Set<string>(legacyDesktopMethods);
// Contract v1 desktop methods main already answers. A window reaches them once preload moves to the generated v1 table.
const v1Served: (typeof desktopMethods)[number][] = [
  'Window/openOnboarding',
  'Window/finishOnboarding',
  'System/openSettings',
  'System/login',
  'System/notifications',
];
for (const name of v1Served) nativeMethods.add(name);
const ok = { ok: true } as const;
function notify(title: string, body: string, threadId?: string) {
  if (isTest) return recordNotification(title, body, threadId);
  if (!Notification.isSupported())
    throw new Error('Desktop notifications are unavailable on this system.');
  const notification = new Notification({ title, body, silent: !latestState?.settings.sendSound });
  notification.on('click', () => {
    // The thread command goes to the window the activation answers with, once its page can take it;
    // an onboarding answer (first run) makes no mail window, and the command is dropped with it.
    void focusMain().then(win => {
      if (threadId && win) sendWhenReady(win, { type: 'command', payload: `thread:${threadId}` });
    });
  });
  notification.show();
}
/** The real disk and OS behind `shared/attachment-files.ts`. */
const fileIo: FileIo = {
  chooseSavePath: async defaultName => {
    const win = BrowserWindow.getFocusedWindow() ?? main;
    const options = { defaultPath: defaultName };
    return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options);
  },
  writeFile: (path, data, options) => writeFile(path, data, options),
  makeTempDir: prefix => mkdtemp(join(tmpdir(), prefix)),
  join,
  openPath: path => shell.openPath(path),
  removeDir: path => rm(path, { recursive: true, force: true }),
  quarantine: path => markQuarantined(path),
  get testMode() {
    return isTest;
  },
};

/** The save dialog, then the bytes to the chosen path. Shared by the legacy `file.save` and v1 `File/save`. */
function saveBytes(win: BrowserWindow, name: string, data: Uint8Array) {
  return saveAttachment(
    { ...fileIo, chooseSavePath: d => dialog.showSaveDialog(win, { defaultPath: d }) },
    name,
    data,
  );
}

/** Writes the bytes to a private temp file, quarantines it, and opens it in its app; only safe types whose bytes match. */
function openBytes(name: string, data: Uint8Array) {
  return openAttachment(fileIo, name, data);
}

/** Start-up: removes the temp folders opened attachments left in earlier sessions. */
function sweepAttachmentTemp() {
  // Test instances run beside the real app and share its temp folder: they never sweep.
  if (isTest) return Promise.resolve(0);
  return sweepTemp({
    tempEntries: () => readdir(tmpdir()),
    removeTemp: entry => rm(join(tmpdir(), entry), { recursive: true, force: true }),
  });
}

async function invokeNative(event: IpcMainInvokeEvent, method: string, input: unknown) {
  const payload = record(input),
    win = BrowserWindow.fromWebContents(event.sender)!;
  // Also accepts the save acknowledgement from a renderer-initiated close held at beforeunload.
  if (method === 'window.closeReady') {
    pendingClose.delete(win.id);
    permittedClose.add(win.id);
    win.setEnabled(true);
    setImmediate(() => {
      if (!win.isDestroyed()) win.close();
    });
    return true;
  }
  if (method === 'window.closeCancel') {
    pendingClose.delete(win.id);
    win.setEnabled(true);
    cancelQuit();
    cancelInstall();
    return true;
  }
  if (method === 'Window/openOnboarding') {
    if (payload.mode !== 'first' && payload.mode !== 'review')
      throw new Error('Choose an onboarding mode.');
    onboarding.open(payload.mode);
    return ok;
  }
  if (method === 'Window/finishOnboarding') {
    // Only the one named destination counts, whichever door the payload came through; anything else is Home.
    await onboarding.finish(finishOptionsOf(payload));
    return ok;
  }
  if (method === 'System/login') {
    // v1: `enabled` absent reads the setting; present sets it. Test mode touches nothing system-wide.
    if (payload.enabled !== undefined && typeof payload.enabled !== 'boolean')
      throw new Error('Choose whether to launch at login.');
    if (isTest) return { enabled: payload.enabled === true };
    if (payload.enabled !== undefined) app.setLoginItemSettings({ openAtLogin: payload.enabled });
    return { enabled: app.getLoginItemSettings().openAtLogin };
  }
  if (method === 'System/notifications') {
    // Electron's main process cannot read the macOS notification permission, so the honest answer is "unknown".
    return { status: 'unknown' as const };
  }
  if (method === 'System/openSettings') {
    const url = settingsPaneUrl(payload.pane);
    // Test mode opens no other app (it would take focus).
    if (!isTest) await shell.openExternal(url);
    return ok;
  }
  if (method === 'app.info')
    return { name: 'Aplos Mail', version: app.getVersion(), desktop: true };
  if (method === 'update.status') return updates!.info();
  if (method === 'update.check') return updates!.check(true);
  if (method === 'update.later') {
    updates!.later();
    return updates!.info();
  }
  if (method === 'update.restart') {
    restartToUpdate();
    return true;
  }
  if (method === 'shell.open') {
    // Test mode never opens a browser (it would take focus); the request is accepted and dropped.
    if (isTest) return true;
    await external(payload.url);
    return true;
  }
  if (method === 'window.claim') {
    const id = text(payload.draftId, 'draft ID', 200);
    return claims.claim(id, win.id);
  }
  if (method === 'window.release') {
    const id = text(payload.draftId, 'draft ID', 200);
    if (claims.release(id, win.id)) emit({ type: 'draft-owner', payload: { draftId: id } });
    return true;
  }
  if (method === 'file.save' || method === 'file.open') {
    const name = fileNameOf(payload.name);
    const encoded = text(payload.data, 'file content', 36 * 1024 * 1024);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Invalid attachment data.');
    const data = Buffer.from(encoded, 'base64');
    return method === 'file.save' ? saveBytes(win, name, data) : openBytes(name, data);
  }
  if (method === 'notification.test') {
    notify('Aplos Mail', 'Notifications are ready.');
    return true;
  }
  if (method === 'system.login') {
    if (typeof payload.enabled !== 'boolean') throw new Error('Choose whether to launch at login.');
    // Test mode touches nothing system-wide and answers as the real call does: `{ enabled }` echoing the request.
    if (isTest) return { enabled: payload.enabled };
    app.setLoginItemSettings({ openAtLogin: payload.enabled });
    return { enabled: app.getLoginItemSettings().openAtLogin };
  }
  if (method === 'system.defaultMail') {
    // Test mode does not register as the mailto handler; it answers `{ success: true }` as if it had.
    if (isTest) return { success: true };
    const success = app.setAsDefaultProtocolClient('mailto');
    return { success };
  }
  if (method === 'system.microphone') {
    if (process.platform !== 'darwin') return { granted: true, status: 'granted' };
    // `check` reports the current permission without showing the macOS prompt.
    if (payload.check === true) {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      return { granted: status === 'granted', status };
    }
    // The macOS permission prompt is a system dialog, so test mode answers "not asked yet" instead.
    if (isTest) return { granted: false, status: 'not-determined' };
    const granted = await systemPreferences.askForMediaAccess('microphone');
    return { granted, status: systemPreferences.getMediaAccessStatus('microphone') };
  }
  throw new Error('Unsupported desktop method.');
}

export { nativeMethods, notify, invokeNative, saveBytes, openBytes, sweepAttachmentTemp };
