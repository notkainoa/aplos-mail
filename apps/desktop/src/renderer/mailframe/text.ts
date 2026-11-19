// Plain-text bodies render as escaped host DOM (no frame, follows the theme). This turns the text into segments React
// renders as text nodes, so nothing in the body is ever parsed as markup. Links are detected for http, https and
// mailto only and pass safeExternalUrl; find matches become marks.

import { splitMatches } from './highlight';
import { safeExternalUrl } from './urls';

/** One run of a plain-text body. */
export type TextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mark'; text: string }
  | { kind: 'link'; text: string; href: string };

const LINK = /\b(?:https?:\/\/|mailto:)[^\s<>"'`]+/gi;
/** Punctuation that usually ends a sentence rather than a URL. */
const TRAILING = new Set('.,;:!?)]}>');
/** A longer candidate (after trimming) stays text. */
export const MAX_URL = 2_000;

/** The candidate without its trailing punctuation: one scan back from the end, so linear on any input. */
function trimTrailing(raw: string): string {
  let end = raw.length;
  while (end > 0 && TRAILING.has(raw[end - 1]!)) end--;
  return raw.slice(0, end);
}

function linkAt(raw: string): { text: string; href: string } | null {
  const text = trimTrailing(raw);
  if (text.length > MAX_URL) return null;
  const href = safeExternalUrl(text);
  return href ? { text, href } : null;
}

function withMarks(text: string, query: string): TextSegment[] {
  return splitMatches(text, query)
    .map((part, i): TextSegment => ({ kind: i % 2 === 1 ? 'mark' : 'text', text: part }))
    .filter(s => s.text !== '');
}

/** Split a plain-text body into text, link and mark segments. Links keep their own text and are not marked. */
export function textSegments(body: string, findQuery?: string): TextSegment[] {
  const query = (findQuery ?? '').trim();
  const out: TextSegment[] = [];
  let from = 0;
  for (const match of body.matchAll(LINK)) {
    const link = linkAt(match[0]);
    if (!link) continue;
    out.push(...withMarks(body.slice(from, match.index), query));
    out.push({ kind: 'link', ...link });
    from = match.index + link.text.length;
  }
  out.push(...withMarks(body.slice(from), query));
  return out;
}
