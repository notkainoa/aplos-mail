import { Tokenizer, type TokenizerCallbacks } from 'htmlparser2';

// The tree builder. htmlparser2's tokenizer does the lexing (raw-text elements, entities, attributes);
// this file builds the tree. htmlparser2's own Parser keeps its open-element stack with
// `unshift`/`shift`/`indexOf`, which is quadratic on 100,000 nested elements (4 s measured), so the
// stack here only ever pushes and pops, and an open-element count per name makes an unmatched end
// tag O(1). The rules follow htmlparser2's (implied ends, void elements, foreign content); the
// sanitizer never trusts the tree to match a browser's, because it writes a fresh document.
//
// Limits keep the cost of one message bounded: past `maxChars` of markup (style text not counted)
// or `maxElements` elements the parse stops and the result says it was clipped; style text past
// `maxStyleChars` (the whole message) marks its `<style>` as truncated, and the sanitizer drops it.

export interface ElementNode {
  kind: 'element';
  name: string;
  attrs: Map<string, string>;
  children: MailNode[];
  /** A `<style>` whose text went over the style budget. */
  truncated?: true;
}

export interface TextNode {
  kind: 'text';
  data: string;
}

export type MailNode = ElementNode | TextNode;

export interface ParseLimits {
  maxChars: number;
  maxElements: number;
  maxStyleChars: number;
}

export interface ParsedMail {
  root: ElementNode;
  /** The first `<!DOCTYPE …>` text, without `<!` and `>`. */
  doctype: string;
  /** A limit stopped the parse before the end of the input. */
  clipped: boolean;
  /** Elements built, for a caller that shares one element budget across several parses. */
  elements: number;
}

const VOID = new Set([
  'area',
  'base',
  'basefont',
  'br',
  'col',
  'command',
  'embed',
  'frame',
  'hr',
  'img',
  'input',
  'isindex',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const FOREIGN_ROOTS = new Set(['svg', 'math']);
/** Inside these, SVG and MathML go back to HTML parsing. */
const INTEGRATION_POINTS = new Set([
  'foreignobject',
  'desc',
  'title',
  'mi',
  'mo',
  'mn',
  'ms',
  'mtext',
  'annotation-xml',
]);

/** Shared by every element without attributes; the builder replaces it before the first set. */
const NO_ATTRIBUTES: Map<string, string> = new Map();

/** Start tags that end an open element of these names first (the parser's implied end tags). */
export const IMPLIES_CLOSE = impliedCloseTable();

function impliedCloseTable(): Map<string, Set<string>> {
  const table = new Map<string, Set<string>>();
  const add = (names: string, closes: string) => {
    const set = new Set(closes.split(' '));
    for (const name of names.split(' ')) table.set(name, set);
  };
  add('tr', 'tr th td');
  add('th', 'th');
  add('td', 'thead th td');
  add('a', 'a');
  add('li', 'li');
  add('p', 'p');
  add('h1 h2 h3 h4 h5 h6', 'h1 h2 h3 h4 h5 h6 p');
  add(
    'select input output button datalist textarea',
    'input option optgroup select button datalist textarea',
  );
  add('option', 'option');
  add('optgroup', 'optgroup option');
  add('dd dt', 'dd dt');
  add('rt rp', 'rt rp');
  add('tbody tfoot', 'thead tbody');
  add(
    'address article aside blockquote details div dl fieldset figcaption figure footer form header hr main nav ol pre section table ul',
    'p',
  );
  return table;
}

interface Open {
  node: ElementNode;
  /** The element is SVG or MathML, so `<x/>` closes it. */
  selfForeign: boolean;
  /** Its children are SVG or MathML (where `<style>` is markup, not raw text). */
  foreign: boolean;
}

/** ASCII-only lowercase, as the HTML parser folds names (no Unicode folding such as the Kelvin sign). */
export function asciiLower(value: string): string {
  let out = '';
  let from = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 65 || code > 90) continue;
    out += value.slice(from, index) + String.fromCharCode(code + 32);
    from = index + 1;
  }
  return from === 0 ? value : out + value.slice(from);
}

function element(name: string): ElementNode {
  return { kind: 'element', name, attrs: NO_ATTRIBUTES, children: [] };
}

class TreeBuilder implements TokenizerCallbacks {
  readonly root: ElementNode = element('#root');
  doctype = '';
  clipped = false;
  tokenizer: Tokenizer | undefined;
  private readonly stack: Open[] = [{ node: this.root, selfForeign: false, foreign: false }];
  private readonly openCounts = new Map<string, number>();
  private pending: ElementNode | undefined;
  private attributeName = '';
  private attributeValue = '';
  elements = 0;
  private styleChars = 0;

  constructor(
    private readonly html: string,
    private readonly limits: ParseLimits,
  ) {}

  isInForeignContext(): boolean {
    return this.top().foreign;
  }

  ontext(start: number, end: number): void {
    const style = this.top().node;
    if (style.name === 'style') return this.styleText(style, start, end);
    const room = this.limits.maxChars - (start - this.styleChars);
    this.appendText(this.html.slice(start, start + Math.max(0, Math.min(room, end - start))));
    if (room < end - start) this.clip();
  }

  ontextentity(codepoint: number, end: number): void {
    if (end - this.styleChars > this.limits.maxChars) return this.clip();
    this.appendText(String.fromCodePoint(codepoint));
  }

  onopentagname(start: number, end: number): void {
    this.pending = undefined;
    if (this.clipped) return;
    if (start - this.styleChars > this.limits.maxChars || ++this.elements > this.limits.maxElements)
      return this.clip();
    const name = this.tagName(start, end);
    if (name === 'form' && this.isOpen('form')) return;
    const closes = IMPLIES_CLOSE.get(name);
    while (closes && this.stack.length > 1 && closes.has(this.top().node.name)) this.pop();
    const node = element(name);
    this.top().node.children.push(node);
    this.pending = node;
    if (!VOID.has(name)) this.push(node);
  }

