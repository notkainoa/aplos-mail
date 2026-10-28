import {
  app,
  BrowserWindow,
  dialog,
  Notification,
  shell,
  systemPreferences,
  type IpcMainInvokeEvent,
} from 'electron';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { record, text, external } from './security';
import {
  claims,
  pendingClose,
  permittedClose,
  main,
  emit,
  focusMain,
  popout,
  onboarding,
} from './windows';
import { updates, restartToUpdate, cancelInstall } from './updater';
import { latestState } from './engine-host';
import { cancelQuit } from './lifecycle';
import { legacyDesktopMethods } from '@aplos/contract/allowlists';
import { isTest, recordNotification } from './test-mode';
import { settingsPaneUrl } from '../host/lifecycle';

const nativeMethods = new Set<string>(legacyDesktopMethods);
// Contract v1 desktop methods main already answers. A window reaches them once preload moves to the generated v1 table.
for (const name of ['Window/openOnboarding', 'Window/finishOnboarding', 'System/openSettings'])
  nativeMethods.add(name);
const ok = { ok: true } as const;
function notify(title: string, body: string, threadId?: string) {
  if (isTest) return recordNotification(title, body, threadId);
  if (!Notification.isSupported())
    throw new Error('Desktop notifications are unavailable on this system.');
  const notification = new Notification({ title, body, silent: !latestState?.settings.sendSound });
  notification.on('click', () => {
    focusMain();
    if (threadId)
      main?.webContents.send('aplos:event', { type: 'command', payload: `thread:${threadId}` });
  });
  notification.show();
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
    await onboarding.finish();
    return ok;
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
  if (method === 'window.compose') {
    const id = text(payload.draftId, 'draft ID', 200);
    if (!latestState?.drafts.some(draft => draft.id === id))
      throw new Error('Save this draft before opening a separate window.');
    popout('draft', id, win.id);
    return true;
  }
  if (method === 'window.thread') {
    popout('thread', text(payload.threadId, 'thread ID', 200), win.id);
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
    const name =
      basename(text(payload.name, 'file name', 255)).replace(/[\x00-\x1f]/g, '_') || 'attachment';
    const encoded = text(payload.data, 'file content', 36 * 1024 * 1024);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Invalid attachment data.');
    const data = Buffer.from(encoded, 'base64');
    if (data.length > 25 * 1024 * 1024) throw new Error('Attachment exceeds 25 MB.');
    if (method === 'file.save') {
      const result = await dialog.showSaveDialog(win, { defaultPath: name });
      if (result.canceled || !result.filePath) return { canceled: true };
      await writeFile(result.filePath, data);
      return { canceled: false, path: result.filePath };
    }
    if (
      !new Set([
        '.pdf',
        '.txt',
        '.md',
        '.csv',
        '.json',
        '.eml',
        '.ics',
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.webp',
        '.heic',
        '.doc',
        '.docx',
        '.xls',
        '.xlsx',
        '.ppt',
        '.pptx',
        '.rtf',
        '.mp3',
        '.mp4',
        '.wav',
        '.mov',
      ]).has(extname(name).toLowerCase())
    )
      throw new Error('Save this attachment to inspect it before opening.');
    if (isTest) return true; // no other app is launched in test mode
    const directory = await mkdtemp(join(tmpdir(), 'aplos-attachment-'));
    const file = join(directory, name);
    await writeFile(file, data, { mode: 0o600 });
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
    return true;
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

export { nativeMethods, notify, invokeNative };
