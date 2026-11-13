import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMANDS, CONTROLS, DISABLED_IN, conflicts, createAppRegistry } from './catalog';
import { BANNED_PHRASES, copyProblem } from './copy';
import { chordId } from './keys';
import { createRegistry, findConflicts } from './registry';
import { buildSheet, SHEET_POINTER_ROWS, SHEET_SECTIONS } from './sheet';
import { context, issuesFor, keydown, wiredRegistry } from './testing';
import { DEFAULT_KEY_PREFS, type CommandSpec, type ContextName, type Keymap } from './types';

const PALETTE_STACKS: readonly (readonly ContextName[])[] = [
  ['global'],
  ['global', 'search'],
  ['global', 'list'],
  ['global', 'list', 'home'],
  ['global', 'list', 'done'],
  ['global', 'list', 'reader'],
  ['global', 'list', 'reader', 'compose'],
  ['global', 'compose'],
  ['global', 'ask'],
  ['global', 'calendar'],
];

const ALL_CONDITIONS = {
  selection: true,
  invite: true,
  suggestion: true,
  emptyBody: true,
  emptyField: true,
  streaming: true,
  askText: true,
  proposal: true,
  queued: true,
  remindOffer: true,
  welcome: true,
};

const BANNED_ICON_PARTS = [
  'sparkle',
  'wand',
  'star',
  'brain',
  'robot',
  'bot',
  'apple.intelligence',
];

test('the catalog has no duplicate chord per context', () => {
  assert.deepEqual(findConflicts(createAppRegistry().bindings()), []);
});

test('a second command on S in lists is rejected, naming both (today’s keys.s double assignment)', () => {
  const twin: CommandSpec = {
    id: 'home.stack',
    label: 'Open the stack',
    keys: ['s'],
    contexts: ['list'],
    group: 'Go to',
  };
  assert.throws(
    () => createRegistry([...COMMANDS, twin], { controls: CONTROLS, disabledIn: DISABLED_IN }),
    /S in list: home\.oneByOne, home\.stack/,
  );
});

test('the same chord in different contexts is an override, not a conflict', () => {
  const registry = wiredRegistry();
  const js = registry
    .bindings()
    .filter(b => chordId(b.chord) === 'j')
    .map(b => b.context);
  assert.deepEqual(js.sort(), ['calendar', 'drill', 'list', 'reader']);
});

test('every action is palette-reachable from some context; only pure movement stays out', () => {
  const registry = wiredRegistry();
  const reachable = new Set<string>();
  for (const stack of PALETTE_STACKS) {
    const ctx = context([...stack, 'palette'], {
      conditions: ALL_CONDITIONS,
      selection: ['a', 'b'],
    });
    for (const entry of registry.commandsForPalette(ctx)) reachable.add(entry.id);
  }
  const missing = COMMANDS.filter(c => c.palette !== false)
    .map(c => c.id)
    .filter(id => !reachable.has(id));
  assert.deepEqual(missing, []);
  const hidden = COMMANDS.filter(c => c.palette === false);
  assert.deepEqual(
    hidden.map(c => c.id),
    [
      'list.down',
      'list.up',
      'reader.nextThread',
      'reader.previousThread',
      'reader.nextMessage',
      'reader.previousMessage',
    ],
  );
  for (const c of hidden) {
    assert.equal(c.repeat, true, `${c.id} is movement`);
    assert.ok(!reachable.has(c.id), `${c.id} must not be a palette row`);
  }
  const sheetIds = new Set(buildSheet(registry).flatMap(s => s.rows.map(r => r.id)));
  for (const c of hidden) assert.ok(sheetIds.has(c.id), `${c.id} stays in the sheet`);
});

test('palette: false is refused on a command that is not movement', () => {
  const sneaky: CommandSpec = {
    id: 'mail.hidden',
    label: 'Hidden action',
    keys: [],
    contexts: ['list'],
    group: 'Actions',
    palette: false,
  };
  assert.throws(
    () => createRegistry([...COMMANDS, sneaky], { controls: CONTROLS }),
    /only movement/,
  );
});

