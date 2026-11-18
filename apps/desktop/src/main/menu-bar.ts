import { app, dialog, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import { command } from './windows';
import { checkManually } from './updater';
import { releaseBuild } from './oauth-config';
import {
  createMenuRefresh,
  MENU_BAR_TITLE,
  type MenuEntry,
  type MenuEntryId,
  type PauseState,
  type SyncFacts,
} from '../host/menu-bar';

function menus() {
  const item = (
    label: string,
    accelerator: string | undefined,
    value: string,
  ): MenuItemConstructorOptions => ({ label, accelerator, click: () => command(value) });
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => void checkManually() },
        item('Settings…', 'CmdOrCtrl+,', 'settings'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        item('New Message', 'CmdOrCtrl+N', 'compose'),
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
        { type: 'separator' },
        item('Undo Mail Action', 'CmdOrCtrl+Shift+Z', 'undo'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Toggle Sidebar', 'CmdOrCtrl+Shift+S', 'toggle-sidebar'),
        item('Search Mail', 'CmdOrCtrl+K', 'search'),
        item('Ask Aplos', 'CmdOrCtrl+J', 'ask'),
        item('Refresh Mail', 'CmdOrCtrl+R', 'refresh'),
        { type: 'separator' },
        item('Home', 'CmdOrCtrl+1', 'home'),
        item('Later', 'CmdOrCtrl+2', 'later'),
        item('All Mail', 'CmdOrCtrl+3', 'all'),
        item('Calendar', 'CmdOrCtrl+4', 'calendar'),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
        ...(!releaseBuild ? [{ role: 'toggleDevTools' } as MenuItemConstructorOptions] : []),
      ],
    },
    {
      label: 'Navigate',
      submenu: [item('Back', 'CmdOrCtrl+[', 'back'), item('Forward', 'CmdOrCtrl+]', 'forward')],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        item('Keyboard Shortcuts', 'CmdOrCtrl+/', 'shortcuts'),
        {
          label: 'About Aplos Mail',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: 'Aplos Mail',
              message: `Aplos Mail ${app.getVersion()}`,
              detail:
                'An independent desktop inbox. AI features use Groq by default, or the providers you choose in Settings.',
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** What the menu-bar item needs from the rest of main. */
interface MenuBarDeps {
  pause: PauseState;
  sync(): SyncFacts | undefined;
  open(): void;
  quit(): void;
}

const REFRESH_MS = 2000;
// A reference is kept so the item is not garbage collected, which would remove it from the menu bar.
let tray: Tray | undefined;
let refreshTimer: NodeJS.Timeout | undefined;

function toTemplate(
  entries: MenuEntry[],
  actions: Record<MenuEntryId, () => void>,
): MenuItemConstructorOptions[] {
  return entries.map(entry =>
    entry.type === 'separator'
      ? { type: 'separator' }
      : { label: entry.label, enabled: entry.enabled, click: actions[entry.id] },
  );
}

/**
 * The menu-bar item (never created in test mode; the caller checks `isTest`). A 1x1 transparent image plus the
 * title letter keeps the glyph a plain `A`. `createMenuRefresh` (host/menu-bar.ts) owns the rebuild rule.
 */
function startMenuBar(deps: MenuBarDeps) {
  if (tray) return;
  const image = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
  );
  tray = new Tray(image);
  tray.setTitle(MENU_BAR_TITLE);
  tray.setToolTip('Aplos Mail');
  const actions: Record<MenuEntryId, () => void> = {
    status: () => {},
    open: deps.open,
    pause: () => {
      if (deps.pause.active()) deps.pause.resume();
      else deps.pause.start();
      refresh();
    },
    quit: deps.quit,
  };
  const refresh = createMenuRefresh(
    { sync: deps.sync, pausedUntil: () => deps.pause.until() },
    entries => tray?.setContextMenu(Menu.buildFromTemplate(toTemplate(entries, actions))),
  );
  refresh();
  refreshTimer = setInterval(refresh, REFRESH_MS);
  refreshTimer.unref();
}

function stopMenuBar() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = undefined;
  tray?.destroy();
  tray = undefined;
}

export { menus, startMenuBar, stopMenuBar };
