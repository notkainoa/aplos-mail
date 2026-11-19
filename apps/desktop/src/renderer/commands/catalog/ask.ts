// DESIGN §8 commands: Ask. Part of the catalog (../catalog.ts re-exports it).
import type { CommandSpec } from '../types';

export const ASK_COMMANDS: readonly CommandSpec[] = [
  {
    id: 'ask.submit',
    label: 'Send the question',
    keys: [{ chord: 'Enter', inTextField: true }],
    contexts: ['ask'],
    group: 'Ask',
    // The key also answers an empty field (accept a proposal, pick a suggestion), but the label is
    // wrong there: the palette lists it only with a question typed.
    paletteWhen: 'askText',
  },
  {
    id: 'ask.searchAllMail',
    label: 'Search all mail',
    icon: 'text.bubble',
    keys: [{ chord: 'meta+Enter', inTextField: true }],
    contexts: ['ask'],
    group: 'Ask',
    paletteWhen: 'askText',
  },
  {
    id: 'ask.sendNow',
    label: 'Send a queued follow-up now',
    keys: [{ chord: 'meta+Enter', inTextField: true }],
    contexts: ['ask'],
    group: 'Ask',
    onlyWhen: 'queued',
  },
  {
    id: 'ask.newChat',
    label: 'New chat',
    icon: 'text.bubble',
    keys: [{ chord: 'meta+n', inTextField: true }],
    contexts: ['ask'],
    group: 'Ask',
  },
  {
    id: 'ask.stop',
    label: 'Stop the answer',
    keys: ['Escape'],
    contexts: ['ask'],
    group: 'Ask',
    onlyWhen: 'streaming',
  },
  {
    id: 'ask.clear',
    label: 'Clear the question',
    keys: ['Escape'],
    contexts: ['ask'],
    group: 'Ask',
    onlyWhen: 'askText',
  },
  { id: 'ask.close', label: 'Close Ask', keys: ['Escape'], contexts: ['ask'], group: 'Ask' },
  // After a failed answer: a page of the providers set up in Settings → AI.
  {
    id: 'ask.useAnotherProvider',
    label: 'Use another provider…',
    keys: [],
    contexts: ['ask'],
    group: 'Ask',
    page: true,
    keywords: ['model', 'groq', 'retry'],
  },
];