  onattribname(start: number, end: number): void {
    this.attributeName = asciiLower(this.html.slice(start, end));
    this.attributeValue = '';
  }

  onattribdata(start: number, end: number): void {
    if (end - this.styleChars > this.limits.maxChars) return this.clip();
    this.attributeValue += this.html.slice(start, end);
  }

  onattribentity(codepoint: number): void {
    this.attributeValue += String.fromCodePoint(codepoint);
  }

  onattribend(): void {
    const node = this.pending;
    if (node && node.attrs === NO_ATTRIBUTES) node.attrs = new Map();
    if (node && !node.attrs.has(this.attributeName))
      node.attrs.set(this.attributeName, this.attributeValue);
    this.attributeValue = '';
  }

  onopentagend(): void {
    this.pending = undefined;
  }

  onselfclosingtag(): void {
    const node = this.pending;
    this.pending = undefined;
    const top = this.top();
    if (node && top.node === node && top.selfForeign) this.pop();
  }

  onclosetag(start: number, end: number): void {
    if (this.clipped) return;
    const name = this.tagName(start, end);
    if (VOID.has(name)) {
      if (name === 'br') this.top().node.children.push(element('br'));
      return;
    }
    if (this.isOpen(name)) return this.popUntil(name);
    if (name === 'p') this.top().node.children.push(element('p'));
  }

  ondeclaration(start: number, end: number): void {
    if (!this.doctype) this.doctype = this.html.slice(start, end);
  }

  oncdata(): void {}
  oncomment(): void {}
  onprocessinginstruction(): void {}
  onend(): void {}

  private clip(): void {
    this.clipped = true;
    this.tokenizer?.pause();
  }

  /** Style text is not markup, so it does not count against `maxChars`; it has its own budget. */
  private styleText(style: ElementNode, start: number, end: number): void {
    const length = end - start;
    this.styleChars += length;
    if (this.styleChars > this.limits.maxStyleChars) style.truncated = true;
    if (!style.truncated) this.appendText(this.html.slice(start, end));
  }

  private tagName(start: number, end: number): string {
    const name = asciiLower(this.html.slice(start, end));
    return name === 'image' && !this.isInForeignContext() ? 'img' : name;
  }

  private top(): Open {
    return this.stack[this.stack.length - 1];
  }

  private isOpen(name: string): boolean {
    return (this.openCounts.get(name) ?? 0) > 0;
  }

  private push(node: ElementNode): void {
    const selfForeign = FOREIGN_ROOTS.has(node.name) || this.top().foreign;
    const foreign = selfForeign && !INTEGRATION_POINTS.has(node.name);
    this.stack.push({ node, selfForeign, foreign });
    this.openCounts.set(node.name, (this.openCounts.get(node.name) ?? 0) + 1);
  }

  private pop(): ElementNode {
    const { node } = this.stack.pop() as Open;
    this.openCounts.set(node.name, (this.openCounts.get(node.name) ?? 1) - 1);
    return node;
  }

  /** Pops to and including the innermost open `name`; each pop is paid for by its push. */
  private popUntil(name: string): void {
    while (this.stack.length > 1 && this.pop().name !== name) continue;
  }

  private appendText(data: string): void {
    if (!data || this.clipped) return;
    const children = this.top().node.children;
    const last = children[children.length - 1];
    if (last?.kind === 'text') last.data += data;
    else children.push({ kind: 'text', data });
  }
}

/**
 * Cuts each `<style>` block longer than `max` out of an oversized message before tokenizing, so a
 * multi-megabyte stylesheet cannot cost a full tokenizer pass and still leaves the text after it.
 * The search is textual (a `<style` inside an attribute value would be taken for one); that can
 * only lose content, never let anything through, because the output is always written fresh.
 */
export function cutHugeStyles(html: string, max: number, keep: number): string {
  const opens = /<style\b/gi;
  const closes = /<\/style/gi;
  const parts: string[] = [];
  let kept = 0;
  let from = 0;
  let cursor = 0;
  while (kept < keep) {
    // Only the part that can still be kept is searched, so a style-free 5 MB message costs nothing.
    const window = html.slice(cursor, cursor + (keep - kept) + 6);
    opens.lastIndex = 0;
    const open = opens.exec(window);
    if (!open) break;
    const start = cursor + open.index;
    kept += open.index;
    closes.lastIndex = start;
    const close = closes.exec(html);
    const end = close ? close.index : html.length;
    if (end - start > max) {
      parts.push(html.slice(from, start), '<style>');
      from = end;
    } else {
      kept += end - start;
    }
    cursor = end;
    if (!close) break;
  }
  parts.push(html.slice(from, from + keep));
  return parts.join('');
}

/** Parses mail HTML into a tree in time linear in its length, whatever its shape. */
export function parseMail(html: string, limits: ParseLimits): ParsedMail {
  const hardLimit = limits.maxChars + limits.maxStyleChars;
  const cut = html.length > hardLimit ? cutHugeStyles(html, limits.maxStyleChars, hardLimit) : html;
  const input = cut.length > hardLimit ? cut.slice(0, hardLimit) : cut;
  const builder = new TreeBuilder(input, limits);
  const tokenizer = new Tokenizer({ decodeEntities: true }, builder);
  builder.tokenizer = tokenizer;
  tokenizer.write(input);
  tokenizer.end();
  return {
    root: builder.root,
    doctype: builder.doctype,
    clipped: builder.clipped || input.length < cut.length,
    elements: Math.min(builder.elements, limits.maxElements),
  };
}
