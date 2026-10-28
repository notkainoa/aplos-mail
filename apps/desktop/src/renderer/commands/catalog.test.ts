import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMANDS, CONTROLS, DISABLED_IN, createAppRegistry } from './catalog';
import { BANNED_PHRASES, copyProblem } from './copy';
import { chordId } from './keys';
import { contextLine, createRegistry, findConflicts } from './registry';
import { buildSheet, SHEET_POINTER_ROWS, SHEET_SECTIONS } from './sheet';
import { context, keydown, wiredRegistry } from './testing';
import { DEFAULT_KEY_PREFS, type CommandSpec, type ContextName, type Keymap } from './types';

const PALETTE_STACKS: readonly (readonly ContextName[])[] = [
  ['global'],
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
  firstSync: true,
};

const BANNED_ICON_PARTS = ['sparkle', 'wand', 'star', 'brain', 'robot', 'bot', 'apple.intelligence'];

test('the catalog has no duplicate chord per context', () => {
  assert.deepEqual(findConflicts(createAppRegistry().bindings()), []);
});

test('a second command on S in lists is rejected, naming both (today’s keys.s double assignment)', () => {
  const twin: CommandSpec = { id: 'home.stack', label: 'Open the stack', keys: ['s'], contexts: ['list'], group: 'Go to' };
  assert.throws(
    () => createRegistry([...COMMANDS, twin], { controls: CONTROLS, disabledIn: DISABLED_IN }),
    /S in list: home\.oneByOne, home\.stack/,
  );
});

test('the same chord in different contexts is an override, not a conflict', () => {
  const registry = wiredRegistry();
  const js = registry.bindings().filter((b) => chordId(b.chord) === 'j').map((b) => b.context);
  assert.deepEqual(js.sort(), ['calendar', 'list', 'reader']);
});

test('every command is palette-reachable from some context', () => {
  const registry = wiredRegistry();
  const reachable = new Set<string>();
  for (const stack of PALETTE_STACKS) {
    const ctx = context([...stack, 'palette'], { conditions: ALL_CONDITIONS, selection: ['a', 'b'] });
    for (const entry of registry.commandsForPalette(ctx)) reachable.add(entry.id);
  }
  const missing = COMMANDS.map((c) => c.id).filter((id) => !reachable.has(id));
  assert.deepEqual(missing, []);
});

test('the palette shows keycaps from the registry and hides commands without handlers', () => {
  const registry = createAppRegistry();
  registry.attach('mail.done', { run: () => undefined });
  const entries = registry.commandsForPalette(context(['global', 'list', 'home', 'palette']));
  assert.deepEqual(
    entries.map((e) => [e.id, e.keys]),
    [['mail.done', 'E or →']],
  );
  assert.ok(registry.missingHandlers().includes('mail.later'));
});

test('every bound command and control appears in the sheet with all its keys', () => {
  const registry = wiredRegistry();
  const sheet = buildSheet(registry);
  const listed = new Set(sheet.flatMap((s) => s.rows.map((r) => r.id)));
  const sheetContexts = new Set<ContextName>(SHEET_SECTIONS.flatMap((s) => s.contexts));
  for (const b of registry.bindings()) {
    if (!sheetContexts.has(b.context)) continue;
    assert.ok(listed.has(b.commandId), `${b.commandId} is missing from the sheet`);
  }
});

test('the sheet includes ⌃5, ⌃7, ⌃8, ⌘K and ⌘/ (baseline defect 5)', () => {
  const keys = buildSheet(wiredRegistry()).flatMap((s) => s.rows.map((r) => r.keys));
  for (const wanted of ['⌃5', '⌃7', '⌃8', '⌘K', '⌘/']) assert.ok(keys.includes(wanted), wanted);
});

test('the sheet writes keys the way DESIGN §8 and the mockups do', () => {
  const keys = buildSheet(wiredRegistry()).flatMap((s) => s.rows.map((r) => r.keys));
  for (const wanted of ['⌘⌥L', '⌘⌥R', '⌘⇧Return', '⌘⇧C', '⌘⇧A']) assert.ok(keys.includes(wanted), wanted);
});

test('⌃1–8 go to Home, Later, All mail, Drafts, Sent, Calendar, Trash, Spam', () => {
  const registry = wiredRegistry();
  const expected = ['nav.home', 'nav.later', 'nav.allMail', 'nav.drafts', 'nav.sent', 'nav.calendar', 'nav.trash', 'nav.spam'];
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
    ...COMMANDS.flatMap((c) => [c.label, c.confirm?.prompt ?? '', c.undo?.label ?? '', ...(c.keywords ?? [])]),
    ...CONTROLS.map((c) => c.label),
    ...SHEET_SECTIONS.map((s) => s.title),
    ...Object.values(SHEET_POINTER_ROWS).flatMap((rows) => rows.map((r) => r.label)),
  ];
  for (const text of texts) assert.equal(copyProblem(text), null);
});

test('a runtime label that breaks the voice falls back to the spec label and is reported', () => {
  const reported: string[] = [];
  const registry = createAppRegistry(undefined, (error, id) => reported.push(`${id}: ${(error as Error).message}`));
  registry.attach('mail.suggested', { run: () => undefined, labelFor: () => 'Add to your Todos' });
  const entry = registry.commandsForPalette(context(['global', 'list', 'palette'])).find((e) => e.id === 'mail.suggested');
  assert.equal(entry?.label, 'Run the suggested action');
  assert.equal(reported.length, 1);
  assert.match(reported[0], /todo/);
});

