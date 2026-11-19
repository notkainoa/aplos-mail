// controls: Switch, Checkbox, SwatchPicker, TextField, ShortcutSheet. Static markup, demo and worst-case data.
// Run from the repo root: npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/ui/controls/controls.test.tsx
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildSheet, createAppRegistry } from '../../commands';
import { CommandKeysProvider } from '../buttons-keys/keyHints';
import { COMPONENTS, type ShortcutGroup, type ShortcutSheetProps, type TagColor } from '../props';
import { Checkbox } from './Checkbox';
import { ShortcutSheet } from './ShortcutSheet';
import { SWATCHES, SwatchPicker } from './SwatchPicker';
import { Switch } from './Switch';
import { TextField } from './TextField';
import { sheetProps } from './sheetModel';

const registry = createAppRegistry();
const html = (node: ReactNode) =>
  renderToStaticMarkup(
    <CommandKeysProvider describe={id => registry.describeKeys(id)}>{node}</CommandKeysProvider>,
  );
const text = (markup: string) => markup.replace(/<[^>]*>/g, '');

const BANNED =
  /\b(swipe through them|hold to talk|todo|todos|hide all|magic|ai-powered|copilot|beta)\b|!/i;
function assertClean(markup: string) {
  assert.doesNotMatch(text(markup), BANNED, 'banned copy rendered');
  assert.doesNotMatch(markup, /backdrop-filter|gradient|sparkle|wand|robot|brain|\bstar\b/i);
}

const LONG_300 = `${'Quarterly '.repeat(30).slice(0, 299)}.`;
const EMAIL_80 = `${'a'.repeat(48)}@${'b'.repeat(28)}.co`;
const CJK = '下書きを保存して送信する';
const ARABIC = 'إرسال الرسالة الآن';
const EMOJI = 'Mute 🙂👍🏽';
const noop = () => {};

test('manifest: the controls components are the five of props.ts', () => {
  assert.deepEqual(
    COMPONENTS.filter(c => c.family === 'controls').map(c => c.name),
    ['Switch', 'Checkbox', 'SwatchPicker', 'TextField', 'ShortcutSheet'],
  );
});

/* --------------------------------- Switch --------------------------------- */

test('Switch: role=switch, aria-checked and data-state follow `checked`', () => {
  const on = html(<Switch checked label="Undo send" onChange={noop} />);
  assert.match(on, /role="switch"/);
  assert.match(on, /aria-checked="true"/);
  assert.match(on, /data-state="on"/);
  assert.match(on, /aria-label="Undo send"/);
  assert.match(on, /type="button"/);
  const off = html(<Switch checked={false} label="Undo send" onChange={noop} />);
  assert.match(off, /aria-checked="false"/);
  assert.match(off, /data-state="off"/);
});

