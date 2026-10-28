import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMANDS, CONTROLS, DISABLED_IN, conflicts, createAppRegistry } from './catalog';
import { BANNED_PHRASES, copyProblem } from './copy';
import { chordId, parseChord, RESERVED_CHORDS, reservedReason } from './keys';
import { keyPrefsFromUi } from './prefs';
import { contextLine, createRegistry, findConflicts } from './registry';
import {
  createSettingsTable,
  parseSettingRoute,
  settingRoute,
  type SettingEntry,
} from './settings';
import { UI_ICON_FOR_COMMAND, uiIconFor } from './icons';
import { createHoldTracker } from './hold';
import { buildSheet, SHEET_POINTER_ROWS, SHEET_SECTIONS } from './sheet';
import { context, keydown, wiredRegistry } from './testing';
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
    [['mail.done', 'E or →']],
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

function issuesFor(keymap: Keymap) {
  return wiredRegistry()
    .configure({ ...DEFAULT_KEY_PREFS, keymap })
    .map(i => [i.commandId, i.reason]);
}

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
  assert.deepEqual(issuesFor({ 'list.selectAll': ['meta+a'] }), [], 'its own default');
  assert.deepEqual(issuesFor({ 'mail.done': ['meta+shift+'] }), [['mail.done', 'invalidChord']]);
});