test('no icon is a sparkle, wand, star, brain or robot; the magnifier belongs to Search alone', () => {
  for (const c of COMMANDS) {
    if (!c.icon) continue;
    for (const part of BANNED_ICON_PARTS) assert.ok(!c.icon.includes(part), `${c.id} uses ${c.icon}`);
  }
  assert.deepEqual(
    COMMANDS.filter((c) => c.icon === 'magnifyingglass').map((c) => c.id),
    ['nav.search'],
  );
  assert.equal(COMMANDS.find((c) => c.id === 'ask.open')?.icon, 'text.bubble');
  assert.equal(COMMANDS.find((c) => c.id === 'done.moveToHome')?.icon, 'house');
});

test('remapping replaces defaults and reports conflicts instead of accepting them', () => {
  const registry = wiredRegistry();
  const issues = registry.configure({ ...DEFAULT_KEY_PREFS, keymap: { 'mail.bookmark': ['k'], 'mail.done': ['y'], 'no.such': ['q'] } });
  assert.deepEqual(
    issues.map((i) => [i.commandId, i.reason]),
    [
      ['no.such', 'unknownCommand'],
      ['mail.bookmark', 'conflict'],
    ],
  );
  assert.equal(registry.describeKeys('mail.bookmark'), 'B', 'the rejected remap keeps its default');
  assert.equal(registry.describeKeys('mail.done', ['list']), 'Y');
  const ctx = context(['global', 'list']);
  assert.equal(registry.resolve({ key: 'y', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, ctx)?.commandId, 'mail.done');
  assert.equal(registry.resolve({ key: 'e', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, ctx), null);
});

test('swapping E and L by remap is accepted', () => {
  const registry = wiredRegistry();
  const issues = registry.configure({ ...DEFAULT_KEY_PREFS, keymap: { 'mail.done': ['l'], 'mail.later': ['e'] } });
  assert.deepEqual(issues, []);
});

function issuesFor(keymap: Keymap) {
  return wiredRegistry().configure({ ...DEFAULT_KEY_PREFS, keymap }).map((i) => [i.commandId, i.reason]);
}

test('a remap one context would hide in another is reported as shadowed', () => {
  assert.deepEqual(issuesFor({ 'nav.search': ['j'] }), [['nav.search', 'shadowed']]);
  assert.deepEqual(issuesFor({ 'app.undo': ['e'] }), [['app.undo', 'shadowed']]);
  assert.deepEqual(issuesFor({ 'mail.bookmark': ['c'] }), [['mail.bookmark', 'shadowed']], 'B on C would hide New message in lists');
  assert.deepEqual(issuesFor({ 'mail.bookmark': ['t'] }), [], 'T is only Today in calendar, which never sits on a list');
  assert.deepEqual(issuesFor({ 'nav.back': ['Escape'] }), [], 'restating a default is not a remap');
});

test('a remap may set only chord and phase, and never a text-editing chord', () => {
  const sneaky = { 'mail.trash': [{ chord: 'x', inTextField: true, contexts: ['global'] }] } as unknown as Keymap;
  assert.deepEqual(issuesFor(sneaky), [['mail.trash', 'invalidEntry']]);
  assert.deepEqual(issuesFor({ 'mail.done': ['meta+c'] }), [['mail.done', 'reserved']]);
  assert.deepEqual(issuesFor({ 'mail.done': ['ctrl+k'] }), [['mail.done', 'reserved']]);
  assert.deepEqual(issuesFor({ 'list.selectAll': ['meta+a'] }), [], 'its own default');
  assert.deepEqual(issuesFor({ 'mail.done': ['meta+shift+'] }), [['mail.done', 'invalidChord']]);
});

test('a remapped command keeps the field rule only for chords that do not type', () => {
  const registry = wiredRegistry();
  assert.deepEqual(registry.configure({ ...DEFAULT_KEY_PREFS, keymap: { 'compose.send': ['meta+s'], 'compose.bold': ['q'] } }), []);
  const ctx = context(['global', 'compose'], { focus: 'text' });
  assert.equal(registry.resolve(keydown('s', { metaKey: true }), ctx)?.commandId, 'compose.send');
  assert.equal(registry.resolve(keydown('q'), ctx), null, 'a single key never fires in the body');
});

test('Done and Later stay off in the Done place whatever keys they are remapped to', () => {
  const registry = wiredRegistry();
  const issues = registry.configure({ ...DEFAULT_KEY_PREFS, keymap: { 'mail.done': ['g'], 'done.moveToHome': ['e'] } });
  assert.deepEqual(issues, []);
  const done = context(['global', 'list', 'done']);
  assert.equal(registry.resolve(keydown('g'), done), null);
  assert.equal(registry.resolve(keydown('e'), done)?.commandId, 'done.moveToHome');
  assert.equal(registry.resolve(keydown('g'), context(['global', 'list']))?.commandId, 'mail.done');
  const palette = registry.commandsForPalette(context(['global', 'list', 'done', 'palette'])).map((e) => e.id);
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
  const registry = createAppRegistry(undefined, (error) => reported.push(error));
  registry.attach('mail.done', { run: () => Promise.reject(new Error('offline')) });
  const result = registry.run('mail.done', context(['global', 'list']));
  assert.equal(result.status, 'ran');
  if (result.status === 'ran') await assert.rejects(result.done, /offline/);
  await new Promise((r) => setTimeout(r, 0));
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
  const confirmed = registry.run('mail.trash', context(['global', 'list'], { selection: ['a', 'b'] }), { confirmed: true });
  assert.equal(confirmed.status, 'ran');
  assert.equal(registry.run('compose.discard', context(['global', 'compose'])).status, 'confirm');
});

test('the palette context line names its target', () => {
  assert.equal(contextLine({ title: 'Drew Bell', detail: 'October illustrations' }), 'For: Drew Bell · October illustrations');
  assert.equal(contextLine(null, 3), 'For: 3 selected');
});
