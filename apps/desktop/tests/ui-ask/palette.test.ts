// ui-ask: the ⌘K palette's model (DESIGN §7.9, §8 Palette; plan 30 U7 acceptance 1).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  createAppRegistry,
  DEFAULT_KEY_PREFS,
  registerSetting,
  type CommandContext,
  type ContextName,
  type PaletteEntry,
  type Registry,
  type TargetKind,
  type TargetSummary,
} from '../../src/renderer/commands';
import { COMMANDS, CONTROLS } from '../../src/renderer/commands/internal';
import {
  applyRun,
  ASK_ROW_ID,
  choose,
  confirmKey,
  escape,
  matchLabel,
  moveActive,
  openPalette,
  paletteContext,
  paletteView,
  pickNumber,
  pushRecent,
  rank,
  RECENT_BOOST,
  setQuery,
  type PaletteState,
  type RunTarget,
} from '../../src/renderer/screens/palette/palette.model';
import { Palette } from '../../src/renderer/ui/ask';

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rand: () => number, list: readonly T[]): T =>
  list[Math.floor(rand() * list.length)];

function ctx(stack: readonly ContextName[], extra: Partial<CommandContext> = {}): CommandContext {
  return {
    stack,
    target: null,
    selection: [],
    conditions: {},
    prefs: DEFAULT_KEY_PREFS,
    focus: 'none',
    ...extra,
  };
}

/** The app registry with a no-op handler on every command and control (an empty page for page commands). */
function wired(): Registry {
  const registry = createAppRegistry();
  for (const spec of [...COMMANDS, ...CONTROLS]) {
    const page = 'page' in spec && spec.page === true;
    registry.attach(
      spec.id,
      page ? { run: () => undefined, children: () => [] } : { run: () => undefined },
    );
  }
  return registry;
}

/* ───────────── an independent oracle for the scoring order (written apart from the model) ───────────── */

function oracleTier(
  query: string,
  label: string,
  keywords: readonly string[],
): { tier: number; exact: boolean } | null {
  const q = query.trim().replace(/\s+/g, ' ').toLowerCase();
  if (q === '') return null;
  const l = label.toLowerCase();
  const core = l.replace(/[….]+$/, '');
  let tier = 0;
  if (core !== '' && core === q.replace(/[….]+$/, '')) tier = 4;
  else if (l.startsWith(q)) tier = 3;
  else {
    for (let i = 1; i < l.length; i += 1) {
      if (!/[a-z0-9]/.test(l[i - 1]) && /[a-z0-9]/.test(l[i]) && l.startsWith(q, i)) {
        tier = 2;
        break;
      }
    }
    if (tier === 0) {
      let at = 0;
      for (const ch of l) if (ch === q[at]) at += 1;
      if (at === q.length) tier = 1;
    }
  }
  if (tier < 2 && keywords.some(k => k.toLowerCase().startsWith(q))) tier = 2;
  return tier === 0 ? null : { tier, exact: tier === 4 };
}

function oracleRank(
  query: string,
  items: readonly { id: string; label: string; keywords: readonly string[] }[],
  recents: readonly string[],
): string[] {
  return items
    .map((item, order) => ({
      item,
      order,
      hit: oracleTier(query, item.label, item.keywords),
      recent: recents.indexOf(item.id),
    }))
    .filter(x => x.hit !== null)
    .sort((a, b) => {
      const ea = a.hit!.tier + (a.recent >= 0 ? 1.5 : 0);
      const eb = b.hit!.tier + (b.recent >= 0 ? 1.5 : 0);
      if (a.hit!.exact !== b.hit!.exact) return a.hit!.exact ? -1 : 1;
      if (ea !== eb) return eb - ea;
      const ra = a.recent < 0 ? 1e9 : a.recent;
      const rb = b.recent < 0 ? 1e9 : b.recent;
      if (ra !== rb) return ra - rb;
      if (a.hit!.tier !== b.hit!.tier) return b.hit!.tier - a.hit!.tier;
      return a.order - b.order;
    })
    .map(x => x.item.id);
}

