// The text-only fallback for bodies over the table-cell or nesting cap. It must stay linear on hostile input
// (htmlparser2 costs O(depth) per tag, so a deep body is exactly what it must not be given), so it scans with
// indexOf only, never a backtracking pattern, and decodes entities by feeding htmlparser2 a string with no tags.

import { Parser } from 'htmlparser2';

/** Elements whose content is not readable text. */
const SKIP = new Set([
  'script',
  'style',
  'title',
  'template',
  'textarea',
  'svg',
  'math',
  'noscript',
  'iframe',
  'object',
  'xmp',
  'select',
]);
/** Elements that end a line. */
const BLOCKS = new Set(
  'address article aside blockquote br caption details div dl dt dd figure footer h1 h2 h3 h4 h5 h6 header hr li main ol p pre section table tr ul'.split(
    ' ',
  ),
);
const TAG_NAME = /^<\/?([a-z][a-z0-9-]*)/;

function decodeEntities(text: string): string {
  const parts: string[] = [];
  const parser = new Parser({ ontext: value => void parts.push(value) }, { decodeEntities: true });
  parser.write(text.replace(/</g, '&lt;'));
  parser.end();
  return parts.join('');
}

/** Index just past the element's own end tag, or the end of input. */
function skipElement(lower: string, name: string, from: number): number {
  const end = lower.indexOf(`</${name}`, from);
  if (end === -1) return lower.length;
  const gt = lower.indexOf('>', end);
  return gt === -1 ? lower.length : gt + 1;
}

/** Strip markup in one pass: text kept, comments and unreadable elements dropped, block ends become newlines. */
function stripMarkup(html: string): string {
  // ASCII-only lowercasing keeps every index aligned with `html` (toLowerCase can change the length).
  const lower = html.replace(/[A-Z]/g, c => c.toLowerCase());
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    if (lower.startsWith('<!--', lt)) {
      const end = lower.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const name = TAG_NAME.exec(lower.slice(lt, lt + 40))?.[1];
    if (!name) {
      out.push('<');
      i = lt + 1;
      continue;
    }
    const gt = lower.indexOf('>', lt);
    if (gt === -1) break;
    i = gt + 1;
    if (lower[lt + 1] !== '/' && SKIP.has(name)) i = skipElement(lower, name, i);
    if (BLOCKS.has(name)) out.push('\n');
  }
  return out.join('');
}

/** A body's readable text with paragraph breaks, whitespace tidied. Linear time. */
export function flattenToText(html: string): string {
  return decodeEntities(stripMarkup(html))
    .replace(/[ \t\f\r]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