test('a remapped command keeps the field rule only for chords that do not type', () => {
  const registry = wiredRegistry();
  assert.deepEqual(
    registry.configure({
      ...DEFAULT_KEY_PREFS,
      keymap: { 'compose.send': ['meta+s'], 'compose.bold': ['q'] },
    }),
    [],
  );
  const ctx = context(['global', 'compose'], { focus: 'text' });
  assert.equal(registry.resolve(keydown('s', { metaKey: true }), ctx)?.commandId, 'compose.send');
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

test('attachments stack: detaching the newest handler restores the previous one', () => {
  const registry = createAppRegistry();
  const ran: string[] = [];
  const detachList = registry.attach('mail.done', { run: () => void ran.push('list') });
  const detachReader = registry.attach('mail.done', { run: () => void ran.push('reader') });
  const ctx = context(['global', 'list']);
  registry.run('mail.done', ctx);
  detachReader();
  assert.equal(registry.isEnabled('mail.done', ctx), true);
  registry.run('mail.done', ctx);
  detachReader();
  registry.run('mail.done', ctx);
  detachList();
  assert.equal(registry.run('mail.done', ctx).status, 'unhandled');
  assert.deepEqual(ran, ['reader', 'list', 'list']);
});

test('run hands back the handler’s promise and reports failures', async () => {
  const reported: unknown[] = [];
  const registry = createAppRegistry(undefined, error => reported.push(error));
  registry.attach('mail.done', { run: () => Promise.reject(new Error('offline')) });
  const result = registry.run('mail.done', context(['global', 'list']));
  assert.equal(result.status, 'ran');
  if (result.status === 'ran') await assert.rejects(result.done, /offline/);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(reported.length, 1);
  registry.attach('mail.later', {
    run: () => {
      throw new Error('boom');
    },
  });
  assert.equal(registry.run('mail.later', context(['global', 'list'])).status, 'failed');
  assert.equal(reported.length, 2);
});

test('destructive commands ask first; bulk-scoped ones only for several items', () => {
  const registry = wiredRegistry();
  const one = registry.run('mail.trash', context(['global', 'list'], { selection: ['a'] }));
  assert.equal(one.status, 'ran');
  const many = registry.run('mail.trash', context(['global', 'list'], { selection: ['a', 'b'] }));
  assert.equal(many.status, 'confirm');
  const confirmed = registry.run(
    'mail.trash',
    context(['global', 'list'], { selection: ['a', 'b'] }),
    { confirmed: true },
  );
  assert.equal(confirmed.status, 'ran');
  assert.equal(registry.run('compose.discard', context(['global', 'compose'])).status, 'confirm');
});

test('the palette context line names its target, whatever kind it is', () => {
  assert.equal(
    contextLine({ kind: 'thread', id: 't1', title: 'Drew Bell', detail: 'October illustrations' }),
    'For: Drew Bell · October illustrations',
  );
  assert.equal(
    contextLine({ kind: 'event', id: 'e1', title: 'Design review', detail: 'Thu 2:00 PM' }),
    'For: Design review · Thu 2:00 PM',
  );
  assert.equal(
    contextLine({ kind: 'account', id: 'a1', title: 'jordan@gmail.com' }),
    'For: jordan@gmail.com',
  );
  assert.equal(
    contextLine({ kind: 'draft', id: 'd1', title: 'Draft to Mina' }),
    'For: Draft to Mina',
  );
  assert.equal(
    contextLine({
      kind: 'setting',
      id: 'setting.mail.undoSeconds',
      title: 'Undo send',
      detail: 'Mail',
    }),
    'For: Undo send · Mail',
  );
  assert.equal(
    contextLine({ kind: 'plan', id: 'p1', title: 'Dinner with Mina', detail: 'Sat 7:00 PM' }),
    'For: Dinner with Mina · Sat 7:00 PM',
  );
  assert.equal(contextLine({ kind: 'calendar', id: 'c1', title: 'Work' }), 'For: Work');
  assert.equal(
    contextLine({ kind: 'provider', id: 'groq', title: 'Groq', detail: 'AI' }),
    'For: Groq · AI',
  );
  assert.equal(
    contextLine({ kind: 'conversation', id: 'v1', title: 'Flights in November' }),
    'For: Flights in November',
  );
  assert.equal(contextLine(null, 3), 'For: 3 selected');
  assert.equal(contextLine(null), '');
});

test('a confirm carries title, prompt and confirm label, and promptFor names the target', () => {
  const reported: string[] = [];
  const registry = createAppRegistry(undefined, error => reported.push((error as Error).message));
  registry.attach('compose.discard', {
    run: () => undefined,
    promptFor: () => '“Re: October illustrations” is removed from Drafts.',
  });
  assert.deepEqual(registry.run('compose.discard', context(['global', 'compose'])), {
    status: 'confirm',
    title: 'Discard this draft?',
    prompt: '“Re: October illustrations” is removed from Drafts.',
    confirmLabel: 'Discard',
    destructive: true,
  });
  registry.attach('compose.discard', { run: () => undefined, promptFor: () => 'Gone forever!' });
  const fallback = registry.run('compose.discard', context(['global', 'compose']));
  assert.equal(fallback.status === 'confirm' && fallback.prompt, 'This can’t be undone.');
  assert.equal(reported.length, 1);
  for (const c of COMMANDS.filter(x => x.confirm))
    assert.notEqual(c.confirm!.confirmLabel, 'OK', c.id);
});

test('nested palette pages: a command with children opens a page, rows can open further pages', async () => {
  const registry = createAppRegistry();
  const moved: string[] = [];
  registry.attach('mail.moveToLabel', {
    run: () => undefined,
    children: () => [
      { id: 'receipts', label: 'Receipts', run: () => void moved.push('receipts') },
      {
        id: 'clients',
        label: 'Clients',
        children: () => [{ id: 'acme', label: 'Acme', run: () => void moved.push('acme') }],
      },
    ],
  });
  const ctx = context(['global', 'list']);
  const entry = registry
    .commandsForPalette(context(['global', 'list', 'palette']))
    .find(e => e.id === 'mail.moveToLabel');
  assert.equal(entry?.page, true);
  const top = registry.run('mail.moveToLabel', ctx);
  assert.equal(top.status, 'page');
  if (top.status !== 'page') return;
  assert.equal(top.title, 'Move to label', 'the breadcrumb drops the ellipsis');
  const nested = registry.runChild(top.items[1], ctx);
  assert.equal(nested.status === 'page' && nested.title, 'Clients');
  if (nested.status !== 'page') return;
  const ran = registry.runChild(nested.items[0], ctx);
  assert.equal(ran.status, 'ran');
  if (ran.status === 'ran') await ran.done;
  assert.deepEqual(moved, ['acme']);
  const unlabelled: CommandSpec = {
    id: 'mail.page2',
    label: 'Move to label',
    keys: [],
    contexts: ['list'],
    group: 'Actions',
    page: true,
  };
  assert.throws(
    () => createRegistry([...COMMANDS, unlabelled], { controls: CONTROLS }),
    /ends its label/,
  );
});

test('the catalog declares the gap list’s nested pages, and the page flag always matches the handler', () => {
  const pages = COMMANDS.filter(c => c.page).map(c => c.label);
  assert.deepEqual(pages, [
    'Move to label…',
    'Later until…',
    'Set due date…',
    'Use another provider…',
  ]);
  for (const c of COMMANDS) assert.equal(c.label.endsWith('…'), c.page === true, c.id);
  const registry = createAppRegistry();
  assert.throws(
    () => registry.attach('mail.later', { run: () => undefined, children: () => [] }),
    /only a command with page: true/,
  );
  assert.throws(
    () => registry.attach('mail.laterUntil', { run: () => undefined }),
    /needs children/,
  );
  assert.throws(
    () => registry.attach('palette.choose', { run: () => undefined, children: () => [] }),
    /only a command with page: true/,
  );
});

test('a nested row with confirm asks first, then runs on ⇧Return', async () => {
  const registry = createAppRegistry();
  const removed: string[] = [];
  const row = {
    id: 'remove.a1',
    label: 'jordan@gmail.com',
    confirm: {
      destructive: true,
      title: 'Remove jordan@gmail.com?',
      prompt: 'Its mail leaves this Mac.',
      confirmLabel: 'Remove',
    },
    run: () => void removed.push('a1'),
  };
  const ctx = context(['global', 'list']);
  assert.deepEqual(registry.runChild(row, ctx), {
    status: 'confirm',
    title: 'Remove jordan@gmail.com?',
    prompt: 'Its mail leaves this Mac.',
    confirmLabel: 'Remove',
    destructive: true,
  });
  assert.deepEqual(removed, []);
  const ran = registry.runChild(row, ctx, { confirmed: true });
  assert.equal(ran.status, 'ran');
  if (ran.status === 'ran') await ran.done;
  assert.deepEqual(removed, ['a1']);
});

const UNDO_SEND: SettingEntry = {
  id: 'setting.mail.undoSeconds',
  label: 'Undo send',
  section: 'mail',
  keywords: ['delay', 'unsend'],
  rowAnchor: 'undoSeconds',
};

test('settings rows registered at load are palette entries in Settings, routed to their row', () => {
  const settings = createSettingsTable();
  const registry = createRegistry(COMMANDS, { controls: CONTROLS, settings });
  registry.attach('app.settings', { run: () => undefined });
  settings.register(UNDO_SEND);
  const entries = registry.commandsForPalette(context(['global', 'list', 'palette']));
  const row = entries.find(e => e.id === UNDO_SEND.id);
  assert.deepEqual(
    row && {
      group: row.group,
      route: row.route,
      detail: row.detail,
      keys: row.keys,
      keywords: row.keywords,
    },
    {
      group: 'Settings',
      route: 'settings/mail#undoSeconds',
      detail: 'Mail',
      keys: '',
      keywords: ['delay', 'unsend'],
    },
  );
  const settingsGroup = entries.filter(e => e.group === 'Settings').map(e => e.id);
  assert.deepEqual(settingsGroup, ['app.settings', UNDO_SEND.id], 'commands first, then rows');
  assert.ok(
    entries.findIndex(e => e.id === UNDO_SEND.id) === entries.length - 1,
    'Settings is the last group',
  );
  assert.deepEqual(registry.run(UNDO_SEND.id, context(['global', 'list'])), {
    status: 'navigate',
    route: 'settings/mail#undoSeconds',
  });
  assert.equal(
    registry.commandsForPalette(context(['onboarding', 'palette'])).length,
    0,
    'no settings rows in the onboarding window',
  );
  assert.deepEqual(parseSettingRoute(settingRoute(UNDO_SEND)), {
    section: 'mail',
    row: 'undoSeconds',
  });
  assert.deepEqual(parseSettingRoute('settings/ai'), { section: 'ai' });
  assert.equal(parseSettingRoute('settings/nowhere#x'), null);
});

test('settings entries are checked: id shape, anchor, copy and clashes', () => {
  const settings = createSettingsTable();
  const remove = settings.register(UNDO_SEND);
  assert.doesNotThrow(
    () => settings.register({ ...UNDO_SEND }),
    'an identical re-registration is a hot reload',
  );
  assert.throws(() => settings.register({ ...UNDO_SEND, label: 'Unsend' }), /Duplicate setting id/);
  assert.throws(
    () => settings.register({ ...UNDO_SEND, id: 'mail.undo' }),
    /setting id must be setting\.mail\.undoSeconds/,
  );
  assert.throws(
    () => settings.register({ ...UNDO_SEND, id: 'setting.mail.9', rowAnchor: '9' }),
    /bad row anchor/,
  );
  assert.throws(() => settings.register({ ...UNDO_SEND, label: 'Smart undo' }), /smart/);
  remove();
  assert.equal(settings.list().length, 0);
  const clash: CommandSpec = {
    id: 'setting.mail.x',
    label: 'X',
    keys: [],
    contexts: ['global'],
    group: 'Settings',
  };
  assert.throws(() => createRegistry([clash]), /belong to setting entries/);
});

test('reserved chords: system and text-editing chords are refused unless they are the command’s own default', () => {
  for (const spec of RESERVED_CHORDS)
    assert.equal(chordId(parseChord(spec)), spec, `${spec} is canonical`);
  for (const wanted of [
    'meta+c',
    'meta+v',
    'meta+x',
    'meta+a',
    'meta+z',
    'shift+meta+z',
    'meta+q',
    'meta+w',
    'meta+h',
    'meta+m',
    'meta+,',
    'meta+Tab',
  ]) {
    assert.ok(RESERVED_CHORDS.includes(wanted), wanted);
  }
  assert.equal(reservedReason(parseChord('meta+q')), 'system');
  assert.equal(reservedReason(parseChord('meta+c')), 'text');
  assert.equal(reservedReason(parseChord('meta+k')), null);
  assert.deepEqual(issuesFor({ 'mail.done': ['meta+q'] }), [['mail.done', 'reserved']]);
  assert.deepEqual(issuesFor({ 'mail.done': ['meta+Tab'] }), [['mail.done', 'reserved']]);
  assert.deepEqual(issuesFor({ 'app.settings': ['meta+,'] }), [], '⌘, is Settings’ own default');
});

test('conflicts(keymap) checks a keymap without touching a live registry and names who has the chord', () => {
  const issues = conflicts({ 'mail.bookmark': ['l'] });
  assert.deepEqual(
    issues.map(i => [i.commandId, i.reason, i.with]),
    [['mail.bookmark', 'conflict', ['mail.later']]],
  );
  assert.deepEqual(
    conflicts({ 'mail.done': ['l', 'ArrowRight'], 'mail.later': ['e', 'ArrowLeft'] }),
    [],
  );
});

test('keyPrefsFromUi maps the stored ui fields onto the registry prefs', () => {
  assert.deepEqual(
    keyPrefsFromUi({
      singleKeys: false,
      holdMs: 300,
      swipeDirection: 'doneLeft',
      keymap: { 'mail.done': ['y'] },
    }),
    {
      singleKeyShortcuts: false,
      holdThresholdMs: 300,
      swapTriageArrows: true,
      keymap: { 'mail.done': ['y'] },
    },
  );
  assert.equal(
    keyPrefsFromUi({ singleKeys: true, holdMs: 250, swipeDirection: 'doneRight', keymap: {} })
      .swapTriageArrows,
    false,
  );
});

test('Home, All mail and Drafts have icons, and every catalog icon maps to the UI set', () => {
  const icon = (id: string) => COMMANDS.find(c => c.id === id)?.icon;
  assert.deepEqual(
    ['nav.home', 'nav.allMail', 'nav.drafts'].map(id => uiIconFor(icon(id))),
    ['home', 'tray', 'file'],
  );
  for (const c of COMMANDS)
    if (c.icon) assert.ok(UI_ICON_FOR_COMMAND[c.icon], `${c.id}: ${c.icon}`);
  assert.equal(uiIconFor(undefined), undefined);
});

test('registry.release tells the hold command when the key comes up', () => {
  const registry = wiredRegistry();
  const ctx = context(['global', 'list']);
  const seen: string[] = [];
  registry.attach('mail.dictateReply', {
    run: () => undefined,
    release: (_ctx, release) => {
      seen.push(`${release.commandId}:${release.phase}:${release.upgraded}`);
    },
  });
  const tracker = createHoldTracker(250);
  const key = { key: 'r', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  tracker.down(key, 'mail.dictateReply', 0);
  tracker.tick(300);
  const result = registry.release(tracker.up(key, 400), ctx);
  assert.equal(result.status, 'ran');
  assert.deepEqual(seen, ['mail.dictateReply:hold:true']);
  assert.equal(registry.release(null, ctx).status, 'unhandled');
  assert.equal(
    registry.release(
      { key: 'r', commandId: 'mail.done', phase: 'tap', upgraded: false, heldMs: 5 },
      ctx,
    ).status,
    'unhandled',
  );
  assert.equal(
    registry.release(
      { key: 'r', commandId: 'no.such', phase: 'tap', upgraded: false, heldMs: 5 },
      ctx,
    ).status,
    'unknown',
  );
});
