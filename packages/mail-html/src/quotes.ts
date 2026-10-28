import type { ChildNode, Element } from 'domhandler';

// Quoted history: the earlier messages a reply carries. Each block is wrapped in a closed
// `<details class="aplos-quote">`, which opens without any script.

/** `self`: this element is a quote. `rest`: this element and every later sibling are the history. */
export type QuoteStart = 'self' | 'rest';

const QUOTE_CLASSES = /(?:^|\s)(?:gmail_quote|gmail_quote_container|yahoo_quoted|protonmail_quote)(?:\s|$)/i;
const HISTORY_IDS = new Set(['appendonsend', 'divrplyfwdmsg', 'x_divrplyfwdmsg', 'stopspelling']);
const HISTORY_CLASSES = /(?:^|\s)(?:moz-cite-prefix|outlookmessageheader)(?:\s|$)/i;
const ORIGINAL_MESSAGE = /^\s*-{2,}\s*(?:original message|forwarded message)\s*-{2,}/i;

/** Parents a `<details>` cannot sit in without the HTML parser moving it. */
const NO_WRAP_PARENTS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup', 'ul', 'ol', 'dl']);

export const QUOTE_OPEN = '<details class="aplos-quote"><summary>Quoted text</summary>';
export const QUOTE_CLOSE = '</details>';

export function canWrapIn(parent: string): boolean {
  return !NO_WRAP_PARENTS.has(parent);
}

export function quoteStart(node: ChildNode): QuoteStart | undefined {
  if (node.type !== 'tag') return undefined;
  const element = node as Element;
  const { attribs } = element;
  if (element.name === 'blockquote' && attribs.type?.toLowerCase() === 'cite') return 'self';
  if (QUOTE_CLASSES.test(attribs.class ?? '')) return 'self';
  if (HISTORY_IDS.has((attribs.id ?? '').toLowerCase())) return 'rest';
  if (HISTORY_CLASSES.test(attribs.class ?? '')) return 'rest';
  return ORIGINAL_MESSAGE.test(leadingText(element)) ? 'rest' : undefined;
}

/** The first 200 characters of an element's text, read without recursion. */
function leadingText(element: Element): string {
  let text = '';
  const stack: ChildNode[] = [...element.children].reverse();
  while (stack.length > 0 && text.length < 200) {
    const node = stack.pop() as ChildNode;
    if (node.type === 'text') text += node.data;
    if (node.type === 'tag') stack.push(...[...node.children].reverse());
  }
  return text;
}
