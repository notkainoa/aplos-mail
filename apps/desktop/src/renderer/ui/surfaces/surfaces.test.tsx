// Surfaces family: static render checks of structure, copy, ARIA and states, with demo and worst-case data.
// Run from the repo root: npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/ui/surfaces/surfaces.test.tsx

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import type { MenuEntry, PaneTools } from '../props';
import { AccountSwitcher, Menu, NavHead, PageHead, Pane, Text } from './index';
import {
  SUBJECT_300,
  EMAIL_80,
  CJK,
  RTL,
  noop,
  render,
  textOf,
  assertClean,
  count,
  assertIdRefs,
  assertIconButtonsLabelled,
  TOOLS,
  header,
} from './fixtures.test';

/* ───────────── Pane ───────────── */
describe('Pane', () => {
  it('main pane: back + crumb left, three tools then Ask and the calendar button right, keys from the registry', () => {
    const html = render(
      <Pane kind="main" label="Home" header={header()}>
        <p>Body</p>
      </Pane>,
    );
    assert.match(
      html,
      /^<section class="ui-pane" data-kind="main" data-region="main" aria-label="Home">/,
    );
    assert.match(html, /<header class="ui-pane__head">/);
    assert.ok(!html.includes('data-scrolled'), 'no hairline before scroll');
    assert.match(html, /aria-label="Back"/);
    assert.match(textOf(html), /Home 1 of 16/);
    for (const label of ['Previous email', 'Next email', 'More', 'Today'])
      assert.match(html, new RegExp(`aria-label="${label}"`));
    assert.match(html, /aria-label="Next email"[^>]*disabled=""/);
    // Ask: speech bubble + visible "Ask", tooltip names the scope; calendar button carries ⇧A.
    assert.match(html, /data-icon="bubble"[\s\S]*?<span class="ui-part-button__label">Ask<\/span>/);
    assert.match(textOf(html), /Ask about this email A/);
    assert.match(textOf(html), /Today ⇧A/);
    assert.match(textOf(html), /Back Esc/);
    assert.match(textOf(html), /More \. bookmark, trash, forward, why it’s here/);
    // order: tools, Ask, Today
    const order = [
      'Previous email',
      'Next email',
      'aria-label="More"',
      '>Ask<',
      'aria-label="Today"',
    ].map(s => html.indexOf(s));
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
    );
    assert.match(html, /<div class="ui-pane__body">.*Body/);
    assertIconButtonsLabelled(html);
    assertIdRefs(html);
    assertClean(html);
  });

  it('shows the subject instead of the crumb once the summary scrolls away, without the position', () => {
    const html = render(
      <Pane
        kind="main"
        label="Reader"
        header={header({
          crumb: {
            label: 'Home',
            position: { index: 1, of: 16 },
            subject: SUBJECT_300,
            showSubject: true,
          },
        })}
      >
        x
      </Pane>,
    );
    assert.ok(html.includes(SUBJECT_300));
    assert.ok(!textOf(html).includes('1 of 16'));
    assert.match(html, /data-subject="true"/);
  });

  it('a centred position is its own element on the header row, not inside the crumb', () => {
    const html = render(
      <Pane
        kind="main"
        label="Home"
        header={header({
          crumb: { label: 'Home', position: { index: 1, of: 6 }, centrePosition: true },
        })}
      >
        x
      </Pane>,
    );
    assert.match(html, /<span class="ui-pane__pos-centre">1 of 6<\/span>/);
    assert.doesNotMatch(html, /ui-pane__crumb-pos/, 'the crumb button area carries no counter');
    assert.match(html, /<span class="ui-pane__crumb-text">Home<\/span>/);
  });

  it('Ask in mail scope and the pressed states', () => {
    const html = render(
      <Pane
        kind="main"
        label="Home"
        header={header({
          lead: undefined,
          crumb: undefined,
          tools: [],
          ask: { pressed: true, scope: 'mail', onPress: noop },
          today: { pressed: true, onPress: noop },
        })}
      >
        x
      </Pane>,
    );
    assert.match(textOf(html), /Ask about your mail A/);
    assert.equal(count(html, 'aria-pressed="true"'), 2);
    assert.equal(count(html, /<button/g), 2, 'only Ask and the calendar button');
  });

  it('bulk selection replaces the left side: count, Done · Later · Trash with hint keys, More, clear', () => {
    for (const [n, shown] of [
      [3, '3 selected'],
      [0, '0 selected'],
      [9999, '9,999 selected'],
    ] as const) {
      const html = render(
        <Pane
          kind="main"
          label="All mail"
          header={header({
            bulk: {
              count: n,
              actions: [
                { label: 'Done', icon: 'check', commandId: 'mail.done', onSelect: noop },
                { label: 'Later', icon: 'clock', commandId: 'mail.later', onSelect: noop },
                { label: 'Trash', icon: 'trash', commandId: 'mail.trash', onSelect: noop },
              ],
              onMore: noop,
              onClear: noop,
            },
          })}
        >
          x
        </Pane>,
      );
      assert.ok(html.includes(`>${shown}</span>`));
      assert.match(html, new RegExp(`role="group" aria-label="${shown}"`));
      assert.ok(!html.includes('aria-label="Back"'), 'bulk replaces the lead');
      for (const v of ['Done', 'Later', 'Trash']) assert.ok(html.includes(`>${v}</span>`));
      assert.ok(
        count(html, 'data-reveal="hint"') >= 3,
        'action keys only in the show-all-hints mode',
      );
      assert.match(html, /aria-label="Clear the selection"/);
      assertIconButtonsLabelled(html);
      assertClean(html);
    }
  });

  it('the dock pane draws no header; the fatal pane has none', () => {
    const dock = render(
      <Pane kind="dock" label="Ask">
        Dock
      </Pane>,
    );
    assert.equal(
      dock,
      '<section class="ui-pane" data-kind="dock" data-region="dock" aria-label="Ask">Dock</section>',
    );
    const bare = render(
      <Pane kind="main" label="Aplos">
        Fatal
      </Pane>,
    );
    assert.ok(!bare.includes('<header'));
  });

  it('the dock pane wraps its contents, so a resized dock never dead-spaces or clips', () => {
    const css = readFileSync(new URL('./surfaces.css', import.meta.url), 'utf8');
    const rule = /\.ui-pane\[data-kind='dock'\]\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    assert.match(
      rule,
      /width:\s*fit-content/,
      'the pane follows the aside, whose width AskDock owns',
    );
  });

  it('the tools tuple refuses a fourth tool at compile time', () => {
    // @ts-expect-error four tools is not a PaneTools
    const four: PaneTools = [...TOOLS, TOOLS[0]];
    assert.equal(four.length, 4);
  });
});