test('Switch: labelledBy replaces the aria-label', () => {
  const markup = html(
    <Switch checked={false} label="Show all key hints" labelledBy="row-hints" onChange={noop} />,
  );
  assert.match(markup, /aria-labelledby="row-hints"/);
  assert.doesNotMatch(markup, /aria-label="/);
});

test('Switch: disabled, and disabled with a reason keeps focus for the tooltip', () => {
  const disabled = html(<Switch checked label="Notifications" disabled onChange={noop} />);
  assert.match(disabled, /\sdisabled(=""|\s|>)/);
  const explained = html(
    <Switch
      checked
      label="Notifications"
      disabled
      disabledReason="Turn on notifications in System Settings."
      onChange={noop}
    />,
  );
  assert.doesNotMatch(explained, /\sdisabled(=""|\s|>)/);
  assert.match(explained, /aria-disabled="true"/);
});

test('Switch: worst-case labels', () => {
  for (const label of [LONG_300, EMAIL_80, 'A', CJK, ARABIC, EMOJI]) {
    const markup = html(<Switch checked label={label} onChange={noop} />);
    assert.match(markup, /aria-label="/);
    assertClean(markup);
  }
});

/* -------------------------------- Checkbox -------------------------------- */

test('Checkbox: checked, unchecked and mixed are real ARIA states with a mark for each', () => {
  const checked = html(<Checkbox checked label="Select Jordan Park" onChange={noop} />);
  assert.match(checked, /role="checkbox"/);
  assert.match(checked, /aria-checked="true"/);
  assert.match(checked, /data-state="checked"/);
  assert.match(checked, /data-icon="check"/);
  const mixed = html(<Checkbox checked="mixed" label="Select all" onChange={noop} />);
  assert.match(mixed, /aria-checked="mixed"/);
  assert.match(mixed, /data-state="mixed"/);
  assert.match(mixed, /data-icon="minus"/);
  const empty = html(<Checkbox checked={false} label="Select" onChange={noop} />);
  assert.match(empty, /aria-checked="false"/);
  assert.doesNotMatch(empty, /ui-icon/);
});

test('Checkbox: the label shows by default, or becomes aria-label', () => {
  const shown = html(<Checkbox checked={false} label="Remember me" onChange={noop} />);
  assert.equal(text(shown), 'Remember me');
  assert.doesNotMatch(shown, /aria-label/);
  const hidden = html(
    <Checkbox checked={false} label="Pick this row" labelVisible={false} onChange={noop} />,
  );
  assert.equal(text(hidden), '');
  assert.match(hidden, /aria-label="Pick this row"/);
});

test('Checkbox: disabled and worst-case labels', () => {
  assert.match(
    html(<Checkbox checked label="Mute" disabled onChange={noop} />),
    /\sdisabled(=""|\s|>)/,
  );
  for (const label of [LONG_300, EMAIL_80, 'A', CJK, ARABIC, EMOJI]) {
    const markup = html(<Checkbox checked={false} label={label} onChange={noop} />);
    assert.equal(text(markup), label);
    assertClean(markup);
  }
});

/* ------------------------------- SwatchPicker ------------------------------- */

test('SwatchPicker: a radiogroup of the six colours with the fixed names, selected one checked with a check mark', () => {
  const markup = html(<SwatchPicker label="Colour" value="hill" onChange={noop} />);
  assert.match(markup, /role="radiogroup"/);
  assert.match(markup, /aria-label="Colour"/);
  assert.equal((markup.match(/role="radio"/g) ?? []).length, 6);
  assert.deepEqual(
    SWATCHES.map(s => s.name),
    ['Sky', 'Hill', 'Stamp', 'Dusk', 'Sand', 'Ember'],
  );
  for (const { color, name } of SWATCHES) {
    assert.match(markup, new RegExp(`aria-label="${name}"`));
    assert.match(markup, new RegExp(`--swatch:var\\(--tag-${color}\\)`));
  }
  assert.equal((markup.match(/aria-checked="true"/g) ?? []).length, 1);
  assert.match(markup, /aria-checked="true"[^>]*aria-label="Hill"/);
  assert.equal(
    (markup.match(/data-icon="check"/g) ?? []).length,
    1,
    'selection is a check, not colour alone',
  );
});

test('SwatchPicker: one tab stop (roving tabindex) for every selected colour', () => {
  for (const { color } of SWATCHES) {
    const markup = html(<SwatchPicker label="Colour" value={color as TagColor} onChange={noop} />);
    assert.equal((markup.match(/tabindex="0"/g) ?? []).length, 1);
    assert.equal((markup.match(/tabindex="-1"/g) ?? []).length, 5);
  }
});

test('SwatchPicker: labelledBy and disabled', () => {
  const markup = html(
    <SwatchPicker label="Colour" labelledBy="row-colour" value="sky" disabled onChange={noop} />,
  );
  assert.match(markup, /aria-labelledby="row-colour"/);
  assert.doesNotMatch(markup, /role="radiogroup"[^>]*aria-label=/);
  assert.equal((markup.match(/\sdisabled(=""|\s|>)/g) ?? []).length, 6);
  assert.match(markup, /aria-disabled="true"/);
});

/* -------------------------------- TextField -------------------------------- */

test('TextField: placeholder-led field keeps its name as aria-label', () => {
  const markup = html(
    <TextField
      id="addr"
      value=""
      onChange={noop}
      label="Email address"
      placeholder="you@example.com"
      type="email"
    />,
  );
  assert.match(markup, /<input /);
  assert.match(markup, /id="addr"/);
  assert.match(markup, /aria-label="Email address"/);
  assert.match(markup, /placeholder="you@example\.com"/);
  assert.match(markup, /type="email"/);
  assert.match(markup, /autoCapitalize="off"|autocapitalize="off"/i);
  assert.match(markup, /spellcheck="false"/i);
  assert.doesNotMatch(markup, /<label/);
  assert.match(markup, /data-size="md"/);
});

test('TextField: a visible label is a real <label for>', () => {
  const markup = html(
    <TextField id="key" value="" onChange={noop} label="API key" labelVisible type="password" />,
  );
  assert.match(markup, /<label class="ui-text-field-label" for="key">API key<\/label>/);
  assert.doesNotMatch(markup, /aria-label/);
  assert.match(markup, /type="password"/);
});

test('TextField: error sets aria-invalid, aria-describedby and one plain line with an icon and role=status', () => {
  const markup = html(
    <TextField
      id="addr"
      value="jordan@"
      onChange={noop}
      label="Email address"
      error="That address needs a domain, like gmail.com."
    />,
  );
  assert.match(markup, /aria-invalid="true"/);
  assert.match(markup, /aria-describedby="addr-error"/);
  assert.match(markup, /<p id="addr-error" class="ui-text-field-error" role="status">/);
  assert.match(markup, /data-icon="alert"/);
  assert.match(text(markup), /That address needs a domain, like gmail\.com\.$/);
  assert.match(markup, /data-state="invalid"/);
  const fine = html(<TextField id="addr" value="" onChange={noop} label="Email address" />);
  assert.doesNotMatch(fine, /aria-invalid|aria-describedby|ui-text-field-error/);
});

test('TextField: size, icon, trailing Return keycap, mono, disabled, read-only', () => {
  const lg = html(
    <TextField
      id="a"
      value=""
      onChange={noop}
      label="Address"
      size="lg"
      icon="mail"
      trailingKeys="Return"
      mono
    />,
  );
  assert.match(lg, /data-size="lg"/);
  assert.match(lg, /data-icon="mail"/);
  assert.match(lg, /<kbd class="ui-kbd" data-reveal="always">↩<\/kbd>/);
  assert.match(lg, /data-mono="true"/);
  assert.match(
    html(<TextField id="a" value="" onChange={noop} label="Address" disabled />),
    /\sdisabled(=""|\s|>)/,
  );
  const readOnly = html(<TextField id="a" value="x" onChange={noop} label="Address" readOnly />);
  assert.match(readOnly, /readonly/i);
  assert.match(readOnly, /data-state="readonly"/);
});

test('TextField: worst-case values render inside one input and never as markup', () => {
  for (const value of [LONG_300, EMAIL_80, 'A', CJK, ARABIC, EMOJI, '<b>x</b>', '"quoted"']) {
    const markup = html(<TextField id="f" value={value} onChange={noop} label="Filter" />);
    assert.equal((markup.match(/<input/g) ?? []).length, 1);
    assert.doesNotMatch(markup, /<b>x<\/b>/);
    assertClean(markup);
  }
  const long = html(
    <TextField id="f" value="" onChange={noop} label={LONG_300} labelVisible error={EMAIL_80} />,
  );
  assert.match(text(long), new RegExp(EMAIL_80));
});

/* ------------------------------- ShortcutSheet ------------------------------- */

const e = (commandId: string, label: string, ...alts: Array<[string, boolean?]>) => ({
  commandId,
  label,
  alternatives: alts.map(([chord, hold]) => (hold ? { chord, hold } : { chord })),
});
const GROUPS: readonly ShortcutGroup[] = [
  {
    id: 'global',
    label: 'Global',
    entries: [
      e('app.palette', 'Show commands', ['⌘K']),
      e('mail.compose', 'New message', ['C']),
      e('ask.dictate', 'Dictate to Ask', ['A', true]),
    ],
  },
  {
    id: 'lists',
    label: 'Lists',
    entries: [
      e('list.down', 'Next row', ['J'], ['↓']),
      e('mail.done', 'Done', ['E']),
      e('mail.later', 'Later', ['L'], ['←']),
    ],
  },
  {
    id: 'calendar',
    label: 'Calendar',
    entries: [
      e('cal.new', 'New event', ['N']),
      e('cal.view', 'Day, week or month', ['D'], ['W'], ['M']),
    ],
  },
];
const COLUMNS: ShortcutSheetProps['columns'] = [['global'], ['lists'], ['calendar']];
const sheet = (over: Partial<ShortcutSheetProps> = {}) =>
  html(
    <ShortcutSheet
      open
      groups={GROUPS}
      columns={COLUMNS}
      query=""
      onQueryChange={noop}
      onClose={noop}
      {...over}
    />,
  );

test('ShortcutSheet: closed renders nothing', () => {
  assert.equal(sheet({ open: false }), '');
});

test('ShortcutSheet: a labelled modal dialog with a filter, a close button and a scrolling region', () => {
  const markup = sheet();
  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-modal="true"/);
  const labelledBy = /aria-labelledby="([^"]+)"/.exec(markup)?.[1];
  assert.ok(labelledBy);
  assert.match(markup, new RegExp(`<h2 id="${labelledBy}"[^>]*>Keyboard shortcuts</h2>`));
  assert.match(markup, /aria-label="Filter shortcuts"/);
  assert.match(markup, /placeholder="Filter shortcuts"/);
  assert.match(markup, /aria-label="Close"/);
  assert.match(markup, /tabindex="0"/);
  assert.match(markup, /role="status">Hold ⌘ on any screen to show its keys\.</);
  assertClean(markup);
});