test('first open: Suggested comes from the suggested flag, and a handler can override it', () => {
  const registry = wiredRegistry();
  const home = context(['global', 'list', 'home', 'palette']);
  const suggested = registry
    .commandsForPalette(home)
    .filter(e => e.suggested)
    .map(e => e.id);
  assert.deepEqual(suggested, ['mail.suggested', 'mail.reply', 'mail.done', 'mail.later']);
  assert.ok(
    COMMANDS.every(c => (c.group as string) !== 'Suggested'),
    '"Suggested" is a section, not a command group',
  );
  registry.attach('ask.open', {
    run: () => undefined,
    suggested: ctx => ctx.target?.kind === 'thread',
  });
  const withThread = {
    ...home,
    target: {
      kind: 'thread' as const,
      id: 't1',
      title: 'Drew Bell',
      detail: 'October illustrations',
    },
  };
  assert.ok(registry.commandsForPalette(withThread).find(e => e.id === 'ask.open')?.suggested);
  assert.equal(registry.commandsForPalette(home).find(e => e.id === 'ask.open')?.suggested, false);
});

test('the palette shows keycaps from the registry and hides commands without handlers', () => {
  const registry = createAppRegistry();
  registry.attach('mail.done', { run: () => undefined });
  const entries = registry.commandsForPalette(context(['global', 'list', 'home', 'palette']));
  assert.deepEqual(
    entries.map(e => [e.id, e.keys]),
    [['mail.done', '→ or E']],
  );
  assert.ok(registry.missingHandlers().includes('mail.later'));
});

test('every bound command and control appears in the sheet with all its keys', () => {
  const registry = wiredRegistry();
  const sheet = buildSheet(registry);
  const listed = new Set(sheet.flatMap(s => s.rows.map(r => r.id)));
  const sheetContexts = new Set<ContextName>(SHEET_SECTIONS.flatMap(s => s.contexts));
  for (const b of registry.bindings()) {
    if (!sheetContexts.has(b.context)) continue;
    assert.ok(listed.has(b.commandId), `${b.commandId} is missing from the sheet`);
  }
});

test('the sheet includes ⌃5, ⌃7, ⌃8, ⌘K and ⌘/ (baseline defect 5)', () => {
  const keys = buildSheet(wiredRegistry()).flatMap(s => s.rows.map(r => r.keys));
  for (const wanted of ['⌃5', '⌃7', '⌃8', '⌘K', '⌘/']) assert.ok(keys.includes(wanted), wanted);
});

test('the sheet writes keys the way DESIGN §8 and the mockups do', () => {
  const keys = buildSheet(wiredRegistry()).flatMap(s => s.rows.map(r => r.keys));
  for (const wanted of ['⌘⌥L', '⌘⌥R', '⌘⇧Return', '⌘⇧C', '⌘⇧A'])
    assert.ok(keys.includes(wanted), wanted);
});

test('⌃1–8 go to Home, Later, All mail, Drafts, Sent, Calendar, Trash, Spam', () => {
  const registry = wiredRegistry();
  const expected = [
    'nav.home',
    'nav.later',
    'nav.allMail',
    'nav.drafts',
    'nav.sent',
    'nav.calendar',
    'nav.trash',
    'nav.spam',
  ];
  expected.forEach((id, i) => {
    assert.equal(registry.describeKeys(id), `⌃${i + 1}`, id);
  });
});

test('banned phrases match as substrings, so plurals are caught', () => {
  assert.ok(copyProblem('Move to Todos'));
  assert.ok(copyProblem('Smartly sorted'));
  assert.ok(copyProblem('Done!'));
  assert.equal(copyProblem('Move to Home'), null);
  assert.ok(BANNED_PHRASES.includes('todo'));
});

