// ui-calendar scenes: every state in `screens/calendar`'s `calendarStates`, drawn as that module's own
// fixture — the real CalendarView on hand-written contract values through the screen's reducer, in a stand-in
// window with the sidebar's MiniMonth and Calendars list beside the pane. A fixture's `width` narrows the
// window (the agenda state draws a 900 px window at either viewport); the window fills the stage otherwise.

import type { ReactElement } from 'react';
import { calendarStates } from '../../../apps/desktop/src/renderer/screens/calendar/CalendarStates';
import '../../../apps/desktop/src/renderer/screens/screens.css';

function sceneOf(id: string): () => ReactElement {
  return function CalendarStateScene(): ReactElement {
    const preview = calendarStates[id];
    return (
      <div style={{ width: `min(${preview.width}px, 100%)`, height: '100%', margin: '0 auto' }}>
        {preview.render()}
      </div>
    );
  };
}

export const calendarScenes: Record<string, () => ReactElement> = Object.fromEntries(
  Object.keys(calendarStates).map(id => [id, sceneOf(id)]),
);
