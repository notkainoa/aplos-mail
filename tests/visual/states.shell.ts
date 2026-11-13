// ui-shell states that draw a whole screen in the real app on the stand-in (see gallery/scenes.shell.tsx).

import type { VisualState } from './states';

export const shellSettingsStates: readonly VisualState[] = [
  {
    id: 'shell-settings-mounted',
    frame: 'shell',
    title: 'Shell: the real Settings screen in the real app on the stand-in (General section)',
    components: ['Sidebar', 'Pane', 'SettingRow', 'Puck'],
    design: '7.1, 7.10',
    mockup: 'settings-appearance.html (default)',
    filled: 0,
  },
  {
    id: 'shell-calendar-sidebar',
    frame: 'shell',
    title: 'Shell: the real Calendar screen; the sidebar holds still under the places',
    components: ['Sidebar', 'Pane', 'MiniMonth', 'CalendarList'],
    design: '7.1, 7.8',
    mockup: 'calendar-week.html (default)',
    filled: 0,
  },
  {
    id: 'shell-help-sidebar',
    frame: 'shell',
    title: 'Shell: Settings on its Help section; only Help is marked in the sidebar',
    components: ['Sidebar', 'Pane', 'SettingRow', 'Puck'],
    design: '7.1, 7.10',
    mockup: 'settings-appearance.html (default)',
    filled: 0,
  },
  {
    id: 'shell-send-failed',
    frame: 'shell',
    title:
      'Shell: a send failed; the error toast with its alert icon and a close button, and the sidebar notice',
    components: ['Toast', 'ToastStack', 'Sidebar'],
    design: '7.13, 7.15',
    mockup: 'toasts.html (default)',
    filled: 1,
  },
  {
    id: 'shell-send-failed-faded',
    frame: 'shell',
    title: 'Shell: the failure toast has gone; the sidebar notice stays with Try again and Edit',
    components: ['Sidebar'],
    design: '7.1, 7.15',
    mockup: 'errors.html (send-failed)',
    filled: 1,
  },
];
