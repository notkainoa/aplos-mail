// Empty-state scenes added for the owner review of 2026-11-05 (centred in the pane, one muted mark, no trailing
// period): one per list the demo world can empty, plus search's no-match and the empty Low importance sheet.
// `shell-empty-sent` is a component scene — the stand-in's Sent view keeps trashed mail, so the screen's own
// line is drawn directly (see gallery/scenes.shell.tsx).

import type { VisualState } from './states';

export const emptyStates: readonly VisualState[] = [
  {
    id: 'list-empty',
    frame: 'shell',
    title: 'An empty list',
    components: ['EmptyLine'],
    design: '7.4, 7.14',
    mockup: 'empty.html (default)',
    filled: 0,
  },
  {
    id: 'shell-empty-drafts',
    frame: 'shell',
    title: 'Empty: no drafts',
    components: ['EmptyLine'],
    design: '7.14',
    mockup: 'empty.html (default)',
    filled: 0,
  },

  {
    id: 'list-all-empty',
    frame: 'shell',
    title: 'All mail: empty',
    components: ['EmptyLine'],
    design: '7.4, 7.14',
    mockup: 'empty.html (default)',
    filled: 0,
  },
  {
    id: 'list-drafts-empty',
    frame: 'shell',
    title: 'Drafts: no drafts',
    components: ['EmptyLine'],
    design: '7.4, 7.14',
    mockup: 'empty.html (drafts)',
    filled: 0,
  },
  {
    id: 'list-drafts-long',
    frame: 'shell',
    title: 'Drafts: a long address, date groups',
    components: ['ListBox', 'ListRow', 'SectionHeader'],
    design: '7.4',
    mockup: 'inbox.html (default)',
    filled: 0,
  },
  {
    id: 'list-drafts-many',
    frame: 'shell',
    title: 'Drafts: four recipients, "To: name, name and 1 more"',
    components: ['ListBox', 'ListRow', 'SectionHeader'],
    design: '7.4',
    mockup: 'inbox.html (default)',
    filled: 0,
  },
  {
    id: 'list-trash-empty',
    frame: 'shell',
    title: 'Trash: empty',
    components: ['EmptyLine'],
    design: '7.4, 7.14',
    mockup: 'empty.html (trash)',
    filled: 0,
  },
  {
    id: 'list-spam-empty',
    frame: 'shell',
    title: 'Spam: empty',
    components: ['EmptyLine'],
    design: '7.4, 7.14',
    mockup: 'empty.html (spam)',
    filled: 0,
  },
  {
    id: 'search-no-results',
    frame: 'shell',
    title: 'Search: no mail matches',
    components: ['EmptyLine', 'SearchField'],
    design: '7.9, 7.14',
    mockup: 'search.html (no-match)',
    filled: 0,
  },
  {
    id: 'home-low-sheet-empty',
    frame: 'shell',
    title: 'Home screen: the Low importance sheet open with nothing in it',
    components: ['LowSheet', 'EmptyLine'],
    design: '7.2, 7.14',
    mockup: 'empty.html (default)',
    filled: 0,
  },
  {
    id: 'shell-empty-sent',
    frame: 'shell',
    title: 'Empty: nothing sent yet',
    components: ['EmptyLine'],
    design: '7.14',
    mockup: 'empty.html (default)',
    filled: 0,
  },
];