test('ShortcutSheet: three columns in the given places, groups labelled, alternatives joined with "or"', () => {
  const markup = sheet();
  assert.equal((markup.match(/class="ui-shortcut-sheet-col"/g) ?? []).length, 3);
  assert.equal((markup.match(/<h3 /g) ?? []).length, 3);
  for (const label of ['Global', 'Lists', 'Calendar'])
    assert.match(markup, new RegExp(`>${label}</h3>`));
  assert.ok(
    markup.indexOf('>Global<') < markup.indexOf('>Lists<') &&
      markup.indexOf('>Lists<') < markup.indexOf('>Calendar<'),
  );
  // "J or ↓"
  assert.match(
    markup,
    /Next row<\/span><span class="ui-shortcut-keys"><span class="ui-key-caps" data-reveal="always"><kbd class="ui-kbd" data-reveal="always">J<\/kbd><span class="ui-key-word">or<\/span><kbd class="ui-kbd" data-reveal="always">↓<\/kbd>/,
  );
  // three alternatives: two "or" words
  const view = /Day, week or month<\/span>(.*?)<\/li>/.exec(markup)?.[1] ?? '';
  assert.equal((view.match(/class="ui-key-word">or</g) ?? []).length, 2);
  // hold
  assert.match(
    markup,
    /ui-key-word">hold<\/span><kbd class="ui-kbd" data-reveal="always">A<\/kbd>/,
  );
});

