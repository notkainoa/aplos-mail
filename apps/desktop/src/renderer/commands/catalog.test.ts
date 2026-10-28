import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTEXT_BLOCKS, COMMANDS, CONTROLS } from './catalog';
import { chordId } from './keys';
import { contextLine, createRegistry, findConflicts } from './registry';
import { buildSheet } from './sheet';
import { context, wiredRegistry } from './testing';
import { DEFAULT_KEY_PREFS, type CommandSpec, type ContextName } from './types';

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
  firstSync: true,
};

const BANNED_PHRASES = [
  'todo',
  'hide all',
  'hold to talk',
  'swipe through them',
  'ask me anything',
  'magic',
  'ai-powered',
  'be here now',
  'sent with',
  'smart',
  'copilot',
  'beta',
];

const BANNED_ICON_PARTS = ['sparkle', 'wand', 'star', 'brain', 'robot', 'bot', 'apple.intelligence'];

test('the catalog has no duplicate chord per context', () => {
  const registry = createRegistry(COMMANDS, { controls: CONTROLS, blocks: CONTEXT_BLOCKS });
  const guardOf = (id: string) => registry.get(id)?.spec.onlyWhen;
  assert.deepEqual(findConflicts(registry.bindings(), guardOf), []);
});

test('a second command on S in lists is rejected, naming both (today’s keys.s double assignment)', () => {
  const twin: CommandSpec = { id: 'home.stack', label: 'Open the stack', keys: ['s'], contexts: ['list'], group: 'Go to' };
  assert.throws(
    () => createRegistry([...COMMANDS, twin], { controls: CONTROLS, blocks: CONTEXT_BLOCKS }),
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
  const registry = createRegistry(COMMANDS, { controls: CONTROLS, blocks: CONTEXT_BLOCKS });
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
  const sheetContexts = new Set<ContextName>(['global', 'list', 'home', 'oneByOne', 'done', 'reader', 'compose', 'ask', 'calendar', 'palette', 'menu', 'datePicker', 'dialog']);
  for (const b of registry.bindings()) {
    if (b.commandId === null || !sheetContexts.has(b.context)) continue;
    assert.ok(listed.has(b.commandId), `${b.commandId} is missing from the sheet`);
  }
});

test('the sheet includes ⌃5, ⌃7, ⌃8, ⌘K and ⌘/ (baseline defect 5)', () => {
  const keys = buildSheet(wiredRegistry()).flatMap((s) => s.rows.map((r) => r.keys));
  for (const wanted of ['⌃5', '⌃7', '⌃8', '⌘K', '⌘/']) assert.ok(keys.includes(wanted), wanted);
});

test('⌃1–8 go to Home, Later, All mail, Drafts, Sent, Calendar, Trash, Spam', () => {
  const registry = wiredRegistry();
  const expected = ['nav.home', 'nav.later', 'nav.allMail', 'nav.drafts', 'nav.sent', 'nav.calendar', 'nav.trash', 'nav.spam'];
  expected.forEach((id, i) => {
    assert.equal(registry.describeKeys(id), `⌃${i + 1}`, id);
  });
});

test('no label, prompt or undo text uses a banned phrase or an exclamation mark', () => {
  const texts = [
    ...COMMANDS.flatMap((c) => [c.label, c.confirm?.prompt ?? '', c.undo?.label ?? '']),
    ...CONTROLS.map((c) => c.label),
  ];
  for (const text of texts) {
    assert.ok(!text.includes('!'), `"${text}" has an exclamation mark`);
    for (const phrase of BANNED_PHRASES) {
      assert.ok(!new RegExp(`\\b${phrase}\\b`, 'i').test(text), `"${text}" contains "${phrase}"`);
    }
  }
});

test('no icon is a sparkle, wand, star, brain or robot; the magnifier is only for search', () => {
  for (const c of COMMANDS) {
    if (!c.icon) continue;
    for (const part of BANNED_ICON_PARTS) assert.ok(!c.icon.includes(part), `${c.id} uses ${c.icon}`);
    if (c.icon === 'magnifyingglass') assert.match(c.label, /search/i, c.id);
  }
  assert.equal(COMMANDS.find((c) => c.id === 'ask.open')?.icon, 'text.bubble');
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
