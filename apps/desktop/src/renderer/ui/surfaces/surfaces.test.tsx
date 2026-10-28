// Surfaces family: static render checks of structure, copy, ARIA and states, with demo and worst-case data.
// Run from the repo root: npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/ui/surfaces/surfaces.test.tsx
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyProblem } from '../../commands/internal';
import type { MenuEntry, PaneHeaderProps, PaneTools, ToastData } from '../props';
import { AccountSwitcher, Confirm, Dialog, Menu, NavHead, PageHead, Pane, Popover, Puck, Text, Toast, ToastStack } from './index';
import { visibleToasts } from './ToastStack';

/* ───────────── worst-case data ───────────── */
const SUBJECT_300 = 'Two layout directions for the Hollow Creek site are ready and Jordan wants a pick by tomorrow so the build can start on Monday morning '.repeat(3).slice(0, 300);
const EMAIL_80 = `${'a'.repeat(62)}@${'b'.repeat(13)}.com`;
const CJK = '会議の議題について確認してください';
const RTL = 'مرحبا بكم في البريد';
const EMOJI = 'Parcel Trail 📦🎉';

/* ───────────── helpers ───────────── */
const noop = () => {};
const render = (el: ReactElement) => renderToStaticMarkup(el);
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
/** Visible and accessible text: tag text plus aria-label values. */
function textOf(html: string): string {
  const labels = [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
  return decode(`${html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ')} ${labels.join(' ')}`).replace(/\s+/g, ' ');
}
const BANNED_GLYPHS = /lucide-(sparkle|star|wand|brain|bot)|✨|⭐|🪄|🤖|🧠/i;
function assertClean(html: string, data: readonly string[] = []) {
  let text = textOf(html);
  for (const d of data) text = text.split(d).join(' ');
  assert.equal(copyProblem(text), null, `banned copy in: ${text}`);
  assert.doesNotMatch(html, BANNED_GLYPHS);
  assert.doesNotMatch(html, /style="(?![^"]*--)[^"]*"/, 'only custom properties may be inline');
}
function count(html: string, needle: string | RegExp): number {
  return typeof needle === 'string' ? html.split(needle).length - 1 : [...html.matchAll(needle)].length;
}
/** Every aria-describedby / aria-labelledby / aria-controls target id exists in the markup (controls may point outside). */
function assertIdRefs(html: string, attrs = ['aria-describedby', 'aria-labelledby', 'aria-activedescendant']) {
  for (const attr of attrs) {
    for (const m of html.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))) {
      for (const id of m[1].split(' ')) assert.ok(html.includes(`id="${id}"`), `${attr} → missing #${id}`);
    }
  }
}
/** Every icon-only button has an accessible name and a tooltip. */
function assertIconButtonsLabelled(html: string) {
  for (const m of html.matchAll(/<button[^>]*data-variant="icon"[^>]*>/g)) {
    const tag = m[0];
    if (tag.includes('data-labelled="true"')) continue;
    assert.match(tag, /aria-label="[^"]+"/, `icon button without a label: ${tag}`);
    if (!tag.includes('aria-hidden="true"')) assert.match(tag, /aria-describedby="[^"]+"/, `icon button without a tooltip: ${tag}`);
  }
}

const TOOLS: PaneTools = [
  { commandId: 'reader.previousThread', icon: 'chevron-up', label: 'Previous email' },
  { commandId: 'reader.nextThread', icon: 'chevron-down', label: 'Next email', disabled: true },
  { commandId: 'list.more', icon: 'more', label: 'More', detail: 'bookmark, trash, forward, why it’s here' },
];
const header = (over: Partial<PaneHeaderProps> = {}): PaneHeaderProps => ({
  lead: { kind: 'back', label: 'Back', commandId: 'nav.back', onPress: noop },
  crumb: { label: 'Home', position: { index: 1, of: 16 } },
  tools: TOOLS,
  ask: { pressed: false, scope: 'thisEmail', onPress: noop },
  today: { pressed: false, onPress: noop },
  ...over,
});

