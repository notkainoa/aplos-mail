// Shared helpers for the list and reader family tests (node, react-dom/server); it holds no tests itself.
// Named *.test.ts so the design lint skips it: it spells out the banned phrases and glyphs on purpose.

import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setFormatClock } from './internal/format';

/** The harness clock: Thursday 2026-10-29 10:00 in Los Angeles, en-US. */
export const NOW = '2026-10-29T10:00:00-07:00';

/** Freeze the time zone and clock for deterministic dates. */
export function freezeClock(): void {
  process.env.TZ = 'America/Los_Angeles';
  setFormatClock(() => new Date(NOW).getTime());
}

/** Static markup of an element. */
export function html(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

/** Visible-ish text: tags stripped, entities decoded, whitespace collapsed. */
export function text(markup: string): string {
  return markup
    .replace(/<span class="ui-key-mod">([^<]*)<\/span>/g, '$1') // a modifier mark is part of its keycap's word
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** DESIGN §9 rule 8, §10, §13: phrases and glyphs that must never render. */
export const BANNED = [
  'Swipe through them',
  'Hold to talk',
  'Hide all',
  'Todo',
  'Be here now',
  'Sent with',
  'Ask me anything',
  'magic',
  'AI-powered',
  'Copilot',
  'Ready when you are',
  'Waiting on you',
  'No reply yet',
  'All clear for now',
  'Making room for your mail',
  'Aplos needs a moment',
  'Couldn’t summarize',
  "Couldn't summarize",
  'Beta',
  'sparkle',
  'wand',
  'lucide-star',
  'lucide-bot',
  'lucide-brain',
  'monogram',
  'avatar',
  'gradient',
  'backdrop',
  'airmail',
  '✨',
  '⭐',
  '🪄',
  '🤖',
  '🧠',
] as const;

/** Every banned phrase or glyph found in the markup, plus any exclamation mark in its text. */
export function bannedIn(markup: string): string[] {
  const found: string[] = BANNED.filter(b => markup.toLowerCase().includes(b.toLowerCase()));
  if (text(markup).includes('!')) found.push('!');
  return found;
}

/** Worst-case data (break-ui): long, unbreakable, tiny, huge, CJK, RTL and emoji. */
export const WORST = {
  subject:
    `${'A very long subject about the Hollow Creek launch plan and its many moving parts, '.repeat(4)}end`.slice(
      0,
      300,
    ),
  email: `${'x'.repeat(66)}@example.test`.padEnd(80, 'z'),
  oneLetter: 'Q',
  cjk: '山田太郎からの請求書の確認をお願いします',
  arabic: 'مرحبا، هل يمكنك مراجعة الفاتورة قبل يوم الجمعة',
  emoji: 'Party planning 🎉🎂👩‍👩‍👧‍👦 for Saturday',
} as const;