test('ShortcutSheet: filtering keeps each group in its column, marks the match and counts', () => {
  const markup = sheet({ query: 'later' });
  assert.equal(
    (markup.match(/class="ui-shortcut-sheet-col"/g) ?? []).length,
    3,
    'columns keep their places',
  );
  assert.match(markup, /<mark>Later<\/mark>/);
  assert.match(markup, /role="status">1 of 8 shortcuts</);
  assert.doesNotMatch(markup, /Show commands/);
  assert.doesNotMatch(markup, />Calendar<\/h3>/);
  assert.doesNotMatch(markup, />Global<\/h3>/);
  assert.match(markup, />Lists<\/h3>/);
});

test('ShortcutSheet: filtering matches keys as well as labels', () => {
  assert.match(sheet({ query: '⌘k' }), /Show commands/);
  assert.match(sheet({ query: 'hold a' }), /Dictate to Ask/);
  assert.match(sheet({ query: 'j or ↓' }), /Next row/);
});

test('ShortcutSheet: no match says so plainly', () => {
  const markup = sheet({ query: 'zzz' });
  assert.match(markup, /No shortcut matches ‘zzz’\./);
  assert.doesNotMatch(markup, /ui-shortcut-sheet-cols/);
  assert.match(markup, /role="status">0 of 8 shortcuts</);
});

test('ShortcutSheet: worst-case labels, queries and chords', () => {
  const crazy: readonly ShortcutGroup[] = [
    {
      id: 'global',
      label: LONG_300,
      entries: [
        e('x.long', LONG_300, [EMAIL_80]),
        e('x.cjk', CJK, [CJK]),
        e('x.ar', ARABIC, ['ع']),
        e('x.emoji', EMOJI, ['🙂']),
        e('x.one', 'A', ['A']),
        e('x.n', '9999', ['9999']),
        e('x.zero', '0', ['0']),
      ],
    },
    { id: 'empty', label: 'Empty', entries: [] },
  ];
  const cols: ShortcutSheetProps['columns'] = [['global', 'empty'], [], []];
  const markup = html(
    <ShortcutSheet
      open
      groups={crazy}
      columns={cols}
      query=""
      onQueryChange={noop}
      onClose={noop}
    />,
  );
  assert.match(text(markup), new RegExp(EMAIL_80));
  assert.match(text(markup), new RegExp(CJK));
  assertClean(markup);
  for (const query of [LONG_300, EMAIL_80, CJK, ARABIC, EMOJI, '<b>x</b>', 'İ']) {
    const filtered = html(
      <ShortcutSheet
        open
        groups={crazy}
        columns={cols}
        query={query}
        onQueryChange={noop}
        onClose={noop}
      />,
    );
    assert.doesNotMatch(filtered, /<b>x<\/b>/);
  }
  assert.match(
    html(
      <ShortcutSheet
        open
        groups={crazy}
        columns={cols}
        query={CJK}
        onQueryChange={noop}
        onClose={noop}
      />,
    ),
    new RegExp(`<mark>${CJK}</mark>`),
  );
});

