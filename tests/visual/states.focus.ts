// The Home focus card's summary space in its two non-default states (owner decision 2026-11-13).
import type { VisualState } from './states';

export const focusStates: readonly VisualState[] = [
  {
    id: 'home-focus-pending',
    title: 'Home: the focus card while its summary is being written (quiet placeholder)',
    components: ['FocusSlot', 'FocusLetter'],
    design: '7.2, 9, 16',
    mockup: 'home.html (default)',
    filled: 1,
  },
  {
    id: 'home-focus-no-summary',
    title: 'Home: the focus card with no summary coming (the space collapses)',
    components: ['FocusSlot', 'FocusLetter'],
    design: '7.2, 9, 16',
    mockup: 'home.html (no-ai)',
    filled: 1,
    summary: 'absent',
  },
];
