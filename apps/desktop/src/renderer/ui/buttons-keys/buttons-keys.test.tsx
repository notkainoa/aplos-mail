// buttons-keys: Button, Kbd, Tooltip, Icon, key hints. Static markup, demo data and worst-case data.
// Run from the repo root: npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/ui/buttons-keys/buttons-keys.test.tsx
// (npm test in apps/desktop runs src/renderer/ui/**/*.test.tsx too once the script lists them; see the report.)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAppRegistry } from '../../commands';
import { COMPONENTS, type IconName } from '../props';
import { Switch } from '../controls/Switch';
import { Button } from './Button';
import { nameContainsVisibleText } from './buttonName';
import { Icon, IconSetContext, LUCIDE_ICONS } from './Icon';
import { Kbd, KeyCaps } from './Kbd';
import {
  CommandKeysProvider,
  KeyHintsProvider,
  parseKeyText,
  resolveShowKeys,
  revealVisible,
  showsInline,
  useControlKeys,
} from './keyHints';
import { Tooltip, TooltipBubble } from './Tooltip';

const registry = createAppRegistry();
const describe = (id: string) => registry.describeKeys(id);

const html = (node: ReactNode) =>
  renderToStaticMarkup(<CommandKeysProvider describe={describe}>{node}</CommandKeysProvider>);
const inMode = (showKeys: 'tooltips' | 'held' | 'all', node: ReactNode) =>
  html(<KeyHintsProvider value={{ showKeys }}>{node}</KeyHintsProvider>);
const text = (markup: string) => markup.replace(/<[^>]*>/g, '');

const BANNED =
  /\b(swipe through them|hold to talk|todo|todos|hide all|magic|ai-powered|copilot|beta)\b|!/i;
function assertClean(markup: string) {
  assert.doesNotMatch(text(markup), BANNED, 'banned copy rendered');
  assert.doesNotMatch(markup, /backdrop-filter|gradient|sparkle|wand|robot|brain|\bstar\b/i);
}

// Worst-case data (DESIGN §12.5 break-ui list).
const LONG_300 = `${'Quarterly '.repeat(30).slice(0, 299)}.`;
const EMAIL_80 = `${'a'.repeat(48)}@${'b'.repeat(28)}.co`;
const CJK = '下書きを保存して送信する';
const ARABIC = 'إرسال الرسالة الآن';
const EMOJI = 'Send 🙂👍🏽';

test('worst-case fixtures are the sizes they claim', () => {
  assert.equal(LONG_300.length, 300);
  assert.equal(EMAIL_80.length, 80);
});

test('manifest: the buttons-keys files exist where props.ts says', () => {
  const entries = COMPONENTS.filter(c => c.family === 'buttons-keys').map(c => c.name);
  assert.deepEqual(entries, ['Button', 'Kbd', 'Tooltip']);
});

/* ---------------------------------- Icon ---------------------------------- */

test('Icon: every IconName renders one aria-hidden glyph at 16, 14 and 12 px with a 1.5 stroke', () => {
  for (const name of Object.keys(LUCIDE_ICONS) as IconName[]) {
    for (const [size, px] of [
      ['md', 16],
      ['sm', 14],
      ['xs', 12],
    ] as const) {
      const markup = renderToStaticMarkup(<Icon name={name} size={size} />);
      assert.match(markup, /aria-hidden="true"/, name);
      assert.match(markup, new RegExp(`data-icon="${name}"`), name);
      assert.match(markup, new RegExp(`width="${px}"`), `${name} ${size}`);
      assert.match(markup, /stroke-width="1\.5"/, name);
      assert.match(markup, /stroke="currentColor"/, name);
      assertClean(markup);
    }
  }
});

test('Icon: no AI glyph, bubble is a speech bubble, search the magnifier, bookmark a bookmark', () => {
  const all = (Object.keys(LUCIDE_ICONS) as IconName[])
    .map(n => renderToStaticMarkup(<Icon name={n} />))
    .join('');
  assert.doesNotMatch(all, /lucide-(star|sparkle|wand|brain|bot)/i);
  assert.match(renderToStaticMarkup(<Icon name="bubble" />), /lucide-message-square/);
  assert.match(renderToStaticMarkup(<Icon name="search" />), /lucide-search/);
  assert.match(renderToStaticMarkup(<Icon name="bookmark" />), /lucide-bookmark/);
});

