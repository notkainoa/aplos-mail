import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHoldTracker } from './hold';
import { createKeyQueue } from './keyQueue';
import { parseChord } from './keys';
import { resolve } from './resolver';
import { context, keydown, wiredRegistry } from './testing';
import { DEFAULT_KEY_PREFS, type Binding, type ContextName, type FocusKind, type KeyInput, type KeyPrefs } from './types';

const HOME: ContextName[] = ['global', 'list', 'home'];
const ALL_MAIL: ContextName[] = ['global', 'list'];
const READER: ContextName[] = ['global', 'list', 'reader'];
const ONE_BY_ONE: ContextName[] = ['global', 'list', 'reader', 'oneByOne'];
const DONE: ContextName[] = ['global', 'list', 'done'];
const CALENDAR: ContextName[] = ['global', 'calendar'];
const INLINE_REPLY: ContextName[] = ['global', 'list', 'reader', 'compose'];
const ASK: ContextName[] = ['global', 'ask'];
const PALETTE_OVER_HOME: ContextName[] = ['global', 'list', 'home', 'palette'];

interface Row {
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

const TABLE: readonly Row[] = [
  { name: 'IME composition is ignored', stack: HOME, event: keydown('e', { isComposing: true }), expect: null },
  { name: 'IME Process key is ignored', stack: HOME, event: keydown('Process'), expect: null },
  { name: 'Caps Lock E is still Done', stack: HOME, event: keydown('E'), expect: 'mail.done' },
  { name: 'Caps Lock R is reply, not reply all', stack: HOME, event: keydown('R'), expect: 'mail.reply' },
  { name: 'shift R is reply all', stack: HOME, event: keydown('R', { shiftKey: true }), expect: 'mail.replyAll' },
  { name: 'single key off in a text field', stack: ALL_MAIL, event: keydown('e'), focus: 'text', expect: null },
  { name: 'shift letter off in a text field', stack: HOME, event: keydown('A', { shiftKey: true }), focus: 'text', expect: null },
  { name: '⌘K works in a text field', stack: ALL_MAIL, event: keydown('k', { metaKey: true }), focus: 'text', expect: 'app.palette' },
  { name: '⌃5 works in a text field', stack: ALL_MAIL, event: keydown('5', { ctrlKey: true }), focus: 'text', expect: 'nav.sent' },
  { name: '⌘A in a text field selects text, not mail', stack: ALL_MAIL, event: keydown('a', { metaKey: true }), focus: 'text', expect: null },
  { name: '⌘A outside a field selects all mail', stack: ALL_MAIL, event: keydown('a', { metaKey: true }), expect: 'list.selectAll' },
  { name: '⌥↓ in a text field moves the caret', stack: HOME, event: keydown('ArrowDown', { altKey: true }), focus: 'text', expect: null },
  { name: 'single-key switch off disables E', stack: HOME, event: keydown('e'), prefs: { singleKeyShortcuts: false }, expect: null },
  { name: 'single-key switch off keeps ⌘K', stack: HOME, event: keydown('k', { metaKey: true }), prefs: { singleKeyShortcuts: false }, expect: 'app.palette' },
  { name: 'single-key switch off keeps Space', stack: HOME, event: keydown(' '), prefs: { singleKeyShortcuts: false }, expect: 'mail.suggested' },
  { name: 'single-key switch off keeps menu digits', stack: [...HOME, 'menu'], event: keydown('3'), prefs: { singleKeyShortcuts: false }, expect: 'menu.pickNumber' },
  { name: 'Space is the suggested action in a list', stack: ALL_MAIL, event: keydown(' '), expect: 'mail.suggested' },
  { name: 'Space is the suggested action in the reader', stack: READER, event: keydown(' '), expect: 'mail.suggested' },
  { name: 'Space on a focused button belongs to the button', stack: READER, event: keydown(' '), focus: 'control', expect: null },
  { name: 'innermost context wins: J in the reader is next email', stack: READER, event: keydown('j'), expect: 'reader.nextThread' },
  { name: 'J in a list moves the cursor', stack: ALL_MAIL, event: keydown('j'), expect: 'list.down' },
  { name: 'innermost context wins: ↓ in the reader is next message', stack: READER, event: keydown('ArrowDown'), expect: 'reader.nextMessage' },
  { name: 'outer context answers what inner does not: E in the reader', stack: READER, event: keydown('e'), expect: 'mail.done' },
  { name: 'global answers last: ⌃1 in calendar', stack: CALENDAR, event: keydown('1', { ctrlKey: true }), expect: 'nav.home' },
  { name: '→ is Done on Home', stack: HOME, event: keydown('ArrowRight'), expect: 'mail.done' },
  { name: '← is Later on Home', stack: HOME, event: keydown('ArrowLeft'), expect: 'mail.later' },
  { name: '→ is Done one by one', stack: ONE_BY_ONE, event: keydown('ArrowRight'), expect: 'mail.done' },
  { name: '→ is Done in the reader', stack: READER, event: keydown('ArrowRight'), expect: 'mail.done' },
  { name: '→ does nothing in All mail', stack: ALL_MAIL, event: keydown('ArrowRight'), expect: null },
  { name: '← does nothing in Done', stack: DONE, event: keydown('ArrowLeft'), expect: null },
  { name: '→ is the next period in calendar', stack: CALENDAR, event: keydown('ArrowRight'), expect: 'calendar.nextPeriod' },
  { name: 'swapped swipe direction: → is Later', stack: HOME, event: keydown('ArrowRight'), prefs: { swapTriageArrows: true }, expect: 'mail.later' },
  { name: 'E does nothing on done rows', stack: DONE, event: keydown('e'), expect: null },
  { name: 'H moves a done row to Home', stack: DONE, event: keydown('h'), expect: 'done.moveToHome' },
  { name: 'M is Month without an invite', stack: CALENDAR, event: keydown('m'), expect: 'calendar.monthView' },
  { name: 'M answers maybe with an invite open', stack: CALENDAR, event: keydown('m'), conditions: { invite: true }, expect: 'calendar.answerMaybe' },
  { name: 'Y does nothing without an invite', stack: CALENDAR, event: keydown('y'), expect: null },
  { name: 'Esc ladder: menu closes first', stack: [...HOME, 'menu'], event: keydown('Escape'), conditions: { selection: true }, expect: 'menu.close' },
  { name: 'Esc ladder: then the selection clears', stack: HOME, event: keydown('Escape'), conditions: { selection: true }, expect: 'list.clearSelection' },
  { name: 'Esc ladder: then back', stack: READER, event: keydown('Escape'), expect: 'nav.back' },
  { name: 'Esc in the palette goes up a level, never navigates', stack: PALETTE_OVER_HOME, event: keydown('Escape'), focus: 'text', expect: 'palette.back' },
  { name: 'Esc in compose dismisses the suggestion first', stack: INLINE_REPLY, event: keydown('Escape'), focus: 'text', conditions: { suggestion: true }, expect: 'compose.dismissSuggestion' },
  { name: 'Esc in compose closes when saved', stack: INLINE_REPLY, event: keydown('Escape'), focus: 'text', expect: 'compose.close' },
  { name: 'Ask Esc stops a streaming answer', stack: ASK, event: keydown('Escape'), focus: 'text', conditions: { streaming: true, askText: true }, expect: 'ask.stop' },
  { name: 'palette digits only while the field is empty', stack: PALETTE_OVER_HOME, event: keydown('2'), focus: 'text', expect: null },
  { name: 'palette digits run a result', stack: PALETTE_OVER_HOME, event: keydown('2'), focus: 'text', conditions: { emptyField: true }, expect: 'palette.pickNumber' },
  { name: 'typing E in the palette types', stack: PALETTE_OVER_HOME, event: keydown('e'), focus: 'text', expect: null },
  { name: '⌘Return sends from the compose field', stack: INLINE_REPLY, event: keydown('Enter', { metaKey: true }), focus: 'text', expect: 'compose.send' },
  { name: 'R replies and a hold upgrades to dictation', stack: READER, event: keydown('r'), expect: 'mail.reply', phase: 'tap', hold: 'mail.dictateReply' },
  { name: 'A opens Ask and a hold dictates', stack: HOME, event: keydown('a'), expect: 'ask.open', phase: 'tap', hold: 'ask.dictate' },
  { name: 'A in Ask’s field types, a hold dictates', stack: ASK, event: keydown('a'), focus: 'text', expect: 'ask.dictate', phase: 'hold' },
  { name: 'Space is never a hold key in lists', stack: HOME, event: keydown(' '), expect: 'mail.suggested', phase: 'tap' },
  { name: 'hold Space in an empty compose body', stack: INLINE_REPLY, event: keydown(' '), focus: 'text', conditions: { emptyBody: true }, expect: 'compose.dictate', phase: 'hold' },
  { name: 'Space in a compose body with text just types', stack: INLINE_REPLY, event: keydown(' '), focus: 'text', expect: null },
  { name: 'auto-repeat moves', stack: ALL_MAIL, event: keydown('j', { repeat: true }), expect: 'list.down' },
  { name: 'auto-repeat never triages', stack: HOME, event: keydown('e', { repeat: true }), expect: null },
  { name: '⌘⌥L skips to the list with Option composing ¬', stack: READER, event: keydown('¬', { metaKey: true, altKey: true, code: 'KeyL' }), expect: 'nav.skipToList' },
  { name: '? opens the sheet', stack: HOME, event: keydown('?', { shiftKey: true, code: 'Slash' }), expect: 'app.shortcuts' },
  { name: '# trashes', stack: HOME, event: keydown('#', { shiftKey: true, code: 'Digit3' }), expect: 'mail.trash' },
];

for (const row of TABLE) {
  test(`resolve: ${row.name}`, () => {
    const prefs = { ...DEFAULT_KEY_PREFS, ...row.prefs };
    const registry = wiredRegistry(prefs);
    const result = registry.resolve(row.event, context(row.stack, { focus: row.focus, conditions: row.conditions, prefs }));
    assert.equal(result?.commandId ?? null, row.expect);
    if (row.phase) assert.equal(result?.phase, row.phase);
    if (row.expect && row.phase === 'tap') assert.equal(result?.holdCommandId, row.hold);
  });
}

test('resolve without isEnabled treats guarded bindings as unmet', () => {
  const registry = wiredRegistry();
  const result = resolve(keydown('m'), CALENDAR, registry.bindings(), DEFAULT_KEY_PREFS);
  assert.equal(result?.commandId, 'calendar.monthView');
});

test('resolve on raw bindings: a block stops outer contexts', () => {
  const bindings: Binding[] = [
    { commandId: 'x.outer', chord: parseChord('e'), context: 'list', phase: 'tap', inTextField: false, repeat: false, guarded: false, followsSwipe: false },
    { commandId: null, chord: parseChord('e'), context: 'done', phase: 'tap', inTextField: false, repeat: false, guarded: false, followsSwipe: false },
  ];
  assert.equal(resolve(keydown('e'), ['list'], bindings, DEFAULT_KEY_PREFS)?.commandId, 'x.outer');
  assert.equal(resolve(keydown('e'), ['list', 'done'], bindings, DEFAULT_KEY_PREFS), null);
});

test('hold tracker: a tap under the threshold stays a tap', () => {
  const tracker = createHoldTracker(250);
  tracker.down('r', 'mail.dictateReply', 1000);
  assert.equal(tracker.deadline, 1250);
  assert.equal(tracker.tick(1100), null);
  const release = tracker.up('r', 1180);
  assert.deepEqual(release, { chordId: 'r', commandId: 'mail.dictateReply', phase: 'tap', upgraded: false, heldMs: 180 });
  assert.equal(tracker.armed, false);
});

test('hold tracker: crossing the threshold upgrades once, keyup releases', () => {
  const tracker = createHoldTracker(250);
  tracker.down('r', 'mail.dictateReply', 0);
  assert.equal(tracker.down('r', 'mail.dictateReply', 40), null, 'auto-repeat is ignored');
  assert.deepEqual(tracker.tick(250), { chordId: 'r', commandId: 'mail.dictateReply', heldMs: 250 });
  assert.equal(tracker.tick(300), null, 'the upgrade fires once');
  assert.equal(tracker.deadline, null);
  const release = tracker.up('r', 900);
  assert.equal(release?.phase, 'hold');
  assert.equal(release?.upgraded, true);
});

test('hold tracker: keyup timing decides when the timer was late', () => {
  const tracker = createHoldTracker(250);
  tracker.down('a', 'ask.dictate', 0);
  const release = tracker.up('a', 250);
  assert.equal(release?.phase, 'hold');
  assert.equal(release?.upgraded, false, 'no tick fired, so nothing is running');
});

test('hold tracker: another key ends the hold before it upgrades', () => {
  const tracker = createHoldTracker(250);
  tracker.down('r', 'mail.dictateReply', 0);
  const ended = tracker.interrupt(100);
  assert.equal(ended?.phase, 'tap');
  assert.equal(tracker.tick(400), null);
  assert.equal(tracker.up('r', 500), null);
});

test('key queue buffers during a transition and drains in order', () => {
  const queue = createKeyQueue<string>();
  assert.equal(queue.offer('j'), false, 'idle: dispatch now');
  queue.begin();
  queue.begin();
  assert.equal(queue.offer('e'), true);
  assert.equal(queue.offer('e'), true);
  queue.end();
  assert.deepEqual(queue.drain(), [], 'still inside the outer transition');
  queue.end();
  assert.equal(queue.offer('j'), true, 'queues behind waiting keys so nothing overtakes');
  assert.deepEqual(queue.drain(), ['e', 'e', 'j']);
  assert.equal(queue.offer('k'), false);
});

test('key queue dispatches rather than drops past its limit', () => {
  const queue = createKeyQueue<number>(2);
  queue.begin();
  assert.equal(queue.offer(1), true);
  assert.equal(queue.offer(2), true);
  assert.equal(queue.offer(3), false);
});