/* ───────────── Pane ───────────── */
describe('Pane', () => {
  it('main pane: back + crumb left, three tools then Ask and the calendar button right, keys from the registry', () => {
    const html = render(
      <Pane kind="main" label="Home" header={header()}>
        <p>Body</p>
      </Pane>,
    );
    assert.match(html, /^<section class="ui-pane" data-kind="main" aria-label="Home">/);
    assert.match(html, /<header class="ui-pane__head">/);
    assert.ok(!html.includes('data-scrolled'), 'no hairline before scroll');
    assert.match(html, /aria-label="Back"/);
    assert.match(textOf(html), /Home 1 of 16/);
    for (const label of ['Previous email', 'Next email', 'More', 'Today']) assert.match(html, new RegExp(`aria-label="${label}"`));
    assert.match(html, /aria-label="Next email"[^>]*disabled=""/);
    // Ask: speech bubble + visible "Ask", tooltip names the scope; calendar button carries ⇧A.
    assert.match(html, /data-icon="bubble"[\s\S]*?<span class="ui-part-button__label">Ask<\/span>/);
    assert.match(textOf(html), /Ask about this email A/);
    assert.match(textOf(html), /Today ⇧A/);
    assert.match(textOf(html), /Back Esc/);
    assert.match(textOf(html), /More \. bookmark, trash, forward, why it’s here/);
    // order: tools, Ask, Today
    const order = ['Previous email', 'Next email', 'aria-label="More"', '>Ask<', 'aria-label="Today"'].map((s) => html.indexOf(s));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(html, /<div class="ui-pane__body">.*Body/);
    assertIconButtonsLabelled(html);
    assertIdRefs(html);
    assertClean(html);
  });

  it('shows the subject instead of the crumb once the summary scrolls away, without the position', () => {
    const html = render(<Pane kind="main" label="Reader" header={header({ crumb: { label: 'Home', position: { index: 1, of: 16 }, subject: SUBJECT_300, showSubject: true } })}>x</Pane>);
    assert.ok(html.includes(SUBJECT_300));
    assert.ok(!textOf(html).includes('1 of 16'));
    assert.match(html, /data-subject="true"/);
  });

  it('Ask in mail scope and the pressed states', () => {
    const html = render(<Pane kind="main" label="Home" header={header({ lead: undefined, crumb: undefined, tools: [], ask: { pressed: true, scope: 'mail', onPress: noop }, today: { pressed: true, onPress: noop } })}>x</Pane>);
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
      assert.ok(count(html, 'data-reveal="hint"') >= 3, 'action keys only in the show-all-hints mode');
      assert.match(html, /aria-label="Clear the selection"/);
      assertIconButtonsLabelled(html);
      assertClean(html);
    }
  });

  it('the dock pane draws no header; the fatal pane has none', () => {
    const dock = render(<Pane kind="dock" label="Ask">Dock</Pane>);
    assert.equal(dock, '<section class="ui-pane" data-kind="dock" aria-label="Ask">Dock</section>');
    const bare = render(<Pane kind="main" label="Aplos">Fatal</Pane>);
    assert.ok(!bare.includes('<header'));
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
    assert.match(render(<PageHead lead={{ kind: 'field', field: <input aria-label="Search" /> }} />), /ui-page-head__field"><input aria-label="Search"/);
    assert.equal(render(<PageHead><span>x</span></PageHead>), '<div class="ui-page-head"><div class="ui-page-head__controls"><span>x</span></div></div>');
  });
});

describe('NavHead', () => {
  it('a quiet group label with an id for aria-labelledby', () => {
    assert.equal(render(<NavHead label="Mail" id="nav-mail" />), '<div class="ui-nav-head" id="nav-mail">Mail</div>');
    assert.ok(render(<NavHead label={CJK} />).includes(CJK));
  });
});

