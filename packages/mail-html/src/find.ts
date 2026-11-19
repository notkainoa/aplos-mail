import { escapeText } from './escape';

// Find-in-message: each match inside one text node is wrapped in `<mark class="aplos-find">`.
// A match split across elements is not found (recorded limit).

export const MAX_MARKS = 1000;

export interface Finder {
  pattern: RegExp;
  marks: number;
}

export function createFinder(query: string | undefined): Finder | undefined {
  const trimmed = query?.trim();
  if (!trimmed) return undefined;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return { pattern: new RegExp(escaped, 'giu'), marks: 0 };
}

/** The escaped text with its matches marked. */
export function markText(text: string, finder: Finder | undefined): string {
  if (!finder || finder.marks >= MAX_MARKS) return escapeText(text);
  const parts: string[] = [];
  let last = 0;
  finder.pattern.lastIndex = 0;
  for (const match of text.matchAll(finder.pattern)) {
    if (finder.marks >= MAX_MARKS) break;
    const start = match.index;
    parts.push(escapeText(text.slice(last, start)));
    parts.push(`<mark class="aplos-find">${escapeText(match[0])}</mark>`);
    last = start + match[0].length;
    finder.marks++;
  }
  parts.push(escapeText(text.slice(last)));
  return parts.join('');
}

/** Matches in a plain-text body, for `marks` when there is no frame. */
export function countMatches(text: string, finder: Finder | undefined): number {
  if (!finder) return 0;
  const pattern = new RegExp(finder.pattern.source, finder.pattern.flags);
  let count = 0;
  while (count < MAX_MARKS && pattern.exec(text)) count++;
  return count;
}