/* ───────────── PageHead, NavHead, AccountSwitcher, Text ───────────── */
describe('PageHead', () => {
  it('date label on the left, page controls right-aligned, never a heading', () => {
    const html = render(
      <PageHead lead={{ kind: 'dateLabel', label: 'October 2026', range: 'October 25 – 31' }}>
        <button type="button">Today</button>
      </PageHead>,
    );
    assert.match(html, /data-lead="dateLabel"/);
    assert.match(textOf(html), /October 2026 October 25 – 31 Today/);
    assert.match(html, /ui-page-head__controls/);
    assert.doesNotMatch(html, /<h[1-6]/);
  });
  it('a field lead, or controls alone', () => {
    assert.match(
      render(<PageHead lead={{ kind: 'field', field: <input aria-label="Search" /> }} />),
      /ui-page-head__field"><input aria-label="Search"/,
    );
    assert.equal(
      render(
        <PageHead>
          <span>x</span>
        </PageHead>,
      ),
      '<div class="ui-page-head"><div class="ui-page-head__controls"><span>x</span></div></div>',
    );
  });
});

describe('NavHead', () => {
  it('a quiet group label with an id for aria-labelledby', () => {
    assert.equal(
      render(<NavHead label="Mail" id="nav-mail" />),
      '<div class="ui-nav-head" id="nav-mail">Mail</div>',
    );
    assert.ok(render(<NavHead label={CJK} />).includes(CJK));
  });
});

