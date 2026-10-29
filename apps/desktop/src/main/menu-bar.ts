import { app, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import { command } from './windows';
import { checkManually } from './updater';
import { releaseBuild } from './oauth-config';

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

export { menus };