test('no label, keyword, prompt, undo text or sheet title uses a banned phrase or an exclamation mark', () => {
  const texts = [
    ...COMMANDS.flatMap(c => [
      c.label,
      c.confirm?.title ?? '',
      c.confirm?.prompt ?? '',
      c.confirm?.confirmLabel ?? '',
      c.undo?.label ?? '',
      ...(c.keywords ?? []),
    ]),
    ...CONTROLS.map(c => c.label),
    ...SHEET_SECTIONS.map(s => s.title),
    ...Object.values(SHEET_POINTER_ROWS).flatMap(rows => rows.map(r => r.label)),
  ];
  for (const text of texts) assert.equal(copyProblem(text), null);
});

test('a runtime label that breaks the voice falls back to the spec label and is reported', () => {
  const reported: string[] = [];
  const registry = createAppRegistry(undefined, (error, id) =>
    reported.push(`${id}: ${(error as Error).message}`),
  );
  registry.attach('mail.suggested', { run: () => undefined, labelFor: () => 'Add to your Todos' });
  const entry = registry
    .commandsForPalette(context(['global', 'list', 'palette']))
    .find(e => e.id === 'mail.suggested');
  assert.equal(entry?.label, 'Run the suggested action');
  assert.equal(reported.length, 1);
  assert.match(reported[0], /todo/);
});

test('no icon is a sparkle, wand, star, brain or robot; the magnifier belongs to Search alone', () => {
  for (const c of COMMANDS) {
    if (!c.icon) continue;
    for (const part of BANNED_ICON_PARTS)
      assert.ok(!c.icon.includes(part), `${c.id} uses ${c.icon}`);
  }
  assert.deepEqual(
    COMMANDS.filter(c => c.icon === 'magnifyingglass').map(c => c.id),
    ['nav.search'],
  );
  assert.equal(COMMANDS.find(c => c.id === 'ask.open')?.icon, 'text.bubble');
  assert.equal(COMMANDS.find(c => c.id === 'done.moveToHome')?.icon, 'house');
});

test('remapping replaces defaults and reports conflicts instead of accepting them', () => {
  const registry = wiredRegistry();
  const issues = registry.configure({
    ...DEFAULT_KEY_PREFS,
    keymap: { 'mail.bookmark': ['k'], 'mail.done': ['y'], 'no.such': ['q'] },
  });
  assert.deepEqual(
    issues.map(i => [i.commandId, i.reason]),
    [
      ['no.such', 'unknownCommand'],
      ['mail.bookmark', 'conflict'],
      ['mail.done', 'dropsDefault'],
    ],
  );
  assert.equal(registry.describeKeys('mail.bookmark'), 'B', 'the rejected remap keeps its default');
  assert.equal(registry.describeKeys('mail.done', ['list']), 'Y');
  const ctx = context(['global', 'list']);
  assert.equal(
    registry.resolve(
      { key: 'y', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false },
      ctx,
    )?.commandId,
    'mail.done',
  );
  assert.equal(
    registry.resolve(
      { key: 'e', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false },
      ctx,
    ),
    null,
  );
});

test('swapping E and L by remap is accepted; listing the arrows keeps them as they were', () => {
  const registry = wiredRegistry();
  const bare = registry.configure({
    ...DEFAULT_KEY_PREFS,
    keymap: { 'mail.done': ['l'], 'mail.later': ['e'] },
  });
  assert.deepEqual(
    bare.map(i => [i.commandId, i.reason]),
    [
      ['mail.done', 'dropsDefault'],
      ['mail.later', 'dropsDefault'],
    ],
    'a warning only: the remap applied',
  );
  assert.equal(registry.describeKeys('mail.done', ['global', 'list']), 'L');
  const kept = registry.configure({
    ...DEFAULT_KEY_PREFS,
    keymap: { 'mail.done': ['l', 'ArrowRight'], 'mail.later': ['e', 'ArrowLeft'] },
  });
  assert.deepEqual(kept, []);
  const home = context(['global', 'list', 'home']);
  assert.equal(registry.resolve(keydown('ArrowRight'), home)?.commandId, 'mail.done');
  assert.equal(
    registry.resolve(keydown('ArrowRight'), context(['global', 'list'])),
    null,
    '→ stays off in plain lists',
  );
});