describe('AccountSwitcher', () => {
  it('monogram, name, chevron, menu wiring and the "Switch account" tooltip', () => {
    const html = render(<AccountSwitcher label="All accounts" monogram="A" open={false} menuId="acct-menu" onOpen={noop} />);
    assert.match(html, /aria-haspopup="menu" aria-expanded="false" aria-controls="acct-menu"/);
    assert.match(html, /data-state="closed"/);
    assert.match(html, /ui-account-switcher__mono" aria-hidden="true">A</);
    assert.match(textOf(html), /All accounts .*Switch account/);
    assert.match(html, /data-icon="chevron-down"/);
    assertIdRefs(html);
    assertClean(html);
  });
  it('open, an 80-character address and a two-letter cap on the monogram', () => {
    const html = render(<AccountSwitcher label={EMAIL_80} monogram="Alex" open menuId="m" onOpen={noop} />);
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
      assert.equal(html, `<${el} class="ui-text" data-variant="${variant}" data-tone="${tone}">You handled 12 emails.</${el}>`);
    }
  });
  it('as, tone, id and a leading icon; RTL and CJK pass through', () => {
    const html = render(
      <Text variant="small" as="span" tone="ink-2" icon="lock" id="lock-line">
        Saved in Keychain on this Mac. Never shown again.
      </Text>,
    );
    assert.match(html, /^<span class="ui-text" data-variant="small" data-tone="ink-2" data-icon="true" id="lock-line"><svg[^>]*data-icon="lock"/);
    assert.ok(render(<Text variant="label" as="h2">{RTL}</Text>).startsWith('<h2'));
    assert.ok(render(<Text variant="title">{CJK}</Text>).includes(CJK));
  });
});

/* ───────────── Menu, Popover ───────────── */
const ACCOUNT_ENTRIES: MenuEntry[] = [
  { kind: 'label', label: 'Accounts' },
  { kind: 'item', id: 'all', label: 'All accounts', swatch: ['sky', 'hill'] },
  { kind: 'item', id: 'gmail', label: 'alex.moreno@gmail.com', swatch: 'sky', detail: 'Google needs you to sign in again.', inlineAction: { label: 'Reconnect', tone: 'danger', onSelect: noop } },
  { kind: 'item', id: 'fern', label: 'alex@fernworks.studio', swatch: 'hill', aside: 'Synced' },
  { kind: 'separator' },
  { kind: 'item', id: 'add', label: 'Add an account', icon: 'plus' },
];

describe('Menu', () => {
  it('renders nothing while closed', () => {
    assert.equal(render(<Menu open={false} anchor={null} label="Accounts" entries={ACCOUNT_ENTRIES} onSelect={noop} onClose={noop} />), '');
  });

  it('the account menu: label, stacked dots, detail with an inline Reconnect, aside, separator', () => {
    const html = render(<Menu open anchor={null} label="Accounts" entries={ACCOUNT_ENTRIES} activeId="gmail" onSelect={noop} onClose={noop} />);
    assert.match(html, /role="menu" aria-label="Accounts" aria-activedescendant="[^"]+-gmail" tabindex="-1"/);
    assert.equal(count(html, 'role="menuitem"'), 4);
    assert.equal(count(html, 'role="separator"'), 1);
    assert.match(html, /role="presentation" class="ui-menu__label">Accounts</);
    assert.equal(count(html, /data-color="(sky|hill)"/g), 4);
    assert.match(html, /data-active="true" data-detail="true"/);
    assert.match(textOf(html), /Google needs you to sign in again\. Reconnect/);
    // The inline Reconnect is a pointer duplicate; keys reach it with → and the item names only its label.
    assert.match(html, /aria-hidden="true" class="ui-menu__inline" data-tone="danger"/);
    assert.match(html, /role="menuitem" aria-labelledby="([^"]+)-gmail-label" aria-describedby="\1-gmail-detail \1-gmail-hint"/);
    assert.match(html, /class="ui-sr-only" id="[^"]+-gmail-hint">Press Right Arrow to reconnect\.</);
    assert.match(html, /role="menu"[^>]*data-state="open"/);
    assert.match(html, /ui-menu__aside">Synced</);
    assert.ok(!html.includes('data-placed'), 'unplaced until measured');
    assertIdRefs(html);
    assertClean(html, ['alex.moreno@gmail.com', 'alex@fernworks.studio']);
  });

  it('picker mode: menuitemradio with one aria-checked and a check mark', () => {
    const entries: MenuEntry[] = ['Groq', 'OpenAI', 'Claude'].map((label) => ({ kind: 'item', id: label.toLowerCase(), label }));
    const html = render(<Menu open anchor={null} label="Provider" entries={entries} checkedId="groq" onSelect={noop} onClose={noop} />);
    assert.equal(count(html, 'role="menuitemradio"'), 3);
    assert.equal(count(html, 'aria-checked="true"'), 1);
    assert.equal(count(html, 'aria-checked="false"'), 2);
    assert.equal(count(html, 'data-icon="check"'), 1);
  });

  it('numbered: digits 1–9 only, keycaps from the registry, danger and disabled items', () => {
    const entries: MenuEntry[] = [
      { kind: 'item', id: 'date', label: 'Set a date', icon: 'calendar', commandId: 'mail.setDate' },
      { kind: 'item', id: 'trash', label: 'Trash', icon: 'trash', danger: true },
      { kind: 'item', id: 'off', label: 'Not available', disabled: true },
      ...Array.from({ length: 9 }, (_, i): MenuEntry => ({ kind: 'item', id: `x${i}`, label: i === 0 ? SUBJECT_300 : `Option ${i}` })),
    ];
    const html = render(<Menu open anchor={null} label="More" entries={entries} numbered activeId="off" onSelect={noop} onClose={noop} />);
    for (let d = 1; d <= 9; d++) assert.ok(html.includes(`<span class="ui-menu__num">${d}</span>`));
    assert.ok(!html.includes('<span class="ui-menu__num">10</span>'));
    assert.equal(count(html, '<span class="ui-menu__num"></span>'), 3);
    assert.match(html, /<kbd class="ui-part-kbd">D<\/kbd>/);
    assert.match(html, /data-tone="danger"/);
    assert.match(html, /aria-disabled="true"/);
    assert.ok(!html.includes('aria-activedescendant'), 'a disabled item is never the active descendant');
  });
});