test('Icon: the native renderer seam wins over Lucide and null falls back', () => {
  const native = renderToStaticMarkup(
    <IconSetContext.Provider value={name => (name === 'home' ? <i data-native="home" /> : null)}>
      <Icon name="home" />
      <Icon name="clock" />
    </IconSetContext.Provider>,
  );
  assert.match(native, /data-native="home"/);
  assert.match(native, /lucide-clock/);
  assert.doesNotMatch(native, /lucide-house/);
});

/* ---------------------------------- Kbd ---------------------------------- */

test('Kbd: one cap, never hover-driven; reveal modes follow the key-hint mode only', () => {
  assert.equal(html(<Kbd chord="E" />), '<kbd class="ui-kbd" data-reveal="always">E</kbd>');
  assert.equal(revealVisible('always', 'tooltips'), true);
  // hint: only "Show all key hints"
  assert.equal(inMode('tooltips', <Kbd chord="E" reveal="hint" />), '');
  assert.equal(inMode('held', <Kbd chord="E" reveal="hint" />), '');
  assert.match(inMode('all', <Kbd chord="E" reveal="hint" />), /data-reveal="hint">E</);
  // badge: only while the command key is held
  assert.equal(inMode('tooltips', <Kbd chord="E" reveal="badge" />), '');
  assert.equal(inMode('all', <Kbd chord="E" reveal="badge" />), '');
  assert.match(inMode('held', <Kbd chord="E" reveal="badge" />), /data-reveal="badge">E</);
});

test('Kbd: worst-case chords render as given inside one element', () => {
  for (const chord of ['⌘⇧↩', '⌃1–8', 'Space', EMOJI, CJK, ARABIC, LONG_300, EMAIL_80, '9999']) {
    const markup = html(<Kbd chord={chord} />);
    assert.equal(text(markup), chord);
    assert.equal((markup.match(/<kbd/g) ?? []).length, 1);
    assertClean(markup);
  }
});

test('KeyCaps: alternatives join with "or", a hold chord gets the word "hold", empty renders nothing', () => {
  const markup = html(<KeyCaps caps={parseKeyText('J or ↓')} />);
  assert.equal((markup.match(/<kbd/g) ?? []).length, 2);
  assert.match(markup, /<span class="ui-key-word">or<\/span>/);
  const hold = html(<KeyCaps caps={parseKeyText('Hold R')} />);
  assert.match(
    hold,
    /<span class="ui-key-word">hold<\/span><kbd class="ui-kbd" data-reveal="always">R<\/kbd>/,
  );
  assert.equal(html(<KeyCaps caps={[]} />), '');
});

test('parseKeyText: registry text to alternatives', () => {
  assert.deepEqual(parseKeyText(''), []);
  assert.deepEqual(parseKeyText('E'), [{ chord: 'E' }]);
  assert.deepEqual(parseKeyText('J or ↓'), [{ chord: 'J' }, { chord: '↓' }]);
  assert.deepEqual(parseKeyText('Hold R'), [{ chord: 'R', hold: true }]);
  assert.deepEqual(parseKeyText('⌃1–8'), [{ chord: '⌃1–8' }]);
});

test('showsInline: always, hint only in "all", tooltip never', () => {
  for (const mode of ['tooltips', 'held', 'all'] as const) {
    assert.equal(showsInline('always', mode), true);
    assert.equal(showsInline('tooltip', mode), false);
    assert.equal(showsInline(undefined, mode), false);
  }
  assert.equal(showsInline('hint', 'tooltips'), false);
  assert.equal(showsInline('hint', 'held'), false);
  assert.equal(showsInline('hint', 'all'), true);
});

/* --------------------------------- Button --------------------------------- */

const noop = () => {};

test('Button: three idioms, radius and size hooks, plain type=button', () => {
  const filled = html(<Button variant="filled" label="Send" onPress={noop} />);
  assert.match(filled, /^<button [^>]*type="button"/);
  assert.match(filled, /class="ui-button"/);
  assert.match(filled, /data-variant="filled"/);
  assert.match(filled, /data-size="md"/);
  assert.equal(text(filled), 'Send');
  for (const size of ['sm', 'md', 'lg'] as const) {
    assert.match(
      html(<Button variant="text" label="Later" size={size} onPress={noop} />),
      new RegExp(`data-size="${size}"`),
    );
  }
  assert.match(
    html(<Button variant="text" label="Later" icon="clock" onPress={noop} />),
    /data-variant="text"/,
  );
});