test('a remap that drops a scoped or swipe default is reported, and re-adding it keeps its contexts and swap', () => {
  const dropped = conflicts({ 'mail.done': ['q'] });
  assert.deepEqual(
    dropped.map(i => [i.commandId, i.reason]),
    [['mail.done', 'dropsDefault']],
  );
  assert.match(dropped[0].detail, /→ no longer runs mail\.done in home, oneByOne, reader/);
  assert.deepEqual(
    conflicts({ 'mail.later': ['e'], 'mail.done': ['ArrowRight'] }).map(i => [
      i.commandId,
      i.reason,
    ]),
    [['mail.later', 'dropsDefault']],
    'Later loses ←; Done giving up E everywhere it lives is the remap itself',
  );
  const registry = wiredRegistry();
  registry.configure({
    ...DEFAULT_KEY_PREFS,
    keymap: { 'mail.later': ['e'], 'mail.done': ['ArrowRight'] },
  });
  const bindings = registry.keysFor('mail.done');
  assert.deepEqual(
    bindings.map(b => [b.context, b.followsSwipe]),
    [
      ['home', true],
      ['oneByOne', true],
      ['reader', true],
    ],
    'the default → as it was, not → in every list',
  );
  assert.equal(
    registry.resolve(keydown('ArrowRight'), context(['global', 'list'])),
    null,
    'All mail, Trash and results get no →',
  );
  const swapped = wiredRegistry();
  swapped.configure({
    ...DEFAULT_KEY_PREFS,
    swapTriageArrows: true,
    keymap: { 'mail.done': ['e', 'ArrowRight'] },
  });
  const home = context(['global', 'list', 'home']);
  assert.equal(
    swapped.resolve(keydown('ArrowLeft'), home)?.commandId,
    'mail.done',
    'the kept arrow still follows the swipe direction',
  );
  assert.equal(swapped.resolve(keydown('ArrowRight'), home)?.commandId, 'mail.later');
  assert.deepEqual(
    conflicts({ 'mail.bookmark': ['n'] }),
    [],
    'a command whose keys all share its contexts drops nothing scoped',
  );
});

test('a remap one context would hide in another is reported as shadowed', () => {
  assert.deepEqual(issuesFor({ 'nav.search': ['j'] }), [['nav.search', 'shadowed']]);
  assert.deepEqual(issuesFor({ 'app.undo': ['e'] }), [['app.undo', 'shadowed']]);
  assert.deepEqual(
    issuesFor({ 'mail.bookmark': ['c'] }),
    [['mail.bookmark', 'shadowed']],
    'B on C would hide New message in lists',
  );
  assert.deepEqual(
    issuesFor({ 'mail.bookmark': ['t'] }),
    [],
    'T is only Today in calendar, which never sits on a list',
  );
  assert.deepEqual(issuesFor({ 'nav.back': ['Escape'] }), [], 'restating a default is not a remap');
});

test('a remap may set only chord and phase, and never a text-editing chord', () => {
  const sneaky = {
    'mail.trash': [{ chord: 'x', inTextField: true, contexts: ['global'] }],
  } as unknown as Keymap;
  assert.deepEqual(issuesFor(sneaky), [['mail.trash', 'invalidEntry']]);
  assert.deepEqual(issuesFor({ 'mail.done': ['meta+c'] }), [['mail.done', 'reserved']]);
  assert.deepEqual(issuesFor({ 'mail.done': ['ctrl+k'] }), [['mail.done', 'reserved']]);
  assert.deepEqual(issuesFor({ 'mail.done': ['Tab'] }), [['mail.done', 'reserved']]);
  assert.deepEqual(issuesFor({ 'mail.done': ['shift+Tab'] }), [['mail.done', 'reserved']]);
  assert.deepEqual(issuesFor({ 'list.selectAll': ['meta+a'] }), [], 'its own default');
  assert.deepEqual(
    issuesFor({ 'compose.keepSuggestion': ['Tab'] }),
    [],
    'Tab is Keep suggestion’s own default',
  );
  assert.deepEqual(issuesFor({ 'mail.done': ['meta+shift+'] }), [['mail.done', 'invalidChord']]);
});