describe('ui-ask: palette scoring', () => {
  test('exact > prefix > word boundary > subsequence', () => {
    assert.equal(matchLabel('later', 'Later')?.tier, 4);
    assert.equal(matchLabel('move to label', 'Move to label…')?.tier, 4);
    assert.equal(matchLabel('lat', 'Later')?.tier, 3);
    assert.equal(matchLabel('label', 'Move to label…')?.tier, 2);
    assert.equal(matchLabel('mtl', 'Move to label…')?.tier, 1);
    assert.equal(matchLabel('xyz', 'Later'), null);
    const order = rank('lat', [
      { id: 'sub', label: 'Select all text', keywords: [] },
      { id: 'word', label: 'Move later', keywords: [] },
      { id: 'prefix', label: 'Later until…', keywords: [] },
      { id: 'exact', label: 'Lat', keywords: [] },
    ]).map(s => s.candidate.id);
    assert.deepEqual(order, ['exact', 'prefix', 'word', 'sub']);
  });

  test('accent- and case-insensitive; bold indices are code points of the label', () => {
    const hit = matchLabel('resume', 'Résumé review');
    assert.equal(hit?.tier, 3);
    assert.deepEqual(hit?.indices, [0, 1, 2, 3, 4, 5]);
    const cjk = matchLabel('予定', '今日の予定');
    assert.equal(cjk?.tier, 1);
    assert.deepEqual(cjk?.indices, [3, 4]);
  });

  test('a keyword finds a command at word level and bolds nothing ("archive" finds Done)', () => {
    const [first] = rank('archive', [{ id: 'mail.done', label: 'Done', keywords: ['archive'] }]);
    assert.equal(first.tier, 2);
    assert.deepEqual(first.indices, []);
  });

  test('recents get a boost but never beat an exact match', () => {
    const items = [
      { id: 'exact', label: 'Later', keywords: [] },
      { id: 'recentPrefix', label: 'Later until…', keywords: [] },
      { id: 'recentSub', label: 'Clear all text', keywords: [] },
      { id: 'word', label: 'Move later', keywords: [] },
    ];
    const order = rank('later', items, ['recentSub', 'recentPrefix']).map(s => s.candidate.id);
    assert.equal(order[0], 'exact');
    assert.ok(order.indexOf('recentPrefix') < order.indexOf('word'));
    assert.ok(RECENT_BOOST < 4 - 1, 'a recent subsequence never reaches exact');
  });

  test('palette scoring oracle – fuzzed against an independent oracle (2000 queries)', () => {
    const rand = prng(2026);
    const words = [
      'later',
      'label',
      'move',
      'to',
      'done',
      'mail',
      'all',
      'ask',
      'about',
      'reply',
      'search',
      'settings',
      'undo',
      'send',
      'draft',
      'calendar',
      'today',
      'home',
      'trash',
      'a',
      'set',
      'due',
      'date…',
    ];
    for (let round = 0; round < 2000; round += 1) {
      const items = Array.from({ length: 4 + Math.floor(rand() * 10) }, (_, i) => {
        const label = Array.from({ length: 1 + Math.floor(rand() * 3) }, () =>
          pick(rand, words),
        ).join(' ');
        const capitalised = label[0].toUpperCase() + label.slice(1);
        const keywords = rand() < 0.3 ? [pick(rand, words)] : [];
        return { id: `c${i}`, label: capitalised, keywords };
      });
      const source = pick(rand, items).label.toLowerCase();
      const start = Math.floor(rand() * source.length);
      const query = pick(rand, [
        source,
        source.slice(0, 1 + Math.floor(rand() * source.length)),
        source.slice(start, start + 1 + Math.floor(rand() * 4)),
        [...source].filter(() => rand() < 0.4).join(''),
        pick(rand, words),
        'zq',
      ]);
      const recents = items.filter(() => rand() < 0.25).map(i => i.id);
      const got = rank(query, items, recents).map(s => s.candidate.id);
      const want = oracleRank(query, items, recents);
      assert.deepEqual(
        got,
        want,
        `query "${query}" over ${JSON.stringify(items.map(i => i.label))} recents ${recents}`,
      );
      // The bold letters spell the query, in order, for a label match.
      for (const scored of rank(query, items, recents)) {
        if (scored.indices.length === 0) continue;
        const spelled = scored.indices
          .map(i => [...scored.candidate.label][i])
          .join('')
          .toLowerCase();
        const bare = (text: string) => text.replace(/ /g, '').replace(/[….]+$/, '');
        assert.equal(bare(spelled), bare(query.trim().toLowerCase()));
      }
    }
  });
});

