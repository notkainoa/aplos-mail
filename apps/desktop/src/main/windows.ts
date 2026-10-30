import { app, BrowserWindow, nativeTheme } from 'electron';
import { join } from 'node:path';
import { DraftOwnership } from './desktop-policy';
import type { AppState, Listener } from './contract-types';
import { rendererFile, devURL, trustedURL, external } from './security';
import { pendingLinks } from './protocol';
import { latestState } from './engine-host';
import { closing, quitting, finishQuit } from './lifecycle';
import { isTest } from './test-mode';
import { releaseBuild } from './oauth-config';

const windows = new Set<BrowserWindow>();
const claims = new DraftOwnership();
const popouts = new Map<string, BrowserWindow>();
const pendingClose = new Set<number>();
const permittedClose = new Set<number>();
let main: BrowserWindow | undefined;
function emit(event: Parameters<Listener>[0]) {
  for (const win of windows) if (!win.isDestroyed()) win.webContents.send('aplos:event', event);
}
function command(value: string) {
  const win = BrowserWindow.getFocusedWindow() || main;
  win?.webContents.send('aplos:event', { type: 'command', payload: value });
}
function focusMain() {
  // Test mode never shows or focuses a window (a window is still created so the renderer can be inspected).
  if (isTest) return;
  if (!main || main.isDestroyed()) main = createWindow();
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
}
// Runs on every state change. Assigning themeSource, even to the same value, resets the macOS app appearance
// and notifies theme observers, and the badge redraws the Dock tile, so only touch what actually changed.
let activeBadge = -1,
  activeTheme: AppState['settings']['theme'] | undefined,
  syncingTheme = false;
function applyAppearance(state: AppState) {
  if (activeTheme !== state.settings.theme) {
    activeTheme = state.settings.theme;
    syncTheme(true);
  }
  const badge = state.settings.zen
    ? 0
    : state.threads.filter(thread => thread.unread && thread.status === 'new').length;
  if (badge !== activeBadge && !isTest) {
    app.setBadgeCount(badge);
    activeBadge = badge;
  }
}
// The macOS sidebar material can keep the appearance it was drawn with when a change slips past it,
// leaving dark glass under light-theme text (or the reverse). When the setting or the system
// appearance changes, re-assert the app appearance if it drifted and redraw the material;
// when a window comes forward, do so only if it drifted.
function syncTheme(redraw: boolean) {
  if (!activeTheme || syncingTheme) return;
  syncingTheme = true;
  try {
    const drifted =
      activeTheme !== 'system' && nativeTheme.shouldUseDarkColors !== (activeTheme === 'dark');
    if (drifted && nativeTheme.themeSource === activeTheme) nativeTheme.themeSource = 'system';
    if (nativeTheme.themeSource !== activeTheme) nativeTheme.themeSource = activeTheme;
    if (process.platform === 'darwin' && (redraw || drifted))
      for (const win of windows)
        if (!win.isDestroyed()) {
          win.setVibrancy(null);
          win.setVibrancy('sidebar');
        }
  } finally {
    syncingTheme = false;
  }
}
function createWindow(query?: { draft?: string; thread?: string }) {
  const mac = process.platform === 'darwin';
  // macOS: a transparent window base lets the native sidebar material show through the
  // renderer's transparent sidebar; the content pane paints its own opaque surface.
  const chrome = mac
    ? {
        titleBarStyle: 'hidden' as const,
        trafficLightPosition: { x: 16, y: 14 },
        backgroundColor: '#00000000',
        vibrancy: 'sidebar' as const,
        visualEffectState: 'followWindow' as const,
      }
    : {
        titleBarStyle: 'hiddenInset' as const,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#e6e5e2',
      };
  const win = new BrowserWindow({
    width: query ? 900 : 1360,
    height: query ? 800 : 900,
    minWidth: query ? 640 : 960,
    minHeight: 560,
    title: 'Aplos Mail',
    ...chrome,
    show: false,
    icon: join(__dirname, 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      devTools: !releaseBuild,
      // A test window is never shown, and Chromium throttles hidden pages' timers hard: the renderer's save-before-close
      // answer to a quit could then take tens of seconds (plat-release, 2026-10-28 06:12).
      backgroundThrottling: !isTest,
    },
  });
  windows.add(win);
  let rendererReady = false;
  win.webContents.on('did-finish-load', () => {
    rendererReady = true;
  });
  win.webContents.on('did-fail-load', () => {
    rendererReady = false;
  });
  win.webContents.on('render-process-gone', () => {
    rendererReady = false;
  });
  win.on('close', event => {
    if (closing || permittedClose.has(win.id) || !rendererReady) return;
    event.preventDefault();
    if (pendingClose.has(win.id)) return;
    pendingClose.add(win.id);
    win.setEnabled(false);
    win.webContents.send('aplos:event', { type: 'prepare-close' });
  });
  win.webContents.on('will-prevent-unload', event => {
    if (permittedClose.has(win.id) || closing) event.preventDefault();
  });
  if (!isTest) win.once('ready-to-show', () => win.show());
  win.on('focus', () => syncTheme(false));
  win.webContents.on('will-navigate', (event, url) => {
    if (!trustedURL(url)) {
      event.preventDefault();
      if (!isTest) void external(url).catch(() => {});
    }
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!trustedURL(url)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isTest) void external(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', () => {
    if (latestState) win.webContents.send('aplos:event', { type: 'state', payload: latestState });
    if (win === main)
      for (const link of pendingLinks.splice(0))
        win.webContents.send('aplos:event', { type: 'deep-link', payload: link });
  });
  win.on('closed', () => {
    windows.delete(win);
    pendingClose.delete(win.id);
    permittedClose.delete(win.id);
    for (const id of claims.releaseWindow(win.id))
      emit({ type: 'draft-owner', payload: { draftId: id } });
    for (const [key, popout] of popouts) if (popout === win) popouts.delete(key);
    if (main === win) main = undefined;
    if (quitting && !windows.size) finishQuit();
  });
  if (devURL) {
    const url = new URL(devURL);
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    void win.loadURL(url.href);
  } else void win.loadFile(rendererFile, { query });
  return win;
}
function popout(kind: 'draft' | 'thread', id: string, fromWindowId: number) {
  const key = `${kind}:${id}`;
  const existing = popouts.get(key);
  if (existing && !existing.isDestroyed()) {
    if (!isTest) {
      existing.show();
      existing.focus();
    }
    return;
  }
  if (kind === 'draft') claims.assertEditable(id, fromWindowId);
  const win = createWindow({ [kind]: id });
  popouts.set(key, win);
  if (kind === 'draft') {
    claims.transfer(id, fromWindowId, win.id);
    emit({ type: 'draft-owner', payload: { draftId: id, windowId: win.id } });
  }
}
function setMain(win: BrowserWindow) {
  main = win;
}

export {
  windows,
  claims,
  popouts,
  pendingClose,
  permittedClose,
  main,
  emit,
  command,
  focusMain,
  applyAppearance,
  syncTheme,
  createWindow,
  popout,
  setMain,
};
