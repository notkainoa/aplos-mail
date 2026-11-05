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
];
