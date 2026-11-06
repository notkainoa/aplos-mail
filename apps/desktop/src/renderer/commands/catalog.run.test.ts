import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMANDS, CONTROLS, conflicts, createAppRegistry } from './catalog';
import { chordId, parseChord, RESERVED_CHORDS, reservedReason } from './keys';
import { keyPrefsFromUi } from './prefs';
import { contextLine, createRegistry } from './registry';
import {
  createSettingsTable,
  parseSettingRoute,
  settingRoute,
  type SettingEntry,
} from './settings';
import { UI_ICON_FOR_COMMAND, uiIconFor } from './icons';
import { createHoldTracker } from './hold';
import { context, issuesFor, wiredRegistry } from './testing';
import { type CommandSpec } from './types';

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
    'Tab',
    'shift+Tab',
  ]) {
    assert.ok(RESERVED_CHORDS.includes(wanted), wanted);
  }
  assert.equal(reservedReason(parseChord('meta+q')), 'system');
  assert.equal(reservedReason(parseChord('meta+c')), 'text');
  assert.equal(reservedReason(parseChord('Tab')), 'navigation');
  assert.equal(reservedReason(parseChord('shift+Tab')), 'navigation');
  assert.equal(reservedReason(parseChord('meta+k')), null);
  assert.deepEqual(issuesFor({ 'mail.done': ['meta+q'] }), [['mail.done', 'reserved']]);
  assert.deepEqual(issuesFor({ 'mail.done': ['meta+Tab'] }), [['mail.done', 'reserved']]);
  assert.deepEqual(issuesFor({ 'app.settings': ['meta+,'] }), [], '⌘, is Settings’ own default');
  assert.deepEqual(
    issuesFor({ 'compose.keepSuggestion': ['Tab'] }),
    [],
    'Tab is Keep suggestion’s own default',
  );
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
      seen.push(`${release.commandId}:${release.phase}:${release.upgraded}:${release.ended}`);
    },
  });
  const tracker = createHoldTracker(250);
  const key = { key: 'r', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  tracker.down(key, 'mail.dictateReply', 0);
  tracker.tick(300);
  const result = registry.release(tracker.up(key, 400), ctx);
  assert.equal(result.status, 'ran');
  assert.deepEqual(seen, ['mail.dictateReply:hold:true:up']);
  // Esc after the same long hold reads differently: keep only upgraded && ended === 'up'.
  tracker.down(key, 'mail.dictateReply', 1000);
  tracker.tick(1300);
  registry.release(tracker.cancel(3000), ctx);
  assert.equal(seen[1], 'mail.dictateReply:hold:true:cancel');
  const keeps = (line: string) => line.endsWith(':true:up');
  assert.equal(keeps(seen[0]!), true);
  assert.equal(keeps(seen[1]!), false, 'Esc after an upgrade discards what was heard');
  assert.equal(registry.release(null, ctx).status, 'unhandled');
  assert.equal(
    registry.release(
      { key: 'r', commandId: 'mail.done', phase: 'tap', upgraded: false, heldMs: 5, ended: 'up' },
      ctx,
    ).status,
    'unhandled',
  );
  assert.equal(
    registry.release(
      { key: 'r', commandId: 'no.such', phase: 'tap', upgraded: false, heldMs: 5, ended: 'up' },
      ctx,
    ).status,
    'unknown',
  );
});