describe('Popover', () => {
  it('dialog and tooltip roles, closed renders nothing', () => {
    assert.equal(render(<Popover open={false} anchor={null} label="Why it’s here" role="dialog" onClose={noop}>x</Popover>), '');
    const dialog = render(
      <Popover open anchor={null} label="Why it’s here" role="dialog" placement="below-end" onClose={noop}>
        <p>Jordan asked for your pick by tomorrow.</p>
      </Popover>,
    );
    assert.match(dialog, /role="dialog" aria-label="Why it’s here" tabindex="-1" class="ui-popover" data-role="dialog" data-state="open" data-placement="below-end"/);
    const tip = render(<Popover open anchor={null} label="Quote" role="tooltip" onClose={noop}>{RTL}</Popover>);
    assert.match(tip, /role="tooltip" aria-label="Quote" class="ui-popover" data-role="tooltip" data-state="open" data-placement="below-start"/);
    assert.ok(!tip.includes('tabindex'));
  });
});

/* ───────────── Dialog, Confirm ───────────── */
describe('Dialog', () => {
  it('modal, labelled by its title, described by its line, with a footer', () => {
    assert.equal(render(<Dialog open={false} title="x" size="sm" onClose={noop}>x</Dialog>), '');
    const html = render(
      <Dialog open title="Keyboard shortcuts" description="Every key Aplos knows." size="lg" footer={<button type="button">Done</button>} onClose={noop}>
        <p>Body</p>
      </Dialog>,
    );
    assert.match(html, /^<div class="ui-dialog__scrim" data-state="open"><section role="dialog" aria-modal="true" aria-labelledby="[^"]+" aria-describedby="[^"]+" tabindex="-1" class="ui-dialog" data-size="lg" data-state="open">/);
    assert.ok(!html.includes('inert'), 'open: takes input');
    assert.match(html, /<h2 class="ui-dialog__title" id="[^"]+">Keyboard shortcuts<\/h2>/);
    assert.match(html, /ui-dialog__foot"><button/);
    assertIdRefs(html);
  });
  it('a 300-character title and no description', () => {
    const html = render(<Dialog open title={SUBJECT_300} size="md" onClose={noop}>x</Dialog>);
    assert.ok(html.includes(SUBJECT_300));
    assert.ok(!html.includes('aria-describedby'));
    assert.ok(!html.includes('ui-dialog__foot'));
  });
});

describe('Confirm', () => {
  it('destructive: Cancel is the default row with Return; the confirm row needs ⇧Return and reads red', () => {
    const html = render(<Confirm question="Delete forever?" consequence="“Invoice #0412” will be removed from your account. This can’t be undone." confirmLabel="Delete forever" destructive presentation="dialog" onConfirm={noop} onCancel={noop} />);
    assert.match(html, /role="dialog" aria-modal="true"/);
    assert.match(html, /ui-dialog__title[^>]*>Delete forever\?</);
    const cancelAt = html.indexOf('>Cancel<');
    const confirmAt = html.indexOf('>Delete forever</span>');
    assert.ok(cancelAt > 0 && confirmAt > cancelAt, 'Cancel comes first');
    assert.match(html, /data-primary="true"><span class="ui-confirm__row-label">Cancel<\/span>.*?<kbd class="ui-part-kbd">Return<\/kbd>/);
    assert.match(html, /data-tone="danger"><span class="ui-confirm__row-label">Delete forever<\/span>.*?<kbd class="ui-part-kbd">⇧Return<\/kbd>/);
    assert.match(html, /data-destructive="true"/);
    assertIdRefs(html);
  });
  it('not destructive: the confirm row is the default with Return; Cancel takes Esc; inline is a labelled group', () => {
    const html = render(<Confirm question="Send to 9,999 people?" consequence="Everyone in the list gets it." confirmLabel="Send" cancelLabel="Keep editing" destructive={false} presentation="inline" onConfirm={noop} onCancel={noop} />);
    assert.match(html, /^<div class="ui-confirm" role="group" aria-labelledby="[^"]+" aria-describedby="[^"]+" data-presentation="inline">/);
    assert.ok(html.indexOf('>Send</span>') < html.indexOf('>Keep editing</span>'));
    assert.match(html, /data-primary="true"><span class="ui-confirm__row-label">Send<\/span>.*?Return/);
    assert.match(html, /Keep editing<\/span>.*?<kbd class="ui-part-kbd">Esc<\/kbd>/);
    assert.ok(!html.includes('data-tone="danger"'));
    assertIdRefs(html);
    assertClean(html);
  });
});

/* ───────────── Puck ───────────── */
describe('Puck', () => {
  it('segmented tabs: one thumb, aria-selected, roving tab stop, short labels named in full', () => {
    const html = render(
      <Puck
        kind="segmented"
        role="tabs"
        label="View"
        items={[
          { id: 'd', label: 'Day view', shortLabel: 'D', commandId: 'calendar.dayView' },
          { id: 'w', label: 'Week view', shortLabel: 'W', commandId: 'calendar.weekView' },
          { id: 'm', label: 'Month view', shortLabel: 'M', commandId: 'calendar.monthView' },
        ]}
        selectedId="w"
        onSelect={noop}
      />,
    );
    assert.match(html, /^<div class="ui-puck" data-kind="segmented" data-orientation="horizontal" role="tablist" aria-label="View" aria-orientation="horizontal">/);
    assert.equal(count(html, 'class="ui-puck__thumb"'), 1, 'one shared indicator');
    assert.equal(count(html, 'role="tab"'), 3);
    assert.equal(count(html, 'aria-selected="true"'), 1);
    assert.match(html, /aria-selected="true" aria-label="Week view"[^>]*tabindex="0"/);
    assert.equal(count(html, 'tabindex="-1"'), 2);
    assert.match(html, /<span class="ui-puck__label">W<\/span>/);
    assert.match(textOf(html), /Week view W/);
    assert.ok(!html.includes('data-ready'), 'the selected item paints itself until measured');
    assert.ok(!html.includes('--puck-sy'), 'scaleX only: the thumb is never scaled vertically');
    assertIdRefs(html);
  });

  it('sidebar selection: a nav with aria-current, counts 0 and 9999, tooltip second line', () => {
    const html = render(
      <Puck
        kind="selection"
        role="navigation"
        label="Places"
        items={[
          { id: 'home', label: 'Home', icon: 'home', count: 9999, commandId: 'nav.home' },
          { id: 'later', label: 'Later', icon: 'clock', count: 0, commandId: 'nav.later' },
          { id: 'done', label: 'Done', icon: 'check-circle', tooltip: 'Mail you finished. Press H to move one back to Home.' },
          { id: 'cal', label: CJK, swatch: 'ember' },
        ]}
        selectedId="home"
        onSelect={noop}
      />,
    );
    assert.match(html, /^<nav class="ui-puck__nav" aria-label="Places"><div class="ui-puck" data-kind="selection" data-orientation="vertical">/);
    assert.equal(count(html, 'aria-current="page"'), 1);
    assert.ok(html.includes('>9,999<') && html.includes('>0<'));
    assert.match(textOf(html), /Home ⌃1/);
    assert.match(textOf(html), /Mail you finished\. Press H to move one back to Home\./);
    assert.match(html, /data-color="ember"/);
    assert.ok(!html.includes('tabindex'), 'navigation rows are all in the tab order');
    assertIdRefs(html);
    assertClean(html, [CJK]);
  });

  it('radio with nothing chosen (an unanswered RSVP): no checked item, the first is the tab stop', () => {
    const html = render(
      <Puck
        kind="segmented"
        role="radio"
        label="Going?"
        items={[
          { id: 'yes', label: 'Yes' },
          { id: 'maybe', label: 'Maybe' },
          { id: 'no', label: 'No', disabled: true },
        ]}
        selectedId={null}
        onSelect={noop}
      />,
    );
    assert.match(html, /role="radiogroup" aria-label="Going\?"/);
    assert.equal(count(html, 'aria-checked="true"'), 0);
    assert.match(html, /aria-checked="false" tabindex="0"[^>]*>.*?Yes/);
    assert.match(html, /disabled=""/);
  });
});

/* ───────────── Toast, ToastStack ───────────── */
const t = (id: string, over: Partial<ToastData> = {}): ToastData => ({ id, kind: 'info', message: `Toast ${id}`, undoable: false, ...over });

describe('Toast', () => {
  it('Moved to Later · Set a date D · Undo Z, with the clock in dusk, polite', () => {
    const html = render(
      <Toast
        id="t1"
        kind="later"
        message="Moved to Later"
        actions={[
          { id: 'date', label: 'Set a date', commandId: 'mail.setDate' },
          { id: 'undo', label: 'Undo', commandId: 'app.undo' },
        ]}
        undoable
        onAction={noop}
        onDismiss={noop}
      />,
    );
    // Not a live region of its own: the stack's persistent region announces it (a region born with text is often silent).
    assert.match(html, /^<div class="ui-toast" data-kind="later" data-state="shown">/);
    assert.ok(!html.includes('role="status"'));
    assert.match(html, /data-tone="dusk"><svg[^>]*data-icon="clock"/);
    assert.match(textOf(html), /Moved to Later Set a date D Undo Z/);
    assert.ok(!html.includes('tabindex'), 'never takes focus');
    assertClean(html);
  });
  it('every kind wears an icon; at most three verbs; worst-case message', () => {
    const kinds = ['done', 'later', 'trash', 'home', 'bookmark', 'undone', 'pending', 'offline', 'tip', 'info'] as const;
    for (const kind of kinds) assert.match(render(<Toast id="k" kind={kind} message="Saved here · will sync" undoable={false} onAction={noop} onDismiss={noop} />), /class="ui-toast__icon"[^>]*><svg/);
    const html = render(
      <Toast
        id="w"
        kind="done"
        message={`${SUBJECT_300} ${EMAIL_80} ${RTL} ${EMOJI}`}
        actions={[1, 2, 3, 4].map((n) => ({ id: `a${n}`, label: `Verb ${n}` }))}
        undoable={false}
        persistent
        onAction={noop}
        onDismiss={noop}
      />,
    );
    assert.equal(count(html, 'class="ui-toast__action"'), 3);
    assert.ok(html.includes(EMAIL_80) && html.includes(RTL) && html.includes(EMOJI));
  });
});

describe('ToastStack', () => {
  it('keeps three, the oldest plain toasts giving way; an Undo toast is never dropped', () => {
    const list = [t('1', { undoable: true }), t('2'), t('3', { undoable: true }), t('4'), t('5')];
    assert.deepEqual(visibleToasts(list, 0).map((x) => x.id), ['1', '3', '5']);
    assert.deepEqual(visibleToasts(list, 1).map((x) => x.id), ['1', '3']);
    assert.deepEqual(visibleToasts([t('a'), t('b')], 0).map((x) => x.id), ['a', 'b']);
    assert.deepEqual(visibleToasts([], 0), []);
    // Four quick E presses: all four Undo toasts stay rather than one being silently hidden.
    const undos = [1, 2, 3, 4].map((n) => t(String(n), { undoable: true }));
    assert.deepEqual(visibleToasts(undos, 0).map((x) => x.id), ['1', '2', '3', '4']);
    assert.deepEqual(visibleToasts([...undos, t('p')], 1).map((x) => x.id), ['1', '2', '3', '4']);
  });

  it('renders a polite stack and the undo-send notice inside it, counted in the three', () => {
    const html = render(
      <ToastStack
        toasts={[t('1', { kind: 'done', message: 'Done', undoable: true }), t('2'), t('3'), t('4')]}
        undoSend={{ state: { kind: 'sending', recipients: 'Jordan', secondsLeft: 6, totalSeconds: 8 }, reducedMotion: false, undoCommandId: 'app.undo', onAction: noop }}
        onAction={noop}
        onDismiss={noop}
      />,
    );
    assert.match(html, /^<div class="ui-toast-stack" aria-live="polite">/);
    assert.ok(!html.includes('aria-label="Notifications"'), 'not a landmark');
    assert.equal(count(html, 'class="ui-toast"'), 3);
    // The ticking countdown opts out of the stack's live region; its start is spoken once through announce.
    assert.match(html, /data-kind="undo-send" data-state="shown" aria-live="off"/);
    assert.match(textOf(html), /Sending to Jordan in 6 s Undo Z Send now/);
    assert.match(html, /class="ui-toast__drain" aria-hidden="true" style="--drain:0.75"/);
    assert.ok(html.includes('>Done<'), 'the Undo toast stays');
    assertClean(html);
  });

  it('undo-send states: reduced motion has no drain; uncertain, suspended and deferred copy', () => {
    const base = { reducedMotion: true, undoCommandId: 'app.undo', onAction: noop } as const;
    const sending = render(<ToastStack toasts={[]} undoSend={{ ...base, state: { kind: 'sending', recipients: 'Jordan and Mina', secondsLeft: 8, totalSeconds: 8 } }} onAction={noop} onDismiss={noop} />);
    assert.ok(!sending.includes('ui-toast__drain'));
    assert.match(textOf(sending), /Sending to Jordan and Mina in 8 s/);
    assert.match(textOf(render(<ToastStack toasts={[]} undoSend={{ ...base, state: { kind: 'uncertain' } }} onAction={noop} onDismiss={noop} />)), /We could not confirm this was sent\. Check Sent Send anyway/);
    assert.match(textOf(render(<ToastStack toasts={[]} undoSend={{ ...base, state: { kind: 'suspended' } }} onAction={noop} onDismiss={noop} />)), /Missed its time while your Mac was off\. Send now Reschedule/);
    assert.match(textOf(render(<ToastStack toasts={[]} undoSend={{ ...base, state: { kind: 'deferred', until: '2026-10-29T14:14:00-07:00' } }} onAction={noop} onDismiss={noop} />)), /Couldn’t send until \d{1,2}:\d{2} [AP]M\. Your draft is saved\./);
  });

  it('an empty stack stays mounted so announcements land', () => {
    assert.equal(render(<ToastStack toasts={[]} onAction={noop} onDismiss={noop} />), '<div class="ui-toast-stack" aria-live="polite"></div>');
  });
});
