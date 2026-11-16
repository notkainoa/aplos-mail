// The resolver's decision table: one row per key, stack and expected command (used by resolver.test.ts).
import { keydown } from './testing';
import type { ContextName, FocusKind, KeyInput, KeyPrefs } from './types';

export const HOME: ContextName[] = ['global', 'list', 'home'];
export const ALL_MAIL: ContextName[] = ['global', 'list'];
export const READER: ContextName[] = ['global', 'list', 'reader'];
// The runtime stack of "Go one by one": the screen has no key context of its own and `useOneByOne` puts `home` on
// the shell's key layer, so it is Home's stack (the `oneByOne` context is only what a binding can name).
export const ONE_BY_ONE: ContextName[] = ['global', 'list', 'home'];
export const DONE: ContextName[] = ['global', 'list', 'done'];
export const CALENDAR: ContextName[] = ['global', 'calendar'];
export const INLINE_REPLY: ContextName[] = ['global', 'list', 'reader', 'compose'];
export const ASK: ContextName[] = ['global', 'ask'];
export const PALETTE_OVER_HOME: ContextName[] = ['global', 'list', 'home', 'palette'];
export const READER_OVER_DONE: ContextName[] = ['global', 'list', 'done', 'reader'];
export const TRANSIENTS: readonly ContextName[] = [
  'palette',
  'menu',
  'datePicker',
  'dialog',
  'sheet',
  'lowImportance',
];
export const SEARCH_FIELD: ContextName[] = ['global', 'search'];
export const SEARCH_RESULTS: ContextName[] = ['global', 'search', 'list'];
export const FIRST_SYNC: ContextName[] = ['onboarding', 'firstSync'];
export const DRILL: ContextName[] = ['onboarding', 'firstSync', 'drill'];
export const SINGLE_OFF: Partial<KeyPrefs> = { singleKeyShortcuts: false };

export interface Row {
  readonly name: string;
  readonly stack: readonly ContextName[];
  readonly event: KeyInput;
  readonly focus?: FocusKind;
  readonly conditions?: Record<string, boolean>;
  readonly prefs?: Partial<KeyPrefs>;
  readonly expect: string | null;
  readonly phase?: 'tap' | 'hold';
  readonly hold?: string;
}