test('ShortcutSheet: generated from the real registry through sheetProps, so every sheet key is on it', () => {
  const sections = buildSheet(registry);
  const { groups, columns } = sheetProps(sections);
  assert.deepEqual(
    columns.flat().sort(),
    sections
      .filter(s => s.rows.length > 0)
      .map(s => s.id)
      .sort(),
    'every non-empty section sits in a column',
  );
  const markup = html(
    <ShortcutSheet
      open
      groups={groups}
      columns={columns}
      query=""
      onQueryChange={noop}
      onClose={noop}
    />,
  );
  for (const section of sections) {
    for (const row of section.rows) {
      assert.ok(text(markup).includes(row.label), `${row.id}: ${row.label}`);
    }
  }
  // keys the old sheet omitted (DESIGN §8): the palette, the skip-to links, the places
  for (const needed of ['⌘K', '⌘⌥L', '⌘⌥R', '⌃5', '⌃7', '⌃8'])
    assert.ok(text(markup).includes(needed), needed);
  assertClean(markup);
});

test('sheetProps: groups, columns and parsed alternatives', () => {
  const { groups, columns } = sheetProps([
    {
      id: 'a',
      title: 'A',
      column: 2,
      rows: [
        { id: 'x', label: 'X', keys: 'J or ↓', kind: 'key' },
        { id: 'y', label: 'Y', keys: 'Hold R', kind: 'key' },
      ],
    },
    { id: 'b', title: 'B', column: 0, rows: [] },
  ]);
  assert.deepEqual(columns, [[], [], ['a']]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].entries[0].alternatives, [{ chord: 'J' }, { chord: '↓' }]);
  assert.deepEqual(groups[0].entries[1].alternatives, [{ chord: 'R', hold: true }]);
});

test('controls CSS: unbreakable no-match query wraps, press scale follows the press motion, switch has no hover lightening', () => {
  const css = readFileSync(new URL('./controls.css', import.meta.url), 'utf8');
  assert.match(
    css.match(/\.ui-shortcut-sheet-empty \{[^}]*\}/)?.[0] ?? '',
    /overflow-wrap:\s*anywhere/,
  );
  for (const part of ['.ui-checkbox-box', '.ui-swatch-dot']) {
    const rule = css.match(new RegExp(`\\${part} \\{[^}]*\\}`))?.[0] ?? '';
    assert.match(rule, /transform var\(--dur-press-up\)/, `${part} transitions transform`);
  }
  assert.doesNotMatch(css, /\.ui-switch\[data-state="off"\]:hover/);
});

test('the switch is the original pill: round track, round --paper thumb in both themes (owner review of #548)', () => {
  const css = readFileSync(new URL('./controls.css', import.meta.url), 'utf8');
  const track = css.match(/\.ui-switch \{[^}]*\}/)?.[0] ?? '';
  assert.match(track, /border-radius: var\(--radius-pill\)/);
  const thumb = css.match(/\.ui-switch-thumb \{[^}]*\}/)?.[0] ?? '';
  assert.match(thumb, /border-radius: var\(--radius-pill\)/);
  assert.match(thumb, /background: var\(--paper\)/);
  assert.doesNotMatch(
    css,
    /\.ui-switch[^{]*\.ui-switch-thumb \{[^}]*background/,
    'no theme repaints the thumb',
  );
});

test('ShortcutSheet: a worst-case no-match query is echoed inside the empty line', () => {
  const query = 'x'.repeat(200);
  const markup = html(
    <ShortcutSheet
      {...sheetProps(buildSheet(registry))}
      open
      query={query}
      onQueryChange={noop}
      onClose={noop}
    />,
  );
  assert.match(markup, /ui-shortcut-sheet-empty/);
  assert.ok(markup.includes(query));
});