test('Button: icon variant has aria-label, no visible label, and a tooltip wrapper path', () => {
  const markup = html(<Button variant="icon" icon="close" label="Close" onPress={noop} />);
  assert.match(markup, /aria-label="Close"/);
  assert.equal(text(markup), '');
  assert.doesNotMatch(markup, /ui-button-label/);
  assert.match(markup, /data-icon="close"/);
  const labelled = html(
    <Button variant="icon" icon="bubble" label="Ask" labelVisible onPress={noop} />,
  );
  assert.doesNotMatch(labelled, /aria-label/);
  assert.equal(text(labelled), 'Ask');
  assert.match(labelled, /data-labelled="true"/);
});

test('Button: ariaLabel replaces the name, labelledBy adds row context and keeps the visible text', () => {
  const named = html(
    <Button
      variant="text"
      label="Groq"
      ariaLabel="Groq, Provider"
      trailingIcon="chevron-down"
      onPress={noop}
    />,
  );
  assert.match(named, /aria-label="Groq, Provider"/);
  assert.doesNotMatch(named, /aria-labelledby/);
  assert.equal(nameContainsVisibleText('Groq, Provider', 'Groq'), true);
  assert.equal(nameContainsVisibleText('Provider', 'Groq'), false);
  assert.equal(nameContainsVisibleText('  GROQ   provider ', 'groq'), true);

  const row = html(<Button variant="text" label="Groq" labelledBy="row-provider" onPress={noop} />);
  const own = /<span id="([^"]+)" class="ui-button-label">Groq<\/span>/.exec(row)?.[1];
  assert.ok(own, 'visible label span carries a generated id');
  assert.ok(row.includes(`aria-labelledby="row-provider ${own}"`));
  assert.doesNotMatch(row, /aria-label=/);

  const iconRow = html(
    <Button
      variant="icon"
      icon="more"
      label="More"
      id="more-1"
      labelledBy="row-provider"
      onPress={noop}
    />,
  );
  assert.match(iconRow, /aria-label="More"/);
  assert.match(iconRow, /aria-labelledby="row-provider more-1"/);
  const iconGenerated = html(
    <Button variant="icon" icon="more" label="More" labelledBy="row-provider" onPress={noop} />,
  );
  const generated = /<button[^>]* id="([^"]+)"/.exec(iconGenerated)?.[1];
  assert.ok(generated && iconGenerated.includes(`aria-labelledby="row-provider ${generated}"`));
});

test('Button: the icon variant still requires a label even with ariaLabel or labelledBy', () => {
  // @ts-expect-error label is required
  const missing = <Button variant="icon" icon="close" ariaLabel="Close" onPress={noop} />;
  assert.ok(missing);
});

