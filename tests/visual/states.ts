// The named states of the visual harness (DESIGN 12.5, plan 30 6.2). This file is plain data so the
// Playwright specs can read it in Node; gallery/scenes.tsx binds each id to the component tree that
// draws it, with original demo data. Screens add their states later by adding one entry here and one
// scene there.

export type Theme = 'light' | 'dark';

export interface VisualState {
  /** Stable id. The gallery loads it from `?state=<id>`; golden files are named after it. */
  id: string;
  title: string;
  /** The components on show, by their names in renderer/ui/props.ts. */
  components: readonly string[];
  /** The DESIGN section that specifies it. */
  design: string;
  /** The mockup it is compared with, as `file.html (state)`. */
  mockup: string;
  /** In the committed golden set (1440 x 900 only, both themes). Every other state is A/B only. */
  golden?: boolean;
  /** Number of filled buttons in the state. A route never has more than one (DESIGN 3 rule 6). */
  filled: 0 | 1;
  /** What the Summary on show is: ready renders in the serif, pending and absent in the sans. */
  summary?: 'ready' | 'pending' | 'absent';
  /** Also captured with Increase Contrast (the 20-state subset of DESIGN 12.5). */
  contrastMore?: boolean;
  /** 'pane' sits on the white pane inside the shell (default); 'window' fills the window, as the onboarding window does. */
  frame?: 'pane' | 'window';
}

export const STATES: readonly VisualState[] = [
  {
    id: 'home-focus',
    title: 'Home: focus slot, rows, sections and the low-importance band',
    components: ['FocusSlot', 'FocusLetter', 'ListRow', 'SectionHeader', 'LowBand'],
    design: '7.2',
    mockup: 'home.html (default)',
    golden: true,
    filled: 1,
    summary: 'ready',
    contrastMore: true,
  },
  {
    id: 'home-held-zero',
    title: 'Home: a held section that shows 0',
    components: ['ListGroup', 'SectionHeader', 'ListRow'],
    design: '5 rule 6, 7.2',
    mockup: 'home.html (default)',
    filled: 0,
  },
  {
    id: 'list-rows',
    title: 'List rows: unread, read, cursor, picked and error',
    components: ['ListBox', 'ListRow'],
    design: '7.4',
    mockup: 'inbox.html (default)',
    golden: true,
    filled: 0,
    contrastMore: true,
  },
  {
    id: 'done-rows',
    title: 'Done: rows with the stamp column',
    components: ['ListBox', 'ListRow', 'SectionHeader'],
    design: '7.4',
    mockup: 'done.html (default)',
    filled: 0,
  },
  {
    id: 'reader-head',
    title: 'Reader head: sender, serif summary and the suggested action',
    components: ['ReaderHead', 'Summary'],
    design: '7.5',
    mockup: 'reader.html (default)',
    golden: true,
    filled: 1,
    summary: 'ready',
    contrastMore: true,
  },
  {
    id: 'reader-head-pending',
    golden: true,
    title: 'Reader head: summary still pending, subject in the sans',
    components: ['ReaderHead', 'Summary'],
    design: '7.5, 9',
    mockup: 'reader.html (pending)',
    filled: 1,
    summary: 'pending',
  },
  {
    id: 'inline-reply',
    title: 'Inline reply under the thread',
    components: ['InlineReply', 'RecipientField', 'DraftState', 'Suggestion'],
    design: '7.6',
    mockup: 'reply.html (default)',
    golden: true,
    filled: 1,
  },
  {
    id: 'compose-page',
    title: 'Compose page',
    components: ['Composer', 'RecipientField', 'DraftState'],
    design: '7.6',
    mockup: 'compose.html (default)',
    golden: true,
    filled: 1,
  },
  {
    id: 'palette',
    title: 'Command palette: commands with matches and keycaps',
    components: ['Palette'],
    design: '7.9',
    mockup: 'palette.html (default)',
    golden: true,
    filled: 0,
  },
  {
    id: 'search-operators',
    title: 'Search field with operator tokens',
    components: ['SearchField', 'OperatorToken'],
    design: '7.9',
    mockup: 'search.html (default)',
    filled: 0,
  },
  {
    id: 'toast-stack',
    title: 'Toast stack: Done, Later and a pending write',
    components: ['ToastStack', 'Toast'],
    design: '7.13',
    mockup: 'toasts.html (default)',
    golden: true,
    filled: 0,
  },
  {
    id: 'menu-open',
    golden: true,
    title: 'Menu open from its button',
    components: ['Menu', 'Button'],
    design: '6, 7.1',
    mockup: 'settings-accounts.html (menu)',
    filled: 0,
  },
  {
    id: 'dialog-confirm-destructive',
    title: 'Dialog: destructive confirm, Cancel is the default',
    components: ['Confirm', 'Dialog'],
    design: '6, 7.9',
    mockup: 'palette.html (confirm)',
    golden: true,
    filled: 0,
  },
  {
    id: 'status-slot',
    title: 'Status slot: reconnect due, paused and offline',
    components: ['StatusSlot'],
    design: '7.1',
    mockup: 'errors.html (status)',
    filled: 0,
  },
  {
    id: 'empty-inbox-zero',
    title: 'Empty line: inbox zero',
    components: ['EmptyLine'],
    design: '7.14',
    mockup: 'empty.html (inbox zero)',
    filled: 0,
  },
  {
    id: 'error-send-failed',
    title: 'Error line: send failed',
    components: ['ErrorLine'],
    design: '7.15',
    mockup: 'errors.html (send failed)',
    filled: 0,
  },
  {
    id: 'settings-providers',
    title: 'Settings rows with the provider table',
    components: ['SettingRow', 'ProviderTable', 'Switch', 'NavHead'],
    design: '7.10',
    mockup: 'settings-ai.html (default)',
    filled: 0,
  },
  {
    id: 'calendar-week',
    title: 'Calendar week grid',
    components: ['CalendarGrid', 'EventBlock', 'NowLine'],
    design: '7.8',
    mockup: 'calendar-week.html (default)',
    filled: 0,
  },
  {
    id: 'onboarding-step',
    frame: 'window',
    title: 'Onboarding step: add your mail',
    components: ['OnboardingStep', 'ChoiceRow'],
    design: '7.11',
    mockup: 'onboarding-accounts.html (default)',
    filled: 1,
  },
  {
    id: 'progress-first-sync',
    frame: 'window',
    title: 'Progress segments: first sync',
    components: ['ProgressSegments', 'OnboardingStep'],
    design: '7.12',
    mockup: 'onboarding-sync.html (default)',
    filled: 0,
  },
];

export const THEMES: readonly Theme[] = ['light', 'dark'];

export const FROZEN_NOW = '2026-10-29T10:00:00-07:00';
export const TIME_ZONE = 'America/Los_Angeles';

export function galleryUrl(state: VisualState, theme: Theme, contrast = false): string {
  const query = new URLSearchParams({ state: state.id, theme });
  if (contrast) query.set('contrast', 'more');
  return `/tests/visual/gallery/index.html?${query.toString()}`;
}
