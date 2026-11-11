// The reader states for a message to many people (ui-polish): six recipients, where the To circles stop at three, and
// five hundred, where the details popover scrolls inside the window. Kept apart from scenes.reader.tsx, which is at its
// line limit.

import type { ReactElement } from 'react';
import { OPEN_DETAILS, richScene } from './scenes.reader';

export const crowdScenes: Record<string, () => ReactElement> = {
  'reader-rich-crowd': richScene({ open: 'crowd' }),
  'reader-rich-crowd-details': richScene({ open: 'crowd500', steps: [OPEN_DETAILS] }),
};
