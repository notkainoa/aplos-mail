import type { ElementNode, MailNode } from './parse';

// Quoted history: the earlier messages a reply carries. Each block is wrapped in a closed
// `<details class="aplos-quote">`, which opens without any script. Detection looks at one
// element's attributes and the first 200 characters of its leading text (at most 12 levels down),
// so the cost per element is bounded and the whole pass stays linear (an unbounded look-ahead was
// quadratic on deeply nested mail).

/** `self`: this element is a quote. `rest`: this element and every later sibling are the history. */
export type QuoteStart = 'self' | 'rest';

const QUOTE_CLASSES = new Set([
  'gmail_quote',
  'gmail_quote_container',
  'yahoo_quoted',
  'protonmail_quote',
]);
const HISTORY_CLASSES = new Set(['moz-cite-prefix', 'outlookmessageheader']);
const HISTORY_IDS = new Set(['appendonsend', 'divrplyfwdmsg', 'x_divrplyfwdmsg', 'stopspelling']);
const ORIGINAL_MESSAGE =
  /^\s{0,40}-{2,40}\s{0,40}(?:original message|forwarded message)\s{0,40}-{2}/i;
const NOT_TEXT = new Set(['style', 'script', 'title', 'template']);
const LOOKAHEAD_LEVELS = 12;
const LOOKAHEAD_SIBLINGS = 4;
const LOOKAHEAD_CHARS = 200;

export const QUOTE_CLASS = 'aplos-quote';
export const QUOTE_SUMMARY = 'Quoted text';

/** Parents a `<details>` cannot sit in without the HTML parser moving it. */
const NO_WRAP_PARENTS = new Set([
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'colgroup',
  'ul',
  'ol',
  'dl',
]);

export function canWrapIn(parent: string): boolean {
  return !NO_WRAP_PARENTS.has(parent);
}

/** Every class name this file looks for contains one of these, so most elements skip the split. */
const CLASS_HINTS = /quot|cite|messageheader/i;

export function classList(element: ElementNode): string[] {
  const value = element.attrs.get('class');
  if (!value || !CLASS_HINTS.test(value)) return [];
  return value.toLowerCase().split(/[\t\n\f\r ]+/);
}

/** An Aplos quote wrapper already in the input (the sanitizer reading its own output). */
export function isQuoteWrapper(element: ElementNode): boolean {
  return element.name === 'details' && classList(element).includes(QUOTE_CLASS);
}

export function quoteStart(node: MailNode): QuoteStart | undefined {
  if (node.kind !== 'element') return undefined;
  const classes = classList(node);
  if (node.name === 'blockquote' && node.attrs.get('type')?.toLowerCase() === 'cite') return 'self';
  if (classes.some(name => QUOTE_CLASSES.has(name))) return 'self';
  if (HISTORY_IDS.has((node.attrs.get('id') ?? '').toLowerCase())) return 'rest';
  if (classes.some(name => HISTORY_CLASSES.has(name))) return 'rest';
  return ORIGINAL_MESSAGE.test(leadingText(node)) ? 'rest' : undefined;
}

/** The first non-blank text at the start of an element, down at most 12 levels of first children. */
function leadingText(element: ElementNode): string {
  let node = element;
  for (let level = 0; level < LOOKAHEAD_LEVELS; level++) {
    let next: ElementNode | undefined;
    const children = node.children;
    for (let index = 0; index < Math.min(children.length, LOOKAHEAD_SIBLINGS) && !next; index++) {
      const child = children[index];
      const text = child.kind === 'text' ? child.data.slice(0, LOOKAHEAD_CHARS) : '';
      if (text.trim()) return text;
      if (child.kind === 'element' && !NOT_TEXT.has(child.name)) next = child;
    }
    if (!next) return '';
    node = next;
  }
  return '';
}

const FORWARDED = /^\s{0,40}-{2,40}\s{0,40}forwarded message\b/i;

/** A forwarded message: the sender chose to pass it on, so it is the content, not history to fold away. */
export function isForwarded(node: MailNode): boolean {
  return node.kind === 'element' && FORWARDED.test(leadingText(node));
}
