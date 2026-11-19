// DESIGN §8 commands: search. Part of the catalog (../catalog.ts re-exports it).
import type { CommandSpec } from '../types';

export const SEARCH_COMMANDS: readonly CommandSpec[] = [
  // Remote search runs only on Return, to protect quota.
  {
    id: 'search.remote',
    label: 'Search all mail on Google',
    keys: [{ chord: 'Enter', inTextField: true }],
    contexts: ['search'],
    group: 'Actions',
    keywords: ['gmail', 'server'],
  },
];