test('a remapped command keeps the field rule only for chords that do not type', () => {
  const registry = wiredRegistry();
  assert.deepEqual(
    registry.configure({
      ...DEFAULT_KEY_PREFS,
      keymap: { 'compose.send': ['meta+o'], 'compose.bold': ['q'] },
    }),
    [],
  );
  const ctx = context(['global', 'compose'], { focus: 'text' });
  assert.equal(registry.resolve(keydown('o', { metaKey: true }), ctx)?.commandId, 'compose.send');
  assert.equal(registry.resolve(keydown('q'), ctx), null, 'a single key never fires in the body');
});

test('Done and Later stay off in the Done place whatever keys they are remapped to', () => {
  const registry = wiredRegistry();
  const issues = registry.configure({
    ...DEFAULT_KEY_PREFS,
    keymap: { 'mail.done': ['g', 'ArrowRight'], 'done.moveToHome': ['e'] },
  });
  assert.deepEqual(issues, []);
  const done = context(['global', 'list', 'done']);
  assert.equal(registry.resolve(keydown('g'), done), null);
  assert.equal(registry.resolve(keydown('e'), done)?.commandId, 'done.moveToHome');
  assert.equal(registry.resolve(keydown('g'), context(['global', 'list']))?.commandId, 'mail.done');
  const palette = registry
    .commandsForPalette(context(['global', 'list', 'done', 'palette']))
    .map(e => e.id);
  assert.ok(!palette.includes('mail.done') && !palette.includes('mail.later'));
});

test('the sheet says how to open a selected email: Return or O, and a second click', () => {
  const lists = buildSheet(wiredRegistry()).find(s => s.id === 'lists');
  const open = lists?.rows.find(r => r.id === 'mail.open');
  assert.match(open?.keys ?? '', /Return/);
  assert.match(open?.keys ?? '', /O/);
  assert.ok(lists?.rows.some(r => r.kind === 'pointer' && r.keys === 'Click it again'));
});

test('a remapped Undo still answers ⌘Z and never names it', () => {
  const registry = wiredRegistry();
  registry.configure({ ...DEFAULT_KEY_PREFS, keymap: { 'app.undo': [{ chord: 'ctrl+u' }] } });
  const list = context(['global', 'list']);
  assert.equal(registry.resolve(keydown('u', { ctrlKey: true }), list)?.commandId, 'app.undo');
  assert.equal(registry.resolve(keydown('z', { metaKey: true }), list)?.commandId, 'app.undo');
  assert.equal(registry.resolve(keydown('z'), list), null, 'plain Z was replaced');
  assert.equal(registry.describeKeys('app.undo'), '⌃U');
});

test('⌘Z undoes like Z, but never inside a text field, and ⇧⌘Z is not undo', () => {
  const registry = wiredRegistry();
  const list = context(['global', 'list']);
  const field = context(['global', 'compose'], { focus: 'text' });
  assert.equal(registry.resolve(keydown('z'), list)?.commandId, 'app.undo');
  assert.equal(registry.resolve(keydown('z', { metaKey: true }), list)?.commandId, 'app.undo');
  assert.equal(registry.resolve(keydown('z', { metaKey: true }), field), null);
  assert.equal(registry.resolve(keydown('z', { metaKey: true, shiftKey: true }), list), null);
  assert.equal(registry.describeKeys('app.undo'), 'Z', 'hints and toasts still say Z');
});
