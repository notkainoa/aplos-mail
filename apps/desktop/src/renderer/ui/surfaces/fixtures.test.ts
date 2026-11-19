// Shared fixtures for the surfaces family tests: worst-case data and the markup checks.
import assert from 'node:assert/strict';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyProblem } from '../../commands/internal';
import type { PaneHeaderProps, PaneTools } from '../props';

/* ───────────── worst-case data ───────────── */
export const SUBJECT_300 =
  'Two layout directions for the Hollow Creek site are ready and Jordan wants a pick by tomorrow so the build can start on Monday morning '
    .repeat(3)
    .slice(0, 300);
export const EMAIL_80 = `${'a'.repeat(62)}@${'b'.repeat(13)}.com`;
export const CJK = '会議の議題について確認してください';
export const RTL = 'مرحبا بكم في البريد';
export const EMOJI = 'Parcel Trail 📦🎉';

/* ───────────── helpers ───────────── */
export const noop = () => {};
export const render = (el: ReactElement) => renderToStaticMarkup(el);
export const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
/** Visible and accessible text: tag text plus aria-label values. */
export function textOf(html: string): string {
  const labels = [...html.matchAll(/aria-label="([^"]*)"/g)].map(m => m[1]);
  return decode(
    `${html
      .replace(/<!--.*?-->/g, '')
      .replace(/<span class="ui-key-mod">([^<]*)<\/span>/g, '$1')
      .replace(/<[^>]+>/g, ' ')} ${labels.join(' ')}`,
  ).replace(/\s+/g, ' ');
}
export const BANNED_GLYPHS = /lucide-(sparkle|star|wand|brain|bot)|✨|⭐|🪄|🤖|🧠/i;
export function assertClean(html: string, data: readonly string[] = []) {
  let text = textOf(html);
  for (const d of data) text = text.split(d).join(' ');
  assert.equal(copyProblem(text), null, `banned copy in: ${text}`);
  assert.doesNotMatch(html, BANNED_GLYPHS);
  assert.doesNotMatch(html, /style="(?![^"]*--)[^"]*"/, 'only custom properties may be inline');
}
export function count(html: string, needle: string | RegExp): number {
  return typeof needle === 'string'
    ? html.split(needle).length - 1
    : [...html.matchAll(needle)].length;
}
/** Every aria-describedby / aria-labelledby / aria-controls target id exists in the markup (controls may point outside). */
export function assertIdRefs(
  html: string,
  attrs = ['aria-describedby', 'aria-labelledby', 'aria-activedescendant'],
) {
  for (const attr of attrs) {
    for (const m of html.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))) {
      for (const id of m[1].split(' '))
        assert.ok(html.includes(`id="${id}"`), `${attr} → missing #${id}`);
    }
  }
}
/** Every icon-only button has an accessible name and a tooltip. */
export function assertIconButtonsLabelled(html: string) {
  for (const m of html.matchAll(/<button[^>]*data-variant="icon"[^>]*>/g)) {
    const tag = m[0];
    if (tag.includes('data-labelled="true"')) continue;
    assert.match(tag, /aria-label="[^"]+"/, `icon button without a label: ${tag}`);
    if (!tag.includes('aria-hidden="true"'))
      assert.match(tag, /aria-describedby="[^"]+"/, `icon button without a tooltip: ${tag}`);
  }
}

export const TOOLS: PaneTools = [
  { commandId: 'reader.previousThread', icon: 'chevron-up', label: 'Previous email' },
  { commandId: 'reader.nextThread', icon: 'chevron-down', label: 'Next email', disabled: true },
  {
    commandId: 'list.more',
    icon: 'more',
    label: 'More',
    detail: 'bookmark, trash, forward, why it’s here',
  },
];
export const header = (over: Partial<PaneHeaderProps> = {}): PaneHeaderProps => ({
  lead: { kind: 'back', label: 'Back', commandId: 'nav.back', onPress: noop },
  crumb: { label: 'Home', position: { index: 1, of: 16 } },
  tools: TOOLS,
  ask: { pressed: false, scope: 'thisEmail', onPress: noop },
  today: { pressed: false, onPress: noop },
  ...over,
});
