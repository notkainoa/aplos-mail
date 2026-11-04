// Find-in-message on the sanitised string. sanitiseBody's output is a closed language (every `<` in text is escaped
// and `<style>` bodies contain no `<`), so splitting on tags is exact here. Text runs are decoded, searched
// case-insensitively, and re-escaped piece by piece, so the query can never inject markup or split an entity.

import { escapeHtml } from './attributes';

const TAG_OR_STYLE = /(<style>[^<]*<\/style>|<[^>]*>)/;
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};
/** Queries longer than this are ignored rather than searched. */
const MAX_QUERY = 500;

function decode(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, e => ENTITIES[e] ?? e);
}

/** Split a plain string around case-insensitive matches of `query`. Odd indexes are the matches. */
export function splitMatches(value: string, query: string): string[] {
  const needle = query.toLocaleLowerCase();
  const hay = value.toLocaleLowerCase();
  if (!needle || hay.length !== value.length) return [value];
  const parts: string[] = [];
  let from = 0;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
    parts.push(value.slice(from, at), value.slice(at, at + needle.length));
    from = at + needle.length;
  }
  parts.push(value.slice(from));
  return parts;
}

function markRun(escaped: string, query: string, attribute: string): string {
  const parts = splitMatches(decode(escaped), query);
  if (parts.length === 1) return escaped;
  return parts
    .map((part, i) =>
      i % 2 === 1 ? `<mark ${attribute}>${escapeHtml(part)}</mark>` : escapeHtml(part),
    )
    .join('');
}

/**
 * Wrap each match of `query` in the text of sanitised markup with `<mark data-find>`. The frame passes its own
 * per-instance `attribute` (a `data-` name the sanitiser never keeps), so the email cannot select the marks.
 */
export function highlight(
  sanitised: string,
  query: string | undefined,
  attribute = 'data-find',
): string {
  const q = (query ?? '').trim();
  if (!q || q.length > MAX_QUERY) return sanitised;
  return sanitised
    .split(TAG_OR_STYLE)
    .map((piece, i) => (i % 2 === 1 ? piece : markRun(piece, q, attribute)))
    .join('');
}
