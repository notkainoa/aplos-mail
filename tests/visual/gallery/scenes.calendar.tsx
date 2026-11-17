// ui-calendar scenes: every state in `screens/calendar`'s `calendarStates`, drawn as that module's own
// fixture — the real CalendarView on hand-written contract values through the screen's reducer, in a stand-in
// window with the sidebar's MiniMonth and Calendars list beside the pane. A fixture's `width` narrows the
// window (the agenda state draws a 900 px window at either viewport); the window fills the stage otherwise.

import type { ReactElement } from 'react';
import {
  calendarStates,
  demoWorld,
  FIXTURES,
  PreviewCalendar,
} from '../../../apps/desktop/src/renderer/screens/calendar/CalendarStates';
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

/** N on an account whose grant only reads: the editor leads with Turn on editing and Save waits. */
function ReadOnlyEditorScene(): ReactElement {
  const fixture = {
    ...FIXTURES['editor-new'],
    accounts: [{ ...demoWorld.accounts[0], grantedScopes: [] }],
  };
  return <PreviewCalendar fixture={fixture} />;
}

export const calendarScenes: Record<string, () => ReactElement> = {
  ...Object.fromEntries(Object.keys(calendarStates).map(id => [id, sceneOf(id)])),
  'editor-new-turn-on-editing': ReadOnlyEditorScene,
};
