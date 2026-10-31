// DESIGN §8 commands: the reader. Part of the catalog (../catalog.ts re-exports it).
import type { CommandSpec } from '../types';

export const READER_COMMANDS: readonly CommandSpec[] = [
  {
    id: 'reader.nextThread',
    label: 'Next email',
    keys: ['j'],
    contexts: ['reader'],
    group: 'Go to',
    repeat: true,
    palette: false,
  },
  {
    id: 'reader.previousThread',
    label: 'Previous email',
    keys: ['k'],
    contexts: ['reader'],
    group: 'Go to',
    repeat: true,
    palette: false,
  },
  {
    id: 'reader.nextMessage',
    label: 'Next message',
    keys: ['ArrowDown'],
    contexts: ['reader'],
    group: 'Go to',
    repeat: true,
    palette: false,
  },
  {
    id: 'reader.previousMessage',
    label: 'Previous message',
    keys: ['ArrowUp'],
    contexts: ['reader'],
    group: 'Go to',
    repeat: true,
    palette: false,
  },
  {
    id: 'reader.expand',
    label: 'Show earlier messages and quoted text',
    keys: ['o'],
    contexts: ['reader'],
    group: 'Actions',
  },
  {
    id: 'reader.find',
    label: 'Find in this email',
    keys: ['meta+f'],
    contexts: ['reader'],
    group: 'Actions',
  },
];