describe('ui-ask: palette reach and groups', () => {
  test('palette reach – every catalog command is reachable in the palette by its label (U7 acc. 1)', () => {
    const registry = wired();
    const missing: string[] = [];
    for (const spec of COMMANDS) {
      if (spec.palette === false) continue;
      const conditions = spec.onlyWhen ? { [spec.onlyWhen]: true } : {};
      const context = ctx(['global', ...spec.contexts], { conditions });
      const entries = registry.commandsForPalette(context);
      const view = paletteView(openPalette(spec.label), { ctx: context, entries, recents: [] });
      const item = view.sections.flatMap(s => s.items).find(i => i.commandId === spec.id);
      if (!item) {
        missing.push(spec.id);
        continue;
      }
      assert.deepEqual(choose(view, item.id), { kind: 'command', id: spec.id });
      // Typing the full label puts it among the exact matches, ahead of every non-exact row.
      const first = view.sections[0].items[0];
      assert.equal(
        matchLabel(spec.label, first.label)?.tier,
        4,
        `${spec.id}: "${first.label}" ranked first`,
      );
    }
    assert.deepEqual(missing, []);
  });

  test('palette settings reach – a registered Settings row is a palette entry that opens its route', () => {
    const remove = registerSetting({
      id: 'setting.mail.undoSecondsTest',
      label: 'Undo send delay test',
      section: 'mail',
      rowAnchor: 'undoSecondsTest',
      keywords: ['unsend'],
    });
    try {
      const registry = wired();
      const context = ctx(['global', 'list']);
      const entries = registry.commandsForPalette(context);
      const view = paletteView(openPalette('unsend'), { ctx: context, entries, recents: [] });
      const item = view.sections[0].items.find(i => i.commandId === 'setting.mail.undoSecondsTest');
      assert.ok(item);
      assert.equal(item.detail, 'Mail');
      const target = choose(view, item.id);
      assert.deepEqual(target, { kind: 'command', id: 'setting.mail.undoSecondsTest' });
      const result = registry.run('setting.mail.undoSecondsTest', context);
      assert.deepEqual(result, { status: 'navigate', route: 'settings/mail#undoSecondsTest' });
      assert.equal(applyRun(openPalette('unsend'), target!, result).closed, true);
    } finally {
      remove();
    }
  });

  test('palette first open groups – only Suggested and Go to, at most nine rows, numbered in order', () => {
    const registry = wired();
    const target: TargetSummary = {
      kind: 'thread',
      id: 't1',
      title: 'Drew Bell',
      detail: 'October illustrations',
    };
    const context = ctx(['global', 'list', 'home'], { target });
    const entries = registry.commandsForPalette(context);
    const view = paletteView(openPalette(), { ctx: context, entries, recents: [] });
    assert.deepEqual(
      view.sections.map(s => s.label),
      ['Suggested', 'Go to'],
    );
    assert.ok(view.order.length <= 9);
    assert.deepEqual(view.sections[1].items.map(i => i.label).slice(0, 2), ['Home', 'Later']);
    assert.equal(view.context, 'Drew Bell · October illustrations');
    // A place you went to recently comes first under Go to.
    const recent = paletteView(openPalette(), { ctx: context, entries, recents: ['nav.calendar'] });
    assert.equal(recent.sections[1].items[0].commandId, 'nav.calendar');
  });

  test('typing lists one ranked list and ends with the Ask row; no match leaves only the Ask row', () => {
    const registry = wired();
    const context = ctx(['global', 'list']);
    const entries = registry.commandsForPalette(context);
    const view = paletteView(openPalette('lat'), { ctx: context, entries, recents: [] });
    const items = view.sections[0].items;
    assert.equal(items[items.length - 1].id, ASK_ROW_ID);
    assert.equal(items[items.length - 1].label, 'Ask about “lat”');
    assert.deepEqual(choose(view, ASK_ROW_ID), { kind: 'ask', question: 'lat' });
    const none = paletteView(openPalette('when is the dentist'), {
      ctx: context,
      entries,
      recents: [],
    });
    assert.deepEqual(none.order, [ASK_ROW_ID]);
  });

  test('palette 1-9 only when empty – a digit picks a row only while the field is empty', () => {
    const registry = wired();
    const context = ctx(['global', 'list']);
    const entries = registry.commandsForPalette(context);
    const empty = openPalette();
    const view = paletteView(empty, { ctx: context, entries, recents: [] });
    assert.deepEqual(pickNumber(empty, view, 2), choose(view, view.order[1]));
    const typed = setQuery(empty, 'l');
    assert.equal(
      pickNumber(typed, paletteView(typed, { ctx: context, entries, recents: [] }), 2),
      null,
    );
    assert.equal(pickNumber(empty, view, 0), null);
    assert.equal(pickNumber(empty, view, 10), null);
  });

  test('↓/↑ wrap around the rows', () => {
    const view = { order: ['a', 'b', 'c'], activeId: 'c' } as unknown as ReturnType<
      typeof paletteView
    >;
    assert.equal(moveActive(openPalette(), view, 1).activeId, 'a');
    assert.equal(moveActive(openPalette(), { ...view, activeId: 'a' }, -1).activeId, 'c');
  });
});