describe('AccountSwitcher', () => {
  it('monogram, name, chevron, menu wiring and the "Switch account" tooltip', () => {
    const html = render(
      <AccountSwitcher
        label="All accounts"
        monogram="A"
        open={false}
        menuId="acct-menu"
        onOpen={noop}
      />,
    );
    assert.match(html, /aria-haspopup="menu" aria-expanded="false" aria-controls="acct-menu"/);
    assert.match(html, /data-state="closed"/);
    assert.match(html, /ui-account-switcher__mono" aria-hidden="true">A</);
    assert.match(textOf(html), /All accounts .*Switch account/);
    assert.match(html, /data-icon="chevron-down"/);
    assertIdRefs(html);
    assertClean(html);
  });
  it('open, an 80-character address and a two-letter cap on the monogram', () => {
    const html = render(
      <AccountSwitcher label={EMAIL_80} monogram="Alex" open menuId="m" onOpen={noop} />,
    );
    assert.match(html, /aria-expanded="true"/);
    assert.match(html, /data-state="open"/);
    assert.ok(html.includes(EMAIL_80));
    assert.match(html, /aria-hidden="true">Al</);
  });
});

describe('Text', () => {
  it('maps variants to elements, roles and default tones', () => {
    const cases = [
      ['display', 'h1', 'ink'],
      ['heading', 'h1', 'ink'],
      ['title', 'p', 'ink'],
      ['lede', 'p', 'dim'],
      ['label', 'p', 'dim'],
      ['small', 'p', 'dim'],
      ['caption', 'p', 'dim'],
    ] as const;
    for (const [variant, el, tone] of cases) {
      const html = render(<Text variant={variant}>You handled 12 emails.</Text>);
      assert.equal(
        html,
        `<${el} class="ui-text" data-variant="${variant}" data-tone="${tone}">You handled 12 emails.</${el}>`,
      );
    }
  });
  it('as, tone, id and a leading icon; RTL and CJK pass through', () => {
    const html = render(
      <Text variant="small" as="span" tone="ink-2" icon="lock" id="lock-line">
        Saved in Keychain on this Mac. Never shown again.
      </Text>,
    );
    assert.match(
      html,
      /^<span class="ui-text" data-variant="small" data-tone="ink-2" data-icon="true" id="lock-line"><svg[^>]*data-icon="lock"/,
    );
    assert.ok(
      render(
        <Text variant="label" as="h2">
          {RTL}
        </Text>,
      ).startsWith('<h2'),
    );
    assert.ok(render(<Text variant="title">{CJK}</Text>).includes(CJK));
  });
});

/* ───────────── Menu, Popover ───────────── */
const ACCOUNT_ENTRIES: MenuEntry[] = [
  { kind: 'label', label: 'Accounts' },
  { kind: 'item', id: 'all', label: 'All accounts', swatch: ['sky', 'hill'] },
  {
    kind: 'item',
    id: 'gmail',
    label: 'alex.moreno@gmail.com',
    swatch: 'sky',
    detail: 'Google needs you to sign in again.',
    inlineAction: { label: 'Reconnect', tone: 'danger', onSelect: noop },
  },
  { kind: 'item', id: 'fern', label: 'alex@fernworks.studio', swatch: 'hill', aside: 'Synced' },
  { kind: 'separator' },
  { kind: 'item', id: 'add', label: 'Add an account', icon: 'plus' },
];

describe('Menu', () => {
  it('renders nothing while closed', () => {
    assert.equal(
      render(
        <Menu
          open={false}
          anchor={null}
          label="Accounts"
          entries={ACCOUNT_ENTRIES}
          onSelect={noop}
          onClose={noop}
        />,
      ),
      '',
    );
  });

  it('takes an id for aria-controls, and two items with one colour log no duplicate-key warning', () => {
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    let html: string;
    try {
      html = render(
        <Menu
          id="account-menu"
          open
          anchor={null}
          label="Accounts"
          entries={[
            { kind: 'item', id: 'a', label: 'One', swatch: ['sky', 'sky'] },
            { kind: 'item', id: 'b', label: 'Two', swatch: 'sky' },
          ]}
          onSelect={noop}
          onClose={noop}
        />,
      );
    } finally {
      console.error = original;
    }
    assert.match(html, /<div id="account-menu" role="menu"/);
    assert.equal(count(html, 'data-color="sky"'), 3);
    assert.deepEqual(errors, []);
    const switcher = render(
      <AccountSwitcher label="All" monogram="A" open menuId="account-menu" onOpen={noop} />,
    );
    assert.match(switcher, /aria-controls="account-menu"/);
  });

  it('the account menu: label, stacked dots, detail with an inline Reconnect, aside, separator', () => {
    const html = render(
      <Menu
        open
        anchor={null}
        label="Accounts"
        entries={ACCOUNT_ENTRIES}
        activeId="gmail"
        onSelect={noop}
        onClose={noop}
      />,
    );
    assert.match(
      html,
      /role="menu" aria-label="Accounts" aria-activedescendant="[^"]+-gmail" tabindex="-1"/,
    );
    assert.equal(count(html, 'role="menuitem"'), 4);
    assert.equal(count(html, 'role="separator"'), 1);
    assert.match(html, /role="presentation" class="ui-menu__label">Accounts</);
    assert.equal(count(html, /data-color="(sky|hill)"/g), 4);
    assert.match(html, /data-active="true" data-detail="true"/);
    assert.match(textOf(html), /Google needs you to sign in again\. Reconnect/);
    // The inline Reconnect is a pointer duplicate; keys reach it with → and the item is named by its visible words and described by the key hint.
    assert.match(html, /aria-hidden="true" class="ui-menu__inline" data-tone="danger"/);
    assert.match(
      html,
      /role="menuitem" aria-labelledby="([^"]+)-gmail-label \1-gmail-detail" aria-describedby="\1-gmail-hint"/,
    );
    assert.match(
      html,
      /class="ui-sr-only" id="[^"]+-gmail-hint">Press Right Arrow to reconnect\.</,
    );
    assert.match(html, /role="menu"[^>]*data-state="open"/);
    assert.match(html, /ui-menu__aside" id="[^"]+-fern-aside">Synced</);
    assert.ok(!html.includes('data-placed'), 'unplaced until measured');
    assertIdRefs(html);
    assertClean(html, ['alex.moreno@gmail.com', 'alex@fernworks.studio']);
  });

  it('picker mode: menuitemradio with one aria-checked and a check mark', () => {
    const entries: MenuEntry[] = ['Groq', 'OpenAI', 'Claude'].map(label => ({
      kind: 'item',
      id: label.toLowerCase(),
      label,
    }));
    const html = render(
      <Menu
        open
        anchor={null}
        label="Provider"
        entries={entries}
        checkedId="groq"
        onSelect={noop}
        onClose={noop}
      />,
    );
    assert.equal(count(html, 'role="menuitemradio"'), 3);
    assert.equal(count(html, 'aria-checked="true"'), 1);
    assert.equal(count(html, 'aria-checked="false"'), 2);
    assert.equal(count(html, 'data-icon="check"'), 1);
  });

  it('numbered: digits 1–9 only, keycaps from the registry, danger and disabled items', () => {
    const entries: MenuEntry[] = [
      {
        kind: 'item',
        id: 'date',
        label: 'Set a date',
        icon: 'calendar',
        commandId: 'mail.setDate',
      },
      { kind: 'item', id: 'trash', label: 'Trash', icon: 'trash', danger: true },
      { kind: 'item', id: 'off', label: 'Not available', disabled: true },
      ...Array.from({ length: 9 }, (_, i): MenuEntry => ({
        kind: 'item',
        id: `x${i}`,
        label: i === 0 ? SUBJECT_300 : `Option ${i}`,
      })),
    ];
    const html = render(
      <Menu
        open
        anchor={null}
        label="More"
        entries={entries}
        numbered
        activeId="off"
        onSelect={noop}
        onClose={noop}
      />,
    );
    for (let d = 1; d <= 9; d++)
      assert.ok(html.includes(`<span class="ui-menu__num" aria-hidden="true">${d}</span>`));
    assert.ok(!html.includes('<span class="ui-menu__num" aria-hidden="true">10</span>'));
    assert.equal(count(html, '<span class="ui-menu__num" aria-hidden="true"></span>'), 3);
    assert.match(html, /<kbd class="ui-part-kbd">D<\/kbd>/);
    assert.match(html, /data-tone="danger"/);
    assert.match(html, /aria-disabled="true"/);
    assert.ok(
      !html.includes('aria-activedescendant'),
      'a disabled item is never the active descendant',
    );
  });
});
