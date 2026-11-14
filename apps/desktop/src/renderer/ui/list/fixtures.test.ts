// Shared fixtures for the list family tests: demo rows, letters and a render that records every markup for the banned-phrase checks.
import type { DueInfo, FocusLetterProps, ListRowProps, TriageCommands } from '../props';
import { html } from './testkit.test';

export const noop = () => {};
export const TODAY_10 = '2026-10-29T10:00:00-07:00';
export const TOMORROW: DueInfo = {
  at: '2026-10-30T00:00:00-07:00',
  overdue: false,
  source: 'user',
};
export const DUE_TODAY: DueInfo = {
  at: '2026-10-29T00:00:00-07:00',
  overdue: true,
  source: 'structured',
};
export const FOUND: DueInfo = { at: '2026-10-31T00:00:00-07:00', overdue: false, source: 'ai' };
export const COMMANDS: TriageCommands = {
  suggest: 'mail.suggested',
  later: 'mail.later',
  done: 'mail.done',
  more: 'list.more',
};

export function row(over: Partial<ListRowProps> = {}): ListRowProps {
  return {
    id: 'row-leah',
    layout: 'home',
    density: 'comfortable',
    sender: 'Leah Okafor',
    primary:
      'Lunch for six tomorrow. Leah asks you to pick somewhere quiet with vegetarian options.',
    unread: false,
    date: '2026-10-27T09:30:00-07:00',
    cursor: false,
    picked: false,
    picking: false,
    hoverActions: [
      { commandId: 'mail.later', icon: 'clock', label: 'Later' },
      { commandId: 'mail.done', icon: 'check', label: 'Done' },
    ],
    onSelect: noop,
    onOpen: noop,
    onAction: noop,
    ...over,
  };
}

export function letter(over: Partial<FocusLetterProps> = {}): FocusLetterProps {
  return {
    id: 'focus-jordan',
    sender: 'Jordan Park',
    due: TOMORROW,
    date: TODAY_10,
    summary: {
      state: 'ready',
      text: 'Two layout directions for the Hollow Creek site are ready, and Jordan wants your pick by tomorrow so the build can start Monday.',
      subject: 'A quieter home for the Hollow Creek site',
      provenance: { provider: 'Groq', local: false },
    },
    suggestion: { verb: 'Reply', icon: 'reply', isDone: false },
    commands: COMMANDS,
    demoted: false,
    onSuggestion: noop,
    onLater: noop,
    onDone: noop,
    onMore: noop,
    ...over,
  };
}

export const collected: string[] = [];
export function render(element: Parameters<typeof html>[0]): string {
  const markup = html(element);
  collected.push(markup);
  return markup;
}