describe('ui-ask: palette pages, confirm, Esc', () => {
  const children = [
    { id: 'label-receipts', label: 'Receipts', detail: 'k@example.com', run: () => undefined },
    { id: 'label-hollow', label: 'Hollow Creek', run: () => undefined },
  ];

  test('palette nested page breadcrumb – "Move to label…" shows a trail and the labels; Esc returns one level', () => {
    const registry = createAppRegistry();
    registry.attach('mail.moveToLabel', { run: () => undefined, children: () => children });
    const context = ctx(['global', 'list']);
    const entries = registry.commandsForPalette(context);
    let state: PaletteState = setQuery(openPalette(), 'label');
    const view = paletteView(state, { ctx: context, entries, recents: [] });
    const row = view.sections[0].items.find(i => i.commandId === 'mail.moveToLabel')!;
    assert.equal(row.opensPage, true);
    const target = choose(view, row.id)!;
    state = applyRun(state, target, registry.run('mail.moveToLabel', context)).state;
    const page = paletteView(state, { ctx: context, entries, recents: [] });
    assert.deepEqual(page.trail, ['Move to label']);
    assert.deepEqual(
      page.sections[0].items.map(i => i.label),
      ['Receipts', 'Hollow Creek'],
    );
    const back = escape(state);
    assert.equal(back.closed, false);
    assert.equal(back.state.query, 'label');
    assert.deepEqual(back.state.pages, []);
    assert.equal(escape(back.state).closed, true);
  });

  test('palette destructive defaults to cancel – Return cancels, ⇧Return confirms; the live region says so', () => {
    const registry = createAppRegistry();
    registry.attach('compose.discard', { run: () => undefined });
    const context = ctx(['global', 'compose']);
    const target: RunTarget = { kind: 'command', id: 'compose.discard' };
    const result = registry.run('compose.discard', context);
    assert.equal(result.status, 'confirm');
    const state = applyRun(openPalette('discard'), target, result).state;
    assert.ok(state.confirm?.destructive);
    assert.equal(confirmKey(state.confirm!, false), 'cancel');
    assert.equal(confirmKey(state.confirm!, true), 'confirm');
    assert.equal(confirmKey({ destructive: false }, false), 'confirm');
    // Esc on the confirm goes back to the list, it never runs the command.
    const back = escape(state);
    assert.equal(back.closed, false);
    assert.equal(back.state.confirm, undefined);
    // The component draws Cancel first as the default row, and the confirm row in stamp ink with ⇧Return.
    const announced: string[] = [];
    const html = renderToStaticMarkup(
      createElement(Palette, {
        open: true,
        query: 'discard',
        onQueryChange: () => undefined,
        sections: [],
        onActiveChange: () => undefined,
        onRun: () => undefined,
        listboxId: 'pal',
        onBack: () => undefined,
        onClose: () => undefined,
        announce: m => announced.push(m),
        confirm: {
          question: state.confirm!.title,
          consequence: state.confirm!.prompt,
          confirmLabel: state.confirm!.confirmLabel,
          destructive: true,
          presentation: 'inline',
          onConfirm: () => undefined,
          onCancel: () => undefined,
        },
      }),
    );
    const cancelAt = html.indexOf('>Cancel<');
    const confirmAt = html.indexOf('>Discard<');
    assert.ok(cancelAt > 0 && confirmAt > cancelAt, 'Cancel is the first row');
    assert.match(html, /data-primary="true"[^>]*><span>Cancel/);
    assert.match(html, /data-tone="danger"/);
  });

  test('palette esc never navigates – over random walks, Esc only goes up a level or closes (U7 acc. 1)', () => {
    const rand = prng(99);
    const registry = createAppRegistry();
    registry.attach('mail.moveToLabel', {
      run: () => undefined,
      children: () => [
        { id: 'nested', label: 'More labels', children: () => children },
        ...children,
      ],
    });
    registry.attach('compose.discard', { run: () => undefined });
    const context = ctx(['global', 'list', 'compose']);
    const entries = registry.commandsForPalette(context);
    for (let walk = 0; walk < 300; walk += 1) {
      let state: PaletteState = openPalette();
      for (let i = 0; i < 12 && state.open; i += 1) {
        const action = pick(rand, ['type', 'page', 'confirm', 'esc', 'move']);
        if (action === 'type') state = setQuery(state, pick(rand, ['', 'l', 'label', 'disc']));
        else if (action === 'page') {
          const target: RunTarget = { kind: 'command', id: 'mail.moveToLabel' };
          state = applyRun(state, target, registry.run('mail.moveToLabel', context)).state;
        } else if (action === 'confirm') {
          const target: RunTarget = { kind: 'command', id: 'compose.discard' };
          state = applyRun(state, target, registry.run('compose.discard', context)).state;
        } else if (action === 'move') {
          state = moveActive(state, paletteView(state, { ctx: context, entries, recents: [] }), 1);
        } else {
          const depth = state.pages.length;
          const hadConfirm = Boolean(state.confirm);
          const result = escape(state);
          // Esc's whole effect is a smaller palette: no run, no route.
          assert.deepEqual(Object.keys(result).sort(), ['closed', 'state']);
          if (hadConfirm) assert.equal(result.state.pages.length, depth);
          else if (depth > 0) assert.equal(result.state.pages.length, depth - 1);
          else assert.equal(result.closed, true);
          state = result.state;
        }
      }
      // From anywhere, Esc closes within (pages + confirm + 1) presses.
      let presses = 0;
      while (state.open) {
        state = escape(state).state;
        presses += 1;
        assert.ok(presses <= 30);
      }
    }
    // And the keys agree: with the palette open, Esc is the palette's own Back, never the app's Go back.
    const app = wired();
    const esc = { key: 'Escape', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    for (const stack of [
      ['global', 'palette'],
      ['global', 'list', 'reader', 'palette'],
      ['global', 'ask', 'palette'],
    ] as ContextName[][]) {
      const hit = app.resolve(esc, ctx(stack, { focus: 'text' }));
      assert.equal(hit?.commandId, 'palette.back', stack.join('>'));
    }
  });

  test('palette context line truthful – over 30 contexts the line names the target the commands get, or is absent', () => {
    const rand = prng(30);
    const kinds: TargetKind[] = [
      'thread',
      'event',
      'plan',
      'calendar',
      'account',
      'draft',
      'setting',
      'provider',
      'conversation',
    ];
    const titles = [
      'Drew Bell',
      'Mina Cho',
      'Design review',
      'jordan@example.com',
      '',
      '   ',
      'Ünal Kaya',
      '山田 花子',
      'A'.repeat(120),
    ];
    const details = [undefined, 'October illustrations', 'Thu 2:00 PM', 'Mail', ''];
    const registry = wired();
    for (let i = 0; i < 30; i += 1) {
      const title = pick(rand, titles);
      const detail = pick(rand, details);
      const target: TargetSummary | null =
        rand() < 0.15
          ? null
          : {
              kind: pick(rand, kinds),
              id: `x${i}`,
              title,
              ...(detail !== undefined ? { detail } : {}),
            };
      const selection = rand() < 0.2 ? ['a', 'b', 'c'].slice(0, 1 + Math.floor(rand() * 3)) : [];
      const context = ctx(['global', 'list'], { target, selection });
      const view = paletteView(openPalette(), {
        ctx: context,
        entries: registry.commandsForPalette(context),
        recents: [],
      });
      if (selection.length > 1) assert.equal(view.context, `${selection.length} selected`);
      else if (!target || title.trim() === '')
        assert.equal(view.context, undefined, `target ${JSON.stringify(target)}`);
      else assert.equal(view.context, detail ? `${title} · ${detail}` : title);
      assert.equal(view.context, paletteContext(context));
    }
  });

  test('a run that ran closes the palette and records a recent; the Ask row records nothing', () => {
    const applied = applyRun(
      openPalette('lat'),
      { kind: 'command', id: 'mail.later' },
      { status: 'ran', done: Promise.resolve() },
    );
    assert.equal(applied.closed, true);
    assert.equal(applied.recent, 'mail.later');
    const ask = applyRun(openPalette('when'), { kind: 'ask', question: 'when' }, { status: 'ask' });
    assert.equal(ask.closed, true);
    assert.equal(ask.recent, undefined);
    assert.deepEqual(pushRecent(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
    assert.equal(
      pushRecent(
        Array.from({ length: 30 }, (_, i) => `c${i}`),
        'new',
      ).length,
      20,
    );
  });
});

/** The entries type stays the registry's own. */
export type _Entries = PaletteEntry;
