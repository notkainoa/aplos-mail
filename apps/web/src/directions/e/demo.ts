/** Original demo mail for the hero stage. */
export type DemoEmail = {
  sender: string;
  day: string;
  time: string;
  subject: string;
  summary: string;
  action: 'Reply' | 'Add to calendar';
};

export const DEMO_EMAILS: DemoEmail[] = [
  {
    sender: 'Jordan Park',
    day: 'Wed',
    time: '9:17 PM',
    subject: 'A quieter home for our project',
    summary: 'Jordan wants your pick between two layouts by tomorrow.',
    action: 'Reply',
  },
  {
    sender: 'Maya Chen',
    day: 'Thu',
    time: '8:02 AM',
    subject: 'Saturday in the community garden',
    summary: 'Maya asks if you can bring two trays of seedlings on Saturday at ten.',
    action: 'Reply',
  },
  {
    sender: 'Theo Kim',
    day: 'Fri',
    time: '8:32 PM',
    subject: 'Friday review: agenda and room',
    summary: 'Theo moved the review to Friday at two, in the corner room.',
    action: 'Add to calendar',
  },
  {
    sender: 'Sam Rivera',
    day: 'Thu',
    time: 'Nov 13',
    subject: 'Cabin weekend: a few loose ends',
    summary: 'Sam needs a headcount and whether you can drive, by Thursday.',
    action: 'Reply',
  },
];

/** How many emails Home's Do now starts with in the demo. */
export const DO_NOW_TOTAL = 6;

export type KeyId = 'space' | 'left' | 'right' | 'z' | 'a';

export type KeyInfo = { id: KeyId; glyph: string; word: string; label: string };

export const HERO_KEYS: KeyInfo[] = [
  { id: 'space', glyph: 'Space', word: 'Main action', label: 'Space, the suggested action' },
  { id: 'left', glyph: '←', word: 'Later', label: 'Left arrow, Later' },
  { id: 'right', glyph: '→', word: 'Done', label: 'Right arrow, Done' },
  { id: 'z', glyph: 'Z', word: 'Undo', label: 'Z, undo' },
  { id: 'a', glyph: 'A', word: 'Ask', label: 'A, Ask' },
];

/** The full list from the key-list claim, for the shortcut table. */
export const ALL_SHORTCUTS: { keys: string; does: string }[] = [
  { keys: 'Space', does: 'The suggested action' },
  { keys: '←', does: 'Later' },
  { keys: '→', does: 'Done' },
  { keys: 'Z', does: 'Undo' },
  { keys: 'B', does: 'Bookmark' },
  { keys: 'A', does: 'Ask, or hold to dictate' },
  { keys: 'C', does: 'Compose' },
  { keys: '?', does: 'Every shortcut' },
];