test('Button: neither ariaLabel nor labelledBy leaves the markup as it was', () => {
  assert.equal(
    html(<Button variant="text" label="Later" onPress={noop} />),
    '<button type="button" class="ui-button" data-variant="text" data-size="md" data-tone="default"' +
      ' data-labelled="true"><span class="ui-button-label">Later</span></button>',
  );
  const icon = html(<Button variant="icon" icon="close" label="Close" onPress={noop} />);
  assert.match(icon, /aria-label="Close"/);
  assert.doesNotMatch(icon, /aria-labelledby| id="/);
});

test('Button: keycaps come from the registry and never show inline by default', () => {
  const done = html(<Button variant="text" label="Done" commandId="mail.done" onPress={noop} />);
  assert.doesNotMatch(done, /<kbd/);
  assert.equal(text(done), 'Done');
});

test('Button: keyHint always shows the registry key inline, hint only in "all", badge only while held', () => {
  const expected = parseKeyText(describe('mail.suggested'))[0].chord;
  assert.equal(expected, 'Space');
  const always = inMode(
    'tooltips',
    <Button
      variant="filled"
      label="Reply with times"
      commandId="mail.suggested"
      keyHint="always"
      onPress={noop}
    />,
  );
  assert.match(
    always,
    /<span class="ui-button-keys" aria-hidden="true"><span class="ui-key-caps" data-reveal="always"><kbd class="ui-kbd" data-reveal="always">Space<\/kbd>/,
  );
  // accessible name stays the label because the caps are aria-hidden
  assert.match(always, /aria-hidden="true"/);

  const hint = (
    <Button variant="text" label="Done" commandId="mail.done" keyHint="hint" onPress={noop} />
  );
  assert.doesNotMatch(inMode('tooltips', hint), /<kbd/);
  assert.match(inMode('all', hint), /<kbd class="ui-kbd" data-reveal="always">→<\/kbd>/);

  const plain = <Button variant="text" label="Done" commandId="mail.done" onPress={noop} />;
  assert.doesNotMatch(inMode('tooltips', plain), /<kbd/);
  const held = inMode('held', plain);
  assert.match(held, /ui-button-badge/);
  assert.match(held, /data-reveal="badge">→<\/kbd>/);
  // a button with no key shows no badge while held
  assert.doesNotMatch(
    inMode('held', <Button variant="text" label="Cancel" onPress={noop} />),
    /<kbd/,
  );
});

test('Button: literal keys for dialogs and onboarding (Return, Esc)', () => {
  const ret = html(
    <Button
      variant="filled"
      size="lg"
      label="Continue"
      keys="Return"
      keyHint="always"
      onPress={noop}
    />,
  );
  assert.match(ret, />↩<\/kbd>/);
  assert.match(ret, /data-size="lg"/);
  const esc = inMode(
    'all',
    <Button variant="text" label="Back" keys="Esc" keyHint="hint" onPress={noop} />,
  );
  assert.match(esc, />Esc<\/kbd>/);
  assert.doesNotMatch(
    inMode(
      'tooltips',
      <Button variant="text" label="Back" keys="Esc" keyHint="hint" onPress={noop} />,
    ),
    /<kbd/,
  );
});

test('Button: disabled, explained-disabled, busy, pressed and popup states', () => {
  const disabled = html(<Button variant="text" label="Remove" disabled onPress={noop} />);
  assert.match(disabled, /\sdisabled(=""|\s|>)/);
  assert.match(disabled, /data-state="disabled"/);

  const explained = html(
    <Button
      variant="text"
      label="Remove"
      disabled
      disabledReason="This key comes from the environment."
      onPress={noop}
    />,
  );
  assert.doesNotMatch(explained, /\sdisabled(=""|\s|>)/);
  assert.match(explained, /aria-disabled="true"/);
  assert.match(explained, /data-state="disabled"/);

  const busy = html(<Button variant="filled" label="Test" busy onPress={noop} />);
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /data-state="busy"/);
  assert.equal(text(busy), 'Test', 'label stays while busy');
  assert.doesNotMatch(busy, /ui-button-spinner/, 'no spinner before 150 ms');

  const pressed = html(<Button variant="icon" icon="bubble" label="Ask" pressed onPress={noop} />);
  assert.match(pressed, /aria-pressed="true"/);

  const popup = html(
    <Button
      variant="text"
      label="Groq"
      trailingIcon="chevron-down"
      popup={{ kind: 'menu', expanded: true, controls: 'provider-menu' }}
      onPress={noop}
    />,
  );
  assert.match(popup, /aria-haspopup="menu"/);
  assert.match(popup, /aria-expanded="true"/);
  assert.match(popup, /aria-controls="provider-menu"/);
  assert.match(popup, /data-icon="chevron-down" data-size="xs"/);
});

test('Button: danger tone is text colour only, never a different variant', () => {
  const markup = html(<Button variant="text" label="Reconnect" tone="danger" onPress={noop} />);
  assert.match(markup, /data-tone="danger"/);
  assert.match(markup, /data-variant="text"/);
});

test('Button: worst-case labels stay one element with an ellipsis hook', () => {
  for (const label of [LONG_300, EMAIL_80, 'A', CJK, ARABIC, EMOJI, '9999', '0']) {
    const markup = html(<Button variant="text" label={label} icon="plus" onPress={noop} />);
    assert.equal(text(markup), label);
    assert.equal((markup.match(/<button/g) ?? []).length, 1);
    assert.match(markup, /class="ui-button-label"/);
    assertClean(markup);
  }
  const icon = html(<Button variant="icon" icon="more" label={LONG_300} onPress={noop} />);
  assert.match(icon, new RegExp(`aria-label="${LONG_300}"`));
});

