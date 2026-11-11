import { app, BrowserWindow, nativeTheme } from 'electron';
import { join } from 'node:path';
import { DraftOwnership } from './desktop-policy';
import type { AppState, Listener } from '@aplos/contract/legacy/types';
import { rendererFile, devURL, trustedURL, external } from './security';
import { handleLink, pendingLinks } from './protocol';
import { latestState, realPath, realEngine, service } from './engine-host';
import { closing, quitting, finishQuit, failedStart } from './lifecycle';
import { isTest, dataDirOverride, testOnlyFlags, recordOauthReturn } from './test-mode';
import {
  createOnboarding,
  focusOauthReturnWindow,
  mailForActivation,
  onboardingEnabledFor,
  readSessionFacts,
  windowFallback,
  type Activation,
  type OnboardingMode,
  type SessionFacts,
  type WindowChoice,
  type WindowPort,
} from '../host/lifecycle';
import {
  consumeOauthReturn,
  isOauthReturnLink,
  oauthReturnNonce,
  type OauthReturnPurpose,
} from '../host/providers/oauth/returns';
import { releaseBuild } from './oauth-config';
import { engineWindowArguments } from '../host/transports/port';
import { isMailDocumentUrl } from '../host/protocol/relay';
import { attachSealedFrameRelays } from '../host/protocol/frame-relays';
import type { FrameLinkSinks } from '../host/protocol/frame-links';

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
/**
 * What `Session/get.hasAccounts` and `.setup` say: on the real-engine path main's control connection asks the engine
 * (the legacy mirror is empty there); today's path reads its state mirror. The last good answer serves a read that
 * fails while the engine restarts, so a Dock click then can never reopen onboarding for a finished setup.
 */
let lastFacts: SessionFacts | undefined;
async function sessionFacts(): Promise<SessionFacts> {
  if (realPath) {
    lastFacts = await readSessionFacts(() => realEngine.session(), lastFacts);
    return lastFacts;
  }
  lastFacts = {
    hasAccounts: !!latestState?.accounts.length,
    setup: latestState?.settings.onboardingDone ? { completedAt: 1 } : {},
  };
  return lastFacts;
}
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
function focusMain(): Promise<BrowserWindow | undefined> {
  // Dock, second launch, links and notifications all land here. An open welcome window answers them: never a second window.
  return activateWindows()
    .then(decision => {
      if (isTest) return undefined;
      const win = mailForActivation(decision, ensureMain);
      if (win === undefined) return undefined;
      // A window still waiting for its first paint shows itself then (F4: never a blank flash).
      if (!painted.has(win)) return win;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return win;
    })
    .catch(error => {
      windowFallback(error, {
        report: failure =>
          console.error('Aplos Mail: could not answer an activation:', describe(failure)),
        ensureMail: () => void ensureMain(),
        fatal: failedStart,
      });
      return main && !main.isDestroyed() ? main : undefined;
    });
}
// Runs on every state change. Assigning themeSource, even to the same value, resets the macOS app appearance
// and notifies theme observers, and the badge redraws the Dock tile, so only touch what actually changed.
let activeBadge = -1,
  activeTheme: AppState['settings']['theme'] | undefined,
  syncingTheme = false;