export const TABLE: readonly Row[] = [
  {
    name: 'IME composition is ignored',
    stack: HOME,
    event: keydown('e', { isComposing: true }),
    expect: null,
  },
  { name: 'IME Process key is ignored', stack: HOME, event: keydown('Process'), expect: null },
  { name: 'Caps Lock E is still Done', stack: HOME, event: keydown('E'), expect: 'mail.done' },
  {
    name: 'Caps Lock R is reply, not reply all',
    stack: HOME,
    event: keydown('R'),
    expect: 'mail.reply',
  },
  {
    name: 'shift R is reply all',
    stack: HOME,
    event: keydown('R', { shiftKey: true }),
    expect: 'mail.replyAll',
  },
  {
    name: 'single key off in a text field',
    stack: ALL_MAIL,
    event: keydown('e'),
    focus: 'text',
    expect: null,
  },
  {
    name: 'shift letter off in a text field',
    stack: HOME,
    event: keydown('A', { shiftKey: true }),
    focus: 'text',
    expect: null,
  },
  {
    name: '⌘K works in a text field',
    stack: ALL_MAIL,
    event: keydown('k', { metaKey: true }),
    focus: 'text',
    expect: 'app.palette',
  },
  {
    name: '⌃5 works in a text field',
    stack: ALL_MAIL,
    event: keydown('5', { ctrlKey: true }),
    focus: 'text',
    expect: 'nav.sent',
  },
  {
    name: '⌘A in a text field selects text, not mail',
    stack: ALL_MAIL,
    event: keydown('a', { metaKey: true }),
    focus: 'text',
    expect: null,
  },
  {
    name: '⌘A outside a field selects all mail',
    stack: ALL_MAIL,
    event: keydown('a', { metaKey: true }),
    expect: 'list.selectAll',
  },
  {
    name: '⌥↓ in a text field moves the caret',
    stack: HOME,
    event: keydown('ArrowDown', { altKey: true }),
    focus: 'text',
    expect: null,
  },
  {
    name: 'single-key switch off disables E',
    stack: HOME,
    event: keydown('e'),
    prefs: { singleKeyShortcuts: false },
    expect: null,
  },
  {
    name: 'single-key switch off keeps ⌘K',
    stack: HOME,
    event: keydown('k', { metaKey: true }),
    prefs: { singleKeyShortcuts: false },
    expect: 'app.palette',
  },
  {
    name: 'single-key switch off keeps Space',
    stack: HOME,
    event: keydown(' '),
    prefs: { singleKeyShortcuts: false },
    expect: 'mail.suggested',
  },
  {
    name: 'single-key switch off keeps menu digits',
    stack: [...HOME, 'menu'],
    event: keydown('3'),
    prefs: { singleKeyShortcuts: false },
    expect: 'menu.pickNumber',
  },
  {
    name: 'Space is the suggested action in a list',
    stack: ALL_MAIL,
    event: keydown(' '),
    expect: 'mail.suggested',
  },
  {
    name: 'Space is the suggested action in the reader',
    stack: READER,
    event: keydown(' '),
    expect: 'mail.suggested',
  },
  {
    name: 'Space on a focused button belongs to the button',
    stack: READER,
    event: keydown(' '),
    focus: 'control',
    expect: null,
  },
  {
    name: 'innermost context wins: J in the reader is next email',
    stack: READER,
    event: keydown('j'),
    expect: 'reader.nextThread',
  },
  {
    name: 'J in a list moves the cursor',
    stack: ALL_MAIL,
    event: keydown('j'),
    expect: 'list.down',
  },
  {
    name: 'innermost context wins: ↓ in the reader is next message',
    stack: READER,
    event: keydown('ArrowDown'),
    expect: 'reader.nextMessage',
  },
  {
    name: 'outer context answers what inner does not: E in the reader',
    stack: READER,
    event: keydown('e'),
    expect: 'mail.done',
  },
  {
    name: 'global answers last: ⌃1 in calendar',
    stack: CALENDAR,
    event: keydown('1', { ctrlKey: true }),
    expect: 'nav.home',
  },
  { name: '→ is Done on Home', stack: HOME, event: keydown('ArrowRight'), expect: 'mail.done' },
  { name: '← is Later on Home', stack: HOME, event: keydown('ArrowLeft'), expect: 'mail.later' },
  {
    name: '→ is Done one by one',
    stack: ONE_BY_ONE,
    event: keydown('ArrowRight'),
    expect: 'mail.done',
  },
  {
    name: '→ is Done in the reader',
    stack: READER,
    event: keydown('ArrowRight'),
    expect: 'mail.done',
  },
  {
    name: '→ does nothing in All mail',
    stack: ALL_MAIL,
    event: keydown('ArrowRight'),
    expect: null,
  },
  { name: '← does nothing in Done', stack: DONE, event: keydown('ArrowLeft'), expect: null },
  {
    name: '→ in a text field moves the caret, not Done',
    stack: HOME,
    event: keydown('ArrowRight'),
    focus: 'text',
    expect: null,
  },
  {
    name: '← in a text field moves the caret, not Later',
    stack: HOME,
    event: keydown('ArrowLeft'),
    focus: 'text',
    expect: null,
  },
  {
    name: '⇧→ is not → on Home',
    stack: HOME,
    event: keydown('ArrowRight', { shiftKey: true }),
    expect: null,
  },
  {
    name: '⌘→ is not → on Home',
    stack: HOME,
    event: keydown('ArrowRight', { metaKey: true }),
    expect: null,
  },
  {
    name: '→ is the next period in calendar',
    stack: CALENDAR,
    event: keydown('ArrowRight'),
    expect: 'calendar.nextPeriod',
  },
  {
    name: 'swapped swipe direction: → is Later',
    stack: HOME,
    event: keydown('ArrowRight'),
    prefs: { swapTriageArrows: true },
    expect: 'mail.later',
  },
  { name: 'E does nothing on done rows', stack: DONE, event: keydown('e'), expect: null },
  {
    name: 'H moves a done row to Home',
    stack: DONE,
    event: keydown('h'),
    expect: 'done.moveToHome',
  },
  {
    name: 'M is Month without an invite',
    stack: CALENDAR,
    event: keydown('m'),
    expect: 'calendar.monthView',
  },
  {
    name: 'M answers maybe with an invite open',
    stack: CALENDAR,
    event: keydown('m'),
    conditions: { invite: true },
    expect: 'calendar.answerMaybe',
  },
  { name: 'Y does nothing without an invite', stack: CALENDAR, event: keydown('y'), expect: null },
  {
    name: 'Esc ladder: menu closes first',
    stack: [...HOME, 'menu'],
    event: keydown('Escape'),
    conditions: { selection: true },
    expect: 'menu.close',
  },
  {
    name: 'Esc ladder: then the selection clears',
    stack: HOME,
    event: keydown('Escape'),
    conditions: { selection: true },
    expect: 'list.clearSelection',
  },
  { name: 'Esc ladder: then back', stack: READER, event: keydown('Escape'), expect: 'nav.back' },
  {
    name: 'Esc in the palette goes up a level, never navigates',
    stack: PALETTE_OVER_HOME,
    event: keydown('Escape'),
    focus: 'text',
    expect: 'palette.back',
  },
  {
    name: 'Esc in compose dismisses the suggestion first',
    stack: INLINE_REPLY,
    event: keydown('Escape'),
    focus: 'text',
    conditions: { suggestion: true },
    expect: 'compose.dismissSuggestion',
  },
  {
    name: 'Esc in compose closes when saved',
    stack: INLINE_REPLY,
    event: keydown('Escape'),
    focus: 'text',
    expect: 'compose.close',
  },
  {
    name: 'Ask Esc stops a streaming answer',
    stack: ASK,
    event: keydown('Escape'),
    focus: 'text',
    conditions: { streaming: true, askText: true },
    expect: 'ask.stop',
  },
  {
    name: 'palette digits only while the field is empty',
    stack: PALETTE_OVER_HOME,
    event: keydown('2'),
    focus: 'text',
    expect: null,
  },
  {
    name: 'palette digits run a result',
    stack: PALETTE_OVER_HOME,
    event: keydown('2'),
    focus: 'text',
    conditions: { emptyField: true },
    expect: 'palette.pickNumber',
  },
  {
    name: 'typing E in the palette types',
    stack: PALETTE_OVER_HOME,
    event: keydown('e'),
    focus: 'text',
    expect: null,
  },
  {
    name: '⌘Return sends from the compose field',
    stack: INLINE_REPLY,
    event: keydown('Enter', { metaKey: true }),
    focus: 'text',
    expect: 'compose.send',
  },
  {
    name: 'R replies and a hold upgrades to dictation',
    stack: READER,
    event: keydown('r'),
    expect: 'mail.reply',
    phase: 'tap',
    hold: 'mail.dictateReply',
  },
  {
    name: 'A opens Ask and a hold dictates',
    stack: HOME,
    event: keydown('a'),
    expect: 'ask.open',
    phase: 'tap',
    hold: 'ask.dictate',
  },
  {
    name: 'A in Ask’s field types, a hold dictates',
    stack: ASK,
    event: keydown('a'),
    focus: 'text',
    expect: 'ask.dictate',
    phase: 'hold',
  },
  {
    name: 'Space is never a hold key in lists',
    stack: HOME,
    event: keydown(' '),
    expect: 'mail.suggested',
    phase: 'tap',
  },
  {
    name: 'hold Space in an empty compose body',
    stack: INLINE_REPLY,
    event: keydown(' '),
    focus: 'text',
    conditions: { emptyBody: true },
    expect: 'compose.dictate',
    phase: 'hold',
  },
  {
    name: 'Space in a compose body with text just types',
    stack: INLINE_REPLY,
    event: keydown(' '),
    focus: 'text',
    expect: null,
  },
  {
    name: 'auto-repeat moves',
    stack: ALL_MAIL,
    event: keydown('j', { repeat: true }),
    expect: 'list.down',
  },
  {
    name: 'auto-repeat never triages',
    stack: HOME,
    event: keydown('e', { repeat: true }),
    expect: null,
  },
  {
    name: '⌘⌥L skips to the list with Option composing ¬',
    stack: READER,
    event: keydown('¬', { metaKey: true, altKey: true, code: 'KeyL' }),
    expect: 'nav.skipToList',
  },
  {
    name: '? opens the sheet',
    stack: HOME,
    event: keydown('?', { shiftKey: true, code: 'Slash' }),
    expect: 'app.shortcuts',
  },
  {
    name: '# trashes',
    stack: HOME,
    event: keydown('#', { shiftKey: true, code: 'Digit3' }),
    expect: 'mail.trash',
  },

  // The WCAG switch is separate from the text-field rule: hold A never dictates with single keys off.
  {
    name: 'single keys off: A in Ask’s field does nothing',
    stack: ASK,
    event: keydown('a'),
    focus: 'text',
    prefs: SINGLE_OFF,
    expect: null,
  },
  {
    name: 'single keys off: A in Ask without focus does nothing',
    stack: ASK,
    event: keydown('a'),
    prefs: SINGLE_OFF,
    expect: null,
  },
  {
    name: 'single keys off: A on Home does nothing',
    stack: HOME,
    event: keydown('a'),
    prefs: SINGLE_OFF,
    expect: null,
  },
  {
    name: 'single keys off: hold Space still dictates into an empty body',
    stack: INLINE_REPLY,
    event: keydown(' '),
    focus: 'text',
    conditions: { emptyBody: true },
    prefs: SINGLE_OFF,
    expect: 'compose.dictate',
    phase: 'hold',
  },
  {
    name: 'single keys off: palette digits still pick',
    stack: PALETTE_OVER_HOME,
    event: keydown('2'),
    focus: 'text',
    conditions: { emptyField: true },
    prefs: SINGLE_OFF,
    expect: 'palette.pickNumber',
  },

  // Modal transients trap keys: nothing behind them runs.
  ...TRANSIENTS.flatMap((t): Row[] => [
    {
      name: `E in ${t} over a list does nothing`,
      stack: [...ALL_MAIL, t],
      event: keydown('e'),
      expect: null,
    },
    {
      name: `E in ${t} over a list with a focused button does nothing`,
      stack: [...ALL_MAIL, t],
      event: keydown('e'),
      focus: 'control',
      expect: null,
    },
    {
      name: `⌘Return in ${t} over compose does not send`,
      stack: [...INLINE_REPLY, t],
      event: keydown('Enter', { metaKey: true }),
      focus: 'text',
      expect: null,
    },
    {
      name: `⌃3 in ${t} does not navigate`,
      stack: [...HOME, t],
      event: keydown('3', { ctrlKey: true }),
      expect: null,
    },
  ]),
  ...(['palette', 'menu', 'datePicker', 'dialog'] as const).map((t): Row => ({
    name: `→ in ${t} over Home does not triage`,
    stack: [...HOME, t],
    event: keydown('ArrowRight'),
    expect: null,
  })),
  {
    name: '→ in the palette over the reader does not triage',
    stack: [...READER, 'palette'],
    event: keydown('ArrowRight'),
    expect: null,
  },
  {
    name: 'Esc in a dialog cancels it',
    stack: [...HOME, 'dialog'],
    event: keydown('Escape'),
    expect: 'dialog.cancel',
  },
  {
    name: '→ in the Low-importance sheet marks done (hold: everything)',
    stack: [...HOME, 'lowImportance'],
    event: keydown('ArrowRight'),
    expect: 'lowImportance.markAllDone',
  },
  {
    name: 'Esc on Welcome skips setup',
    stack: ['onboarding'],
    event: keydown('Escape'),
    conditions: { welcome: true },
    expect: 'onboarding.skipSetup',
  },
  {
    name: 'Esc on a later onboarding step goes back',
    stack: ['onboarding'],
    event: keydown('Escape'),
    expect: 'onboarding.back',
  },

  // The reconnect and consent sheet is modal: its Esc cancels, nothing behind it answers.
  {
    name: 'Esc in the sheet cancels it, not the Esc ladder',
    stack: [...HOME, 'sheet'],
    event: keydown('Escape'),
    expect: 'sheet.cancel',
  },
  {
    name: 'Return in the sheet chooses the highlighted button',
    stack: ['global', 'settings', 'sheet'],
    event: keydown('Enter'),
    expect: 'sheet.default',
  },
  {
    name: '⌘K over the sheet does not open the palette',
    stack: [...HOME, 'sheet'],
    event: keydown('k', { metaKey: true }),
    expect: null,
  },

  // First sync owns Esc in every state [F8]; the drill keeps it and takes its own letters.
  {
    name: 'Esc on first sync opens Aplos',
    stack: FIRST_SYNC,
    event: keydown('Escape'),
    expect: 'onboarding.openAplos',
  },
  {
    name: 'Esc on first sync opens Aplos even with Welcome flagged',
    stack: FIRST_SYNC,
    event: keydown('Escape'),
    conditions: { welcome: true },
    expect: 'onboarding.openAplos',
  },
  {
    name: 'Esc in the drill opens Aplos',
    stack: DRILL,
    event: keydown('Escape'),
    expect: 'onboarding.openAplos',
  },
  {
    name: 'Return on first sync continues (Open Aplos)',
    stack: FIRST_SYNC,
    event: keydown('Enter'),
    expect: 'onboarding.continue',
  },
  {
    name: 'Return in the drill goes back to progress',
    stack: DRILL,
    event: keydown('Enter'),
    expect: 'drill.leave',
  },
  {
    name: 'E in the drill marks a practice letter, never real mail',
    stack: DRILL,
    event: keydown('e'),
    expect: 'drill.done',
  },
  {
    name: 'J in the drill moves through practice letters',
    stack: DRILL,
    event: keydown('j'),
    expect: 'drill.next',
  },
  {
    name: 'Space in the drill runs the practice suggestion',
    stack: DRILL,
    event: keydown(' '),
    expect: 'drill.suggested',
  },
  {
    name: 'L in the drill does nothing (no Later in the drill)',
    stack: DRILL,
    event: keydown('l'),
    expect: null,
  },
  {
    name: '⌘K in the drill does nothing (no global in the onboarding window)',
    stack: DRILL,
    event: keydown('k', { metaKey: true }),
    expect: null,
  },
  {
    name: 'E on first sync outside the drill does nothing',
    stack: FIRST_SYNC,
    event: keydown('e'),
    expect: null,
  },

  // Search: Return in the field searches Google once; in the results the Lists keymap applies.
  {
    name: 'Return in the search field searches all mail on Google',
    stack: SEARCH_FIELD,
    event: keydown('Enter'),
    focus: 'text',
    expect: 'search.remote',
  },
  {
    name: 'Return on a search result opens it',
    stack: SEARCH_RESULTS,
    event: keydown('Enter'),
    expect: 'mail.open',
  },
  {
    name: 'E on a search result is Done',
    stack: SEARCH_RESULTS,
    event: keydown('e'),
    expect: 'mail.done',
  },
  {
    name: 'Return on a result opens it even if the shell collected list before search',
    stack: ['global', 'list', 'search'],
    event: keydown('Enter'),
    expect: 'mail.open',
  },
  {
    name: 'J typed in the search field types',
    stack: SEARCH_FIELD,
    event: keydown('j'),
    focus: 'text',
    expect: null,
  },

  // Stacks are normalized: the reader always sits on the list.
  {
    name: 'E in a reader stack without list is still Done',
    stack: ['global', 'reader'],
    event: keydown('e'),
    expect: 'mail.done',
  },
  {
    name: 'Space in one by one without list is the suggested action',
    stack: ['global', 'oneByOne'],
    event: keydown(' '),
    expect: 'mail.suggested',
  },

  // Done and Later are off in the Done place by command, not by key.
  {
    name: '→ in a reader opened from Done does nothing',
    stack: READER_OVER_DONE,
    event: keydown('ArrowRight'),
    expect: null,
  },
  {
    name: 'E in a reader opened from Done does nothing',
    stack: READER_OVER_DONE,
    event: keydown('e'),
    expect: null,
  },
  { name: 'L in Done does nothing', stack: DONE, event: keydown('l'), expect: null },

  // Guard priority comes from CONDITION_PRIORITY, not catalog order.
  {
    name: 'Esc on a focused proposal is Not now, even while streaming',
    stack: ASK,
    event: keydown('Escape'),
    focus: 'control',
    conditions: { streaming: true, proposal: true },
    expect: 'ask.declineProposal',
  },
  {
    name: 'Esc on a focused proposal beats clearing the question',
    stack: ASK,
    event: keydown('Escape'),
    conditions: { askText: true, proposal: true },
    expect: 'ask.declineProposal',
  },
  {
    name: 'Return on a focused proposal accepts it',
    stack: ASK,
    event: keydown('Enter'),
    conditions: { proposal: true },
    expect: 'ask.acceptProposal',
  },
  {
    name: 'R with the reminder toast sets the reminder and never dictates',
    stack: HOME,
    event: keydown('r'),
    conditions: { remindOffer: true },
    expect: 'mail.remindIfNoReply',
    phase: 'tap',
    hold: undefined,
  },

  // Digits: physical fallback only under ⌘ or ⌃, and shift stays part of the chord.
  {
    name: '⌃⇧1 is not ⌃1',
    stack: HOME,
    event: keydown('!', { ctrlKey: true, shiftKey: true, code: 'Digit1' }),
    expect: null,
  },
  {
    name: 'AZERTY ⌃1 (&) goes Home',
    stack: HOME,
    event: keydown('&', { ctrlKey: true, code: 'Digit1' }),
    expect: 'nav.home',
  },
  {
    name: 'German ⇧3 (§) is not menu item 3',
    stack: [...HOME, 'menu'],
    event: keydown('§', { shiftKey: true, code: 'Digit3' }),
    expect: null,
  },
  {
    name: 'AZERTY é is not menu item 2',
    stack: [...HOME, 'menu'],
    event: keydown('é', { code: 'Digit2' }),
    expect: null,
  },
  {
    name: 'AZERTY & is not menu item 1',
    stack: [...HOME, 'menu'],
    event: keydown('&', { code: 'Digit1' }),
    expect: null,
  },
  {
    name: 'AZERTY ⇧1 is menu item 1',
    stack: [...HOME, 'menu'],
    event: keydown('1', { shiftKey: true, code: 'Digit1' }),
    expect: 'menu.pickNumber',
  },
];