test('Button: every icon-only button of every size has an aria-label', () => {
  for (const size of ['sm', 'md', 'lg'] as const) {
    for (const name of Object.keys(LUCIDE_ICONS) as IconName[]) {
      const markup = html(
        <Button variant="icon" icon={name} label={`Action ${name}`} size={size} onPress={noop} />,
      );
      assert.match(markup, /aria-label="Action /);
    }
  }
});

/* --------------------------------- Tooltip --------------------------------- */

test('Tooltip: closed it renders only the trigger, with no describedby and no bubble', () => {
  const markup = html(
    <Tooltip label="Done" commandId="mail.done">
      <button type="button">x</button>
    </Tooltip>,
  );
  assert.equal(markup, '<button type="button">x</button>');
});

test('Tooltip: keeps the child own aria-describedby while closed', () => {
  const markup = html(
    <Tooltip label="Done">
      <button type="button" aria-describedby="hint">
        x
      </button>
    </Tooltip>,
  );
  assert.match(markup, /aria-describedby="hint"/);
});

test('TooltipBubble: label, then keycaps from the registry, then the detail line', () => {
  const keys = parseKeyText(describe('mail.done'));
  const markup = html(
    <TooltipBubble
      id="tip"
      label="Done"
      caps={keys}
      detail="Moves this conversation out of Home."
    />,
  );
  assert.match(markup, /role="tooltip"/);
  assert.match(markup, /id="tip"/);
  assert.match(markup, /class="ui-tooltip-label">Done</);
  assert.match(markup, /<kbd class="ui-kbd" data-reveal="always">→<\/kbd>/);
  assert.match(markup, /class="ui-tooltip-detail">Moves this conversation out of Home\.</);
  assert.match(markup, /data-placement="below"/);
  assert.match(markup, /data-state="measuring"/);
  assertClean(markup);
});

test('TooltipBubble: alternatives from the registry read "J or ↓"; hold reads "hold R"', () => {
  const next = html(<TooltipBubble label="Next row" caps={parseKeyText(describe('list.down'))} />);
  assert.match(text(next), /^Next rowJor↓$/);
  const dictate = html(
    <TooltipBubble
      label="Hold R to dictate a reply"
      caps={parseKeyText(describe('mail.dictateReply'))}
    />,
  );
  assert.match(dictate, /ui-key-word">hold</);
  assert.match(dictate, />R<\/kbd>/);
});

test('TooltipBubble: positioned by custom properties only, above or below', () => {
  const below = html(<TooltipBubble label="Today" anchor={{ x: 120, y: 40 }} />);
  assert.match(below, /style="--tip-x:120px;--tip-y:40px"/);
  assert.match(below, /data-state="open"/);
  const above = html(<TooltipBubble label="Today" placement="above" anchor={{ x: 1, y: 2 }} />);
  assert.match(above, /data-placement="above"/);
});

test('TooltipBubble: worst-case label and detail', () => {
  const sender = `${EMAIL_80} · 14 emails both ways since March`;
  const markup = html(<TooltipBubble label={LONG_300} detail={sender} />);
  assert.match(text(markup), new RegExp(LONG_300));
  assert.match(text(markup), new RegExp(EMAIL_80));
  for (const label of ['A', CJK, ARABIC, EMOJI, '0', '9999'])
    assert.equal(text(html(<TooltipBubble label={label} />)), label);
});

test('Tooltip children: a Button needing a tooltip renders as the bare button until the pointer rests', () => {
  const markup = html(
    <Button
      variant="icon"
      icon="compose"
      label="New message"
      commandId="mail.compose"
      onPress={noop}
    />,
  );
  assert.match(markup, /^<button /);
  assert.doesNotMatch(markup, /role="tooltip"/);
  assert.match(markup, /aria-label="New message"/);
});

test('Button CSS: a button can shrink so its label ellipsises; filled+danger keeps readable ink', () => {
  const css = readFileSync(new URL('./buttons-keys.css', import.meta.url), 'utf8').replaceAll(
    "'",
    '"',
  );
  const button = css.match(/\n\.ui-button \{[^}]*\}/)?.[0] ?? '';
  assert.match(button, /flex:\s*0 1 auto/);
  assert.match(button, /min-width:\s*0/);
  assert.match(button, /max-width:\s*100%/);
  assert.doesNotMatch(button, /flex:\s*none/);
  // the danger colour is scoped to text and icon buttons; a bare [data-tone="danger"] rule would beat the filled colour
  assert.doesNotMatch(css, /\.ui-button\[data-tone="danger"\]\s*[,{]/);
  assert.match(css, /data-tone="danger"\]:is\(\[data-variant="text"\], \[data-variant="icon"\]\)/);
  assert.match(css, /\.ui-tooltip\[data-instant="true"\]\s*\{\s*animation:\s*none/);
  assert.match(css, /\.ui-button\[data-spinner="overlay"\] \.ui-button-spinner/);
});

test('Button: a 300-character label and an unbreakable email render in the ellipsising label span, untruncated in the DOM', () => {
  const long = 'Quarterly '.repeat(30);
  const email = 'a'.repeat(80) + '@example.com';
  const markup = html(
    <>
      <Button variant="text" label={long} icon="reply" onPress={noop} />
      <Button variant="filled" label={email} onPress={noop} />
    </>,
  );
  assert.match(markup, /<span class="ui-button-label">Quarterly /);
  assert.ok(markup.includes(email));
  assert.doesNotMatch(markup, /title=/, 'the native title appears only after a clip is measured');
});

test('Button: filled with tone danger renders both attributes (the stylesheet keeps the ink readable)', () => {
  const markup = html(
    <Button variant="filled" tone="danger" label="Delete event" onPress={noop} />,
  );
  assert.match(markup, /data-variant="filled"/);
  assert.match(markup, /data-tone="danger"/);
});

test('Tooltip: a disabled reason is a permanent hidden description, so it is read on focus', () => {
  const markup = html(
    <Button
      variant="text"
      label="Remove"
      disabled
      disabledReason="This key comes from the environment."
      onPress={noop}
    />,
  );
  const describedby = markup.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(describedby, 'the trigger points at the reason before any focus');
  const span = markup.match(
    new RegExp(`<span id="${describedby}" class="ui-visually-hidden">([^<]*)</span>`),
  );
  assert.equal(span?.[1], 'This key comes from the environment.');
  const sw = html(
    <Switch
      checked={false}
      label="Sync"
      disabled
      disabledReason="Reconnect first."
      onChange={noop}
    />,
  );
  assert.match(sw, /aria-describedby="[^"]+"/);
  assert.match(sw, /ui-visually-hidden">Reconnect first\./);
});

test('Key hints: the shell resolves the mode with "all" winning over "held"', () => {
  assert.equal(resolveShowKeys({ all: true, held: true }), 'all');
  assert.equal(resolveShowKeys({ all: true, held: false }), 'all');
  assert.equal(resolveShowKeys({ all: false, held: true }), 'held');
  assert.equal(resolveShowKeys({ all: false, held: false }), 'tooltips');
  // "all" keeps an inline hint on while the command key goes down: nothing unmounts, nothing shifts
  const inline = (mode: 'tooltips' | 'held' | 'all') =>
    inMode(
      mode,
      <Button variant="text" label="Done" commandId="mail.done" keyHint="hint" onPress={noop} />,
    );
  assert.match(inline(resolveShowKeys({ all: true, held: true })), /ui-button-keys/);
});

test('Key hints: CommandKeysProvider closes over the current context stack, so tooltips list only keys that work here', () => {
  const calls: Array<readonly string[] | undefined> = [];
  const describeStack = (id: string, stack?: readonly string[]) => {
    calls.push(stack);
    return registry.describeKeys(id, stack as never);
  };
  const Probe = () => (
    <span>
      {useControlKeys('mail.done')
        .map(cap => cap.chord)
        .join('|')}
    </span>
  );
  const render = (stack?: readonly string[]) =>
    text(
      renderToStaticMarkup(
        <CommandKeysProvider describe={describeStack} stack={stack as never}>
          <Probe />
        </CommandKeysProvider>,
      ),
    );
  assert.equal(render(), '→|E', 'without a stack every context is listed');
  assert.equal(render(['global', 'list']), 'E', 'the All mail list has no arrow triage');
  assert.equal(render(['global', 'list', 'home']), '→|E', 'Home does');
  assert.deepEqual(calls, [undefined, ['global', 'list'], ['global', 'list', 'home']]);
});

// Type-level: the helper accepts any ReactElement child.
const _typecheck: ReactElement = (
  <Tooltip label="x">
    <span />
  </Tooltip>
);
void _typecheck;