// The one theme mirror on both engine paths: the legacy AppState feeds it through applyAppearance, the real engine
// through its `appearance` host event (seeded at every engine start — main holds no settings copy there).
function hostTheme(theme: AppState['settings']['theme']) {
  if (activeTheme === theme) return;
  activeTheme = theme;
  syncTheme(true);
}
function applyAppearance(state: AppState) {
  hostTheme(state.settings.theme);
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
const webPreferences = () => ({
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
  // Only the real engine path's windows get `window.aplosEngine` (preload checks this argument).
  additionalArguments: engineWindowArguments(realPath),
});
/**
 * A subframe the app's own page points at a mail document (exactly `aplos-mail://m/<token>/`, html-5's strict form), or
 * an empty or inline document. security.ts applies the same rule, and only once the real path registered the scheme.
 */
function mailFrameURL(event: { url: string; initiator?: { url: string } | null }) {
  if (/^about:(blank|srcdoc)$/.test(event.url)) return true;
  return isMailDocumentUrl(event.url) && !!event.initiator && trustedURL(event.initiator.url);
}
/** The app's own data directory: the oauth-return nonce registry the utility process writes lives under it. */
const oauthReturnsDir = () => join(dataDirOverride ?? app.getPath('userData'), 'oauth-returns');
/** Nonces already accepted this run, so a replay or a re-created file can never focus twice. */
const consumedNonces = new Set<string>();

/**
 * Raises the one existing window a completed sign-in started in, resolved by `oauthReturnTarget`.
 * Never creates a window, never takes an action in test mode besides the record (`bring`/focus stay off).
 * The app itself is raised only once a live window took the focus (host/lifecycle orders it so): a
 * window that died between the open check and the focus must not pull Aplos forward over nothing.
 */
function focusOauthReturn(purpose: OauthReturnPurpose): 'onboarding' | 'mail' | 'none' {
  return focusOauthReturnWindow(purpose, {
    onboardingOpen: () => onboarding.isOpen(),
    focusOnboarding: () => onboarding.focusOpen(),
    mail: () => (main && !main.isDestroyed() ? portOf(main) : undefined),
    raiseApp: () => {
      if (!isTest && process.platform === 'darwin') app.focus({ steal: true });
    },
    testMode: isTest,
  });
}

/**
 * Claims `aplos://oauth-return` links (OS entry points and the mail-frame link sink): a strictly-shaped
 * link whose nonce the utility's registry still holds raises the recorded window; anything else that
 * claims the shape is a silent no-op. Returns false for every other link, which callers pass on to
 * `handleLink` unchanged. Never throws, never navigates, never creates a window.
 */
function handleOauthReturn(raw: string): boolean {
  if (!isOauthReturnLink(raw)) return false;
  const nonce = oauthReturnNonce(raw);
  const purpose = nonce
    ? consumeOauthReturn({ dir: oauthReturnsDir(), consumed: consumedNonces }, nonce)
    : undefined;
  recordOauthReturn(purpose ? `${purpose}:${focusOauthReturn(purpose)}` : 'rejected');
  return true;
}

/** Where a link from a sealed letter goes: mailto to Compose (`handleLink`), web links to the browser (never in test mode). */
const frameLinks: FrameLinkSinks = {
  openMail: url => {
    if (!handleOauthReturn(url)) handleLink(url);
  },
  openWeb: url => {
    if (!isTest) void external(url).catch(() => {});
  },
};
/** ARCH 10: links leave Aplos or open Compose, and nothing but the app's own page ever loads in any frame. */
function lockNavigation(win: BrowserWindow) {
  const contents = win.webContents;
  contents.on('will-navigate', (event, url) => {
    if (!trustedURL(url)) {
      event.preventDefault();
      if (!isTest) void external(url).catch(() => {});
    }
  });
  // Subframes only: Electron emits will-navigate for a main frame only when will-frame-navigate was not prevented,
  // so judging main frames here would hide a link click from the handler above (it would vanish, not open).
  contents.on('will-frame-navigate', event => {
    if (event.isMainFrame || trustedURL(event.url) || mailFrameURL(event)) return;
    event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!trustedURL(url)) event.preventDefault();
  });
  // The sealed letter: its listed keys go to the renderer (the frame is out of process), and its links and every
  // window.open go to Compose (mailto), the browser (http, https) or nowhere (javascript:, data:, file:, blob:, tel:...).
  attachSealedFrameRelays(contents, frameLinks);
}
function loadRenderer(win: BrowserWindow, query?: Record<string, string>) {
  if (devURL) {
    const url = new URL(devURL);
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    void win.loadURL(url.href);
  } else void win.loadFile(rendererFile, { query });
}
// A window's first paint: show it (never in test mode) and tell its renderer, once, that it is up (F4, the `shown` event).
const announced = new WeakSet<BrowserWindow>();
const painted = new WeakSet<BrowserWindow>();
function announceShown(win: BrowserWindow) {
  if (announced.has(win) || win.isDestroyed()) return;
  announced.add(win);
  win.webContents.send('aplos:event', { type: 'shown' });
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
    webPreferences: webPreferences(),
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
  win.once('ready-to-show', () => {
    painted.add(win);
    if (isTest) {
      if (testOnlyFlags.showWindows && !quitting) win.showInactive();
    } else if (!quitting) win.show();
    announceShown(win);
  });
  win.on('focus', () => syncTheme(false));
  lockNavigation(win);
  // The sidebar's top layout follows fullscreen (macOS traffic lights only overlap it while windowed).
  win.on('enter-full-screen', () => {
    win.webContents.send('aplos:event', { type: 'fullscreen', payload: { fullscreen: true } });
  });
  win.on('leave-full-screen', () => {
    win.webContents.send('aplos:event', { type: 'fullscreen', payload: { fullscreen: false } });
  });
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('aplos:event', {
      type: 'fullscreen',
      payload: { fullscreen: win.isFullScreen() },
    });
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
  loadRenderer(win, query);
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
/**
 * The one mail window (F3): the startup choice and every activation share this guard, so whichever answer lands
 * second never makes a second window; a destroyed one is replaced.
 */
function ensureMain(): BrowserWindow {
  if (!main || main.isDestroyed()) main = createWindow();
  return main;
}
function setMain(win: BrowserWindow) {
  main = win;
}
/** A page still loading has no preload yet and would drop the event: send it when it has loaded. */
function sendWhenReady(win: BrowserWindow, event: { type: string; payload?: unknown }) {
  const send = () => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed())
      win.webContents.send('aplos:event', event);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

// The welcome window (DESIGN 7.11) is the default first-run path. `APLOS_ONBOARDING_WINDOW=0` opts out for tests
// and debugging, which keeps the legacy behaviour (the mail window shows its own zero-accounts intro).
const onboardingEnabled = onboardingEnabledFor(process.env, realPath);
const welcome = { width: 640, height: 600, minHeight: 520 };
function portOf(win: BrowserWindow): WindowPort {
  return {
    id: win.id,
    isDestroyed: () => win.isDestroyed(),
    isVisible: () => win.isVisible(),
    hasPainted: () => painted.has(win),
    isMinimized: () => win.isMinimized(),
    restore: () => win.restore(),
    show: () => win.show(),
    focus: () => win.focus(),
    close: () => win.close(),
    setOpacity: value => win.setOpacity(value),
    onReadyToShow: listener => void win.once('ready-to-show', listener),
    onClosed: listener => void win.once('closed', listener),
  };
}
function createWelcomeWindow(mode: OnboardingMode): WindowPort {
  const win = new BrowserWindow({
    ...welcome,
    minWidth: welcome.width,
    maxWidth: welcome.width,
    title: 'Aplos Mail',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191a1c' : '#ffffff',
    show: false,
    icon: join(__dirname, 'icon.png'),
    webPreferences: webPreferences(),
  });
  windows.add(win);
  win.once('ready-to-show', () => {
    painted.add(win);
    if (isTest) {
      if (testOnlyFlags.showWindows && !quitting) win.showInactive();
    } else if (!quitting) win.show();
    announceShown(win);
  });
  win.on('focus', () => syncTheme(false));
  lockNavigation(win);
  win.webContents.on('did-finish-load', () => {
    if (latestState) win.webContents.send('aplos:event', { type: 'state', payload: latestState });
  });
  win.on('closed', () => {
    windows.delete(win);
    // After the welcome controller's own close handler, so its `Setup/end` reaches the engine before the quit closes it.
    if (quitting && !windows.size) setImmediate(finishQuit);
  });
  loadRenderer(win, { window: 'onboarding', mode });
  return portOf(win);
}
const onboarding = createOnboarding({
  createOnboarding: createWelcomeWindow,
  createMail: () => portOf(ensureMain()),
  currentMail: () => (main && !main.isDestroyed() ? portOf(main) : undefined),
  endSetup: async () => service?.invoke('Setup/end', { reason: 'closed' }),
  announceShown: port => {
    for (const win of windows) if (win.id === port.id) announceShown(win);
  },
  navigate: (port, to) => {
    for (const win of windows) {
      if (win.id !== port.id || win.isDestroyed() || win.webContents.isDestroyed()) continue;
      sendWhenReady(win, { type: 'navigate', payload: { to } });
    }
  },

  isQuitting: () => quitting || closing,
  testMode: isTest,
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: handle => clearTimeout(handle as NodeJS.Timeout),
});
/** Startup: which window to open. First run opens the onboarding window alone; the mail window waits for the handoff. */
async function startWindows(atLogin: boolean): Promise<WindowChoice> {
  // A login launch is resident: no window until the Dock or the menu-bar item asks for one (host-2).
  if (atLogin) return 'none';
  if (!onboardingEnabled) return 'mail';
  return onboarding.start(await sessionFacts(), { atLogin });
}
async function activateWindows(): Promise<Activation> {
  if (onboardingEnabled || onboarding.isOpen()) return onboarding.activate(await sessionFacts());
  return main && !main.isDestroyed() ? 'focus-mail' : 'open-mail';
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
  hostTheme,
  syncTheme,
  createWindow,
  popout,
  setMain,
  ensureMain,
  sendWhenReady,
  onboarding,
  sessionFacts,
  startWindows,
  handleOauthReturn,
};
