import { createContext } from 'react';

/**
 * False inside the second and later day segments of one multi-day all-day entry: those carry no DOM id and are
 * not walked, so `aria-activedescendant` and the ↑ ↓ walk see each entry once. Internal to the calendar family.
 */
export const FirstSegment = createContext(true);

/** The DOM id of a "+N" or "N more" button the ↑ ↓ walk has landed on (it is then the active descendant), or null. */
export const ActiveStack = createContext<string | null>(null);
