/**
 * The palette's pure logic (DESIGN §7.9; plan 30 U7 acceptance 1): the scoring order, first open, 1–9 only on an
 * empty field, nested pages, the destructive confirm defaulting to Cancel, recents, and palette reach (every
 * catalog command the registry offers is listable for a context that includes it).
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/palette/*.test.ts*'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAppRegistry,
  DEFAULT_KEY_PREFS,
  type CommandContext,
  type PaletteEntry,
} from '../../commands';
import {
  applyRun,
  choose,
  confirmKey,
  escape,
  matchLabel,
  openPalette,
  paletteView,
  pickNumber,
  pushRecent,
  rank,
  setQuery,
  suggestedEntries,
  togglePalette,
  type Candidate,
  type PaletteInput,
} from './palette.model';

const entry = (id: string, over: Partial<PaletteEntry> = {}): PaletteEntry => ({
  id,
  label: id,
  group: 'Actions',
  suggested: false,
  keys: '',
  keywords: [],
  destructive: false,
  page: false,
  ...over,
});

const CTX: CommandContext = {
  stack: ['global', 'list'],
  target: { kind: 'thread', id: 't1', title: 'Drew Bell', detail: 'October illustrations' },
  selection: [],
  conditions: {},
  prefs: DEFAULT_KEY_PREFS,
  focus: 'control',
};

const input = (entries: readonly PaletteEntry[], recents: string[] = []): PaletteInput => ({
  ctx: CTX,
  entries,
  recents,
});

test('scoring order: exact, prefix, word boundary, then subsequence', () => {
  const candidates: Candidate[] = [
    { id: 'sub', label: 'This red apple has dents', keywords: [] },
    { id: 'word', label: 'Move the thread', keywords: [] },
    { id: 'prefix', label: 'Threads', keywords: [] },
    { id: 'exact', label: 'Thread', keywords: [] },
  ];
  const ranked = rank('thread', candidates);
  assert.deepEqual(
    ranked.map(r => r.candidate.id),
    ['exact', 'prefix', 'word', 'sub'],
  );
  assert.equal(ranked[0].tier, 4);
  assert.equal(ranked[1].tier, 3);
  assert.equal(ranked[2].tier, 2);
  assert.equal(ranked[3].tier, 1);
});

test('subsequence needs four letters, each starting a word or following the last match', () => {
  // "sett": scattered letters across "Send the question" and friends are out; "Settings" still wins.
  assert.equal(matchLabel('sett', 'Send the question'), null);
  assert.equal(matchLabel('sett', 'Run the suggested action'), null);
  assert.equal(matchLabel('sett', 'Set a date'), null);
  assert.equal(matchLabel('sett', 'Open Settings')?.tier, 2);
  // Under four letters there is no subsequence tier at all; a run spanning words is fine.
  assert.equal(matchLabel('thr', 'This red apple'), null);
  assert.equal(matchLabel('thread', 'This red apple has dents')?.tier, 1);
  // Word starts and continuing letters are the only scattered picks allowed.
  assert.equal(matchLabel('mtl', 'Move to label…'), null);
  assert.equal(matchLabel('mtla', 'Move to label…')?.tier, 1);
  assert.equal(matchLabel('mtlb', 'Move to label…'), null);
  assert.equal(matchLabel('open', 'Open Settings')?.tier, 3);
});

test("typing 'sett' puts Open Settings first and none of the scattered-letter rows", () => {
  const registry = createAppRegistry();
  for (const spec of registry.list())
    registry.attach(spec.id, {
      run: () => undefined,
      ...(spec.page ? { children: () => [] } : {}),
    });
  const entries = registry.commandsForPalette({
    ...CTX,
    stack: ['global', 'list', 'ask'],
    conditions: { askText: true },
  });
  const ranked = rank('sett', entries);
  assert.equal(ranked[0]?.candidate.id, 'app.settings');
  for (const id of ['mail.suggested', 'mail.setDate', 'ask.submit'])
    assert.ok(!ranked.some(r => r.candidate.id === id), id);
  // The gate: 'Send the question' lists only while the dock field has text.
  const noText = registry.commandsForPalette({
    ...CTX,
    stack: ['global', 'list', 'ask'],
    conditions: {},
  });
  assert.ok(!noText.some(e => e.id === 'ask.submit'));
  assert.ok(!noText.some(e => e.id === 'ask.searchAllMail'));
  assert.ok(entries.some(e => e.id === 'ask.submit'));
});

test('a keyword hit counts as a word-boundary match and bolds nothing', () => {
  const ranked = rank('archive', [{ id: 'done', label: 'Done', keywords: ['archive', 'finish'] }]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].tier, 2);
  assert.deepEqual(ranked[0].indices, []);
});

test('a recent command is boosted but never beats an exact match', () => {
  const candidates: Candidate[] = [
    { id: 'a', label: 'Move the thread', keywords: [] },
    { id: 'b', label: 'Thread', keywords: [] },
  ];
  const ranked = rank('thread', candidates, ['a']);
  assert.equal(ranked[0].candidate.id, 'b');
});

test('matchLabel is case- and accent-insensitive', () => {
  assert.equal(matchLabel('cafe', 'Café notes')?.tier, 3);
  assert.equal(matchLabel('move to label', 'Move to label…')?.tier, 4);
});

test('a suggestion that is Reply or Done shows once, not beside the plain command it names', () => {
  const run = entry('mail.suggested', { label: 'Reply to Jordan Park', suggested: true });
  const reply = entry('mail.reply', { label: 'Reply', suggested: true });
  const done = entry('mail.done', { label: 'Done', suggested: true });
  const later = entry('mail.later', { label: 'Later', suggested: true });
  assert.deepEqual(
    suggestedEntries([run, reply, done, later]).map(e => e.id),
    ['mail.suggested', 'mail.done', 'mail.later'],
  );
  const markDone = { ...run, label: 'Mark done' };
  assert.deepEqual(
    suggestedEntries([markDone, reply, done, later]).map(e => e.id),
    ['mail.suggested', 'mail.reply', 'mail.later'],
  );
  assert.equal(suggestedEntries([reply, done]).length, 2, 'with no named suggestion both stay');
});

test('first open shows Suggested then Go to, at most nine rows', () => {
  const entries = [
    entry('mail.done', { label: 'Done', suggested: true, group: 'Actions' }),
    entry('mail.later', { label: 'Later', suggested: true, group: 'Actions' }),
    entry('nav.home', { label: 'Home', group: 'Go to' }),
    entry('nav.later', { label: 'Later', group: 'Go to' }),
    entry('nav.allMail', { label: 'All mail', group: 'Go to' }),
    entry('nav.calendar', { label: 'Calendar', group: 'Go to' }),
    entry('nav.done', { label: 'Done', group: 'Go to' }),
    entry('nav.drafts', { label: 'Drafts', group: 'Go to' }),
    entry('nav.sent', { label: 'Sent', group: 'Go to' }),
    entry('nav.trash', { label: 'Trash', group: 'Go to' }),
    entry('nav.spam', { label: 'Spam', group: 'Go to' }),
    entry('nav.search', { label: 'Search', group: 'Go to' }),
  ];
  const view = paletteView(openPalette(), input(entries));
  assert.deepEqual(
    view.sections.map(s => s.label),
    ['Suggested', 'Go to'],
  );
  assert.equal(view.order.length, 9);
});

test('Suggested is capped so first open never exceeds nine rows', () => {
  const entries = Array.from({ length: 12 }, (_, i) =>
    entry(`cmd.${i}`, { label: `Command ${i}`, suggested: true }),
  );
  const view = paletteView(openPalette(), input(entries));
  assert.equal(view.order.length, 9);
  assert.equal(view.sections.length, 1);
  assert.equal(view.sections[0].items.length, 9);
});

test('typing lists every entry plus the Ask row; a digit is then text, not a pick', () => {
  const entries = [entry('mail.done', { label: 'Done' }), entry('mail.later', { label: 'Later' })];
  const view = paletteView(setQuery(openPalette(), 'do'), input(entries));
  assert.equal(view.sections.length, 1);
  assert.equal(view.order.at(-1), 'palette-ask');
  assert.equal(view.targets.get('palette-ask')?.kind, 'ask');
  assert.equal(pickNumber({ ...openPalette(), query: 'do' }, view, 1), null);
});

test('1–9 pick the Nth row only while the field is empty', () => {
  const entries = [
    entry('a', { label: 'A', suggested: true }),
    entry('b', { label: 'B', suggested: true }),
  ];
  const state = openPalette();
  const view = paletteView(state, input(entries));
  assert.deepEqual(pickNumber(state, view, 1), { kind: 'command', id: 'a' });
  assert.equal(pickNumber(state, view, 0), null);
  assert.equal(pickNumber(state, view, 10), null);
  assert.equal(
    pickNumber(
      {
        ...state,
        confirm: {
          title: '',
          prompt: '',
          confirmLabel: '',
          destructive: true,
          target: { kind: 'command', id: 'a' },
        },
      },
      view,
      1,
    ),
    null,
  );
});

test('the context line names the target the commands run with', () => {
  const view = paletteView(
    openPalette(),
    input([entry('mail.done', { label: 'Done', suggested: true })]),
  );
  assert.equal(view.context, 'Drew Bell · October illustrations');
});

test('a nested page lists its children under a breadcrumb, and Esc restores the parent', () => {
  const base = openPalette();
  const page = applyRun(
    base,
    { kind: 'command', id: 'ask.useAnotherProvider' },
    {
      status: 'page',
      title: 'Use another provider',
      items: [{ id: 'groq', label: 'Groq', run: () => undefined }],
    },
  );
  const view = paletteView(page.state, input([]));
  assert.deepEqual(view.trail, ['Use another provider']);
  assert.equal(view.sections[0].items[0].label, 'Groq');
  const back = escape(page.state);
  assert.equal(back.closed, false);
  assert.equal(back.state.pages.length, 0);
  assert.equal(escape(back.state).closed, true);
});

test('a destructive run opens the confirm; Return cancels, ⇧Return confirms', () => {
  const ask = applyRun(
    openPalette(),
    { kind: 'command', id: 'compose.discard' },
    {
      status: 'confirm',
      title: 'Discard this draft?',
      prompt: 'This can’t be undone.',
      confirmLabel: 'Discard',
      destructive: true,
    },
  );
  assert.equal(ask.state.confirm?.destructive, true);
  assert.equal(confirmKey(ask.state.confirm!, false), 'cancel');
  assert.equal(confirmKey(ask.state.confirm!, true), 'confirm');
  // Esc leaves the confirm for the list; a second Esc closes.
  const out = escape(ask.state);
  assert.equal(out.state.confirm, undefined);
  assert.equal(out.closed, false);
});

test('ran and navigate close the palette and record the top-level command', () => {
  const ran = applyRun(
    openPalette(),
    { kind: 'command', id: 'mail.done' },
    {
      status: 'ran',
      done: Promise.resolve(),
    },
  );
  assert.equal(ran.closed, true);
  assert.equal(ran.recent, 'mail.done');
  const nav = applyRun(
    openPalette(),
    { kind: 'command', id: 'setting.mail.undo' },
    {
      status: 'navigate',
      route: 'settings/mail#undo',
    },
  );
  assert.equal(nav.closed, true);
  // A nested-page row is not a recent: the page's command already was.
  const child = applyRun(
    openPalette(),
    { kind: 'child', child: { id: 'x', label: 'X' }, page: 1 },
    {
      status: 'ran',
      done: Promise.resolve(),
    },
  );
  assert.equal(child.recent, undefined);
});

test('a disabled or unhandled answer keeps the palette open', () => {
  const applied = applyRun(
    openPalette(),
    { kind: 'command', id: 'mail.done' },
    { status: 'disabled' },
  );
  assert.equal(applied.closed, false);
  assert.equal(applied.state.open, true);
});

test('⌘K toggles; recents land newest first, deduped, capped', () => {
  assert.equal(togglePalette(openPalette()).open, false);
  assert.equal(togglePalette({ open: false, query: '', pages: [] }).open, true);
  const recents = pushRecent(['a', 'b', 'c'], 'b');
  assert.deepEqual(recents, ['b', 'a', 'c']);
});

test('choose maps a row id back to its run target', () => {
  const view = paletteView(
    openPalette(),
    input([entry('mail.done', { label: 'Done', suggested: true })]),
  );
  assert.deepEqual(choose(view, view.order[0]), { kind: 'command', id: 'mail.done' });
  assert.equal(choose(view, 'no-such-row'), null);
});

test('every catalog command the registry offers is reachable by name', () => {
  const registry = createAppRegistry();
  for (const spec of registry.list())
    registry.attach(spec.id, {
      run: () => undefined,
      ...(spec.page ? { children: () => [] } : {}),
    });
  const everywhere: CommandContext = {
    stack: [
      'global',
      'search',
      'list',
      'home',
      'oneByOne',
      'done',
      'reader',
      'compose',
      'ask',
      'calendar',
      'settings',
    ],
    target: null,
    selection: [],
    conditions: {},
    prefs: DEFAULT_KEY_PREFS,
    focus: 'control',
  };
  const entries = registry.commandsForPalette(everywhere);
  const offered = registry.list().filter(s => s.palette !== false);
  const ids = new Set(entries.map(e => e.id));
  const missing = offered.filter(s => !ids.has(s.id));
  // Commands that name a context the stack lacks stay unlisted (they ask for nothing there).
  const allowed = missing.filter(s => !s.contexts.some(c => everywhere.stack.includes(c)));
  assert.deepEqual(
    allowed.map(s => s.id),
    [],
  );
  // Reachable by name: every offered entry matches its own label at least as a prefix.
  for (const e of entries) assert.ok(rank(e.label, [e]).length > 0, e.id);
});

test('no sparkle, wand or star glyph anywhere in the palette or search modules', async () => {
  const { readFileSync } = await import('node:fs');
  const { readdirSync } = await import('node:fs');
  // Escapes, so this file itself contains none of the glyphs it checks for.
  const banned = new RegExp(
    ['\\u2728', '\\u{1FA84}', '\\u2B50', '\\u{1F31F}', '\\u{1F4AB}'].join('|'),
    'u',
  );
  for (const dir of ['palette', 'search']) {
    const here = new URL(`../${dir}/`, import.meta.url);
    for (const file of readdirSync(here)) {
      if (!/\.(ts|tsx|css)$/.test(file)) continue;
      assert.ok(!banned.test(readFileSync(new URL(file, here), 'utf8')), `${dir}/${file}`);
    }
  }
});
