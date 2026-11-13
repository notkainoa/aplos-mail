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
];
