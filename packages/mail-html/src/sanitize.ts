import type { CSSToken } from '@csstools/css-tokenizer';
import { keepsBodyDeclaration } from './body-style';
import { cssTokens, keepDeclarations, readDeclarations, sanitizeCss } from './css';
import { escapeAttribute } from './escape';
import { markText, type Finder } from './find';
import { ID_LIST_ATTRIBUTES, scopeClassList, scopeId, scopeIdList } from './ids';
import type { ImageBook } from './images';
import { classifyLink } from './links';
import {
  IMPLIES_CLOSE,
  parseMail,
  type ElementNode,
  type MailNode,
  type ParseLimits,
} from './parse';
import {
  BACKGROUND,
  BODY_ATTRIBUTES,
  elementRule,
  HTML_ATTRIBUTES,
  keepsAttribute,
  VOID,
} from './policy';
import { canWrapIn, isQuoteWrapper, QUOTE_CLASS, QUOTE_SUMMARY, quoteStart } from './quotes';
import { declarationsHide, isTrackingPixel } from './trackers';

// The walk: the mail is parsed into a tree once (parse.ts), then written out element by element
// from the allowlist with every text and attribute value escaped. Nothing from the input is copied
// as markup, so how a browser would have parsed the input cannot change what the output means.
// The walk is iterative (an explicit stack of frames), so 100,000 nested elements cannot overflow it,
// and it applies the parser's implied end tags to what it writes, so reading the output back gives
// the same tree (the idempotence check in the tests).

/** Elements deeper than this are unwrapped: their text stays, their nesting goes. */
export const MAX_DEPTH = 256;
const ATTRIBUTE_NAME = /^[a-z][a-z0-9-]*$/;
const TRANSPARENT_GIF =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const QUOTE_OPEN = `<details class="${QUOTE_CLASS}"><summary>${QUOTE_SUMMARY}</summary>`;
const QUOTE_OPEN_EXPANDED = `<details class="${QUOTE_CLASS}" open><summary>${QUOTE_SUMMARY}</summary>`;
const NO_CLASS = new Set(['class']);

interface Context {
  /** An ancestor is hidden, so a remote image here is a tracker. */
  readonly hidden: boolean;
  /** Inside quoted history already, so nothing nested is wrapped again. */
  readonly quoted: boolean;
  /** Inside re-parsed `<noframes>` text, where a further `<noframes>` is dropped, never re-parsed. */
  readonly fallback: boolean;
}

/** The eight contexts, shared so the walk allocates nothing per element for them. */
const CONTEXTS: readonly Context[] = [false, true].flatMap(hidden =>
  [false, true].flatMap(quoted => [false, true].map(fallback => ({ hidden, quoted, fallback }))),
);

function contextOf(hidden: boolean, quoted: boolean, fallback: boolean): Context {
  return CONTEXTS[(hidden ? 4 : 0) + (quoted ? 2 : 0) + (fallback ? 1 : 0)];
}

/** One element written to the output, open until its end tag (or an implied end) is written. */
interface Written {
  name: string;
  open: boolean;
}

/** A run of children being written; the walk keeps a stack of these instead of recursing. */
interface Frame {
  children: MailNode[];
  next: number;
  context: Context;
  /** The element whose end tag follows the children (none for an unwrapped element). */
  closes: Written | undefined;
  /** Quoted history may be wrapped here. */
  wrap: boolean;
  /** The open quote wrapper and the index of its last child. */
  quote: { entry: Written; last: number } | undefined;
}

export interface WalkOutput {
  htmlAttributes: string;
  bodyAttributes: string;
  body: string;
  trackersRemoved: number;
  quotedCount: number;
  /** A size limit cut the message short. */
  clipped: boolean;
}

/** What one message may cost: markup characters (style text apart), elements and style text. */
export const LIMITS: ParseLimits = {
  maxChars: 524_288,
  maxElements: 20_000,
  maxStyleChars: 262_144,
};
/** A `style` attribute longer than this is dropped (the element stays). */
export const MAX_STYLE_ATTRIBUTE = 32_768;

export function sanitizeHtml(
  html: string,
  images: ImageBook,
  finder: Finder | undefined,
  ownOutput = false,
  quotesOpen = false,
): WalkOutput {
  const parsed = parseMail(html, LIMITS);
  const walker = new Walker(images, finder, ownOutput, quotesOpen);
  const output = walker.run(parsed.root);
  return { ...output, clipped: parsed.clipped };
}

class Walker {
  private readonly out: string[] = [];
  private readonly frames: Frame[] = [];
  private readonly written: Written[] = [];
  private htmlAttributes: string | undefined;
  private bodyAttributes: string | undefined;
  private trackersRemoved = 0;
  private quotedCount = 0;
  /** `style` attributes tokenized, sanitized and read for hiding, by source text: mail repeats them. */
  private readonly styleTokens = new Map<string, CSSToken[]>();
  private readonly cleanStyles = new Map<string, string>();
  private readonly hidingStyles = new Map<string, boolean>();
  /** What every `<noframes>` re-parse together may still build. */
  private fallbackElements = LIMITS.maxElements;
  /** Style text written so far: the rewrite can lengthen CSS, so the caps judge the output too. */
  private styleBlockChars = 0;
  private styleAttributeChars = 0;

  constructor(
    private readonly images: ImageBook,
    private readonly finder: Finder | undefined,
    /** Re-reading Aplos's own output: its `aplos-` classes stay (the idempotence check). */
    private readonly ownOutput: boolean,
    /** Quoted history starts open (`Mail/frame.quotesOpen`). */
    private readonly quotesOpen: boolean,
  ) {}

  run(root: ElementNode): Omit<WalkOutput, 'clipped'> {
    this.pushFrame(root.children, contextOf(false, false, false), undefined);
    while (this.frames.length > 0) this.step(this.frames[this.frames.length - 1]);
    return {
      htmlAttributes: this.htmlAttributes ?? '',
      bodyAttributes: this.bodyAttributes ?? '',
      body: this.out.join(''),
      trackersRemoved: this.trackersRemoved,
      quotedCount: this.quotedCount,
    };
  }

  /** Writes the frame's next child, or finishes the frame. */
  private step(frame: Frame): void {
    if (frame.quote && frame.next > frame.quote.last) {
      this.close(frame.quote.entry);
      frame.quote = undefined;
    }
    if (frame.next >= frame.children.length) {
      this.frames.pop();
      if (frame.closes) this.close(frame.closes);
      return;
    }
    const index = frame.next++;
    const child = frame.children[index];
    if (frame.wrap && !frame.quote) this.startQuote(frame, index);
    const { hidden, fallback } = frame.context;
    const context = frame.quote ? contextOf(hidden, true, fallback) : frame.context;
    if (child.kind === 'text') this.out.push(markText(child.data, this.finder));
    else this.element(child, context);
  }

  /** Wraps quoted history in `<details>`: this child alone, or it and every later sibling. */
  private startQuote(frame: Frame, index: number): void {
    const start = quoteStart(frame.children[index]);
    if (!start) return;
    const entry: Written = { name: 'details', open: false };
    frame.quote = { entry, last: start === 'self' ? index : frame.children.length - 1 };
    this.openQuote(entry);
  }

  private pushFrame(children: MailNode[], context: Context, closes: Written | undefined): void {
    if (children.length === 0) {
      if (closes) this.close(closes);
      return;
    }
    const wrap = !context.quoted && canWrapIn(this.topName());
    this.frames.push({ children, next: 0, context, closes, wrap, quote: undefined });
  }

  private depth(): number {
    return this.written.length;
  }

  private topName(): string {
    return this.written[this.written.length - 1]?.name ?? '#root';
  }

  /** Writes the implied end tags the parser would add before a `name` start tag. */
  private impliedClose(name: string): void {
    const closes = IMPLIES_CLOSE.get(name);
    while (closes && this.written.length > 0 && closes.has(this.topName()))
      this.close(this.written[this.written.length - 1]);
  }

  private close(entry: Written): void {
    if (!entry.open) return;
    while (this.written.length > 0) {
      const top = this.written.pop() as Written;
      top.open = false;
      this.out.push(`</${top.name}>`);
      if (top === entry) return;
    }
  }

  private openQuote(entry: Written): void {
    if (this.depth() + 2 > MAX_DEPTH) return;
    this.impliedClose('details');
    this.out.push(this.quotesOpen ? QUOTE_OPEN_EXPANDED : QUOTE_OPEN);
    entry.open = true;
    this.written.push(entry);
    this.quotedCount++;
  }

  private element(element: ElementNode, context: Context): void {
    const name = element.name;
    if (name === 'html' || name === 'body') return this.root(element, context);
    const rule = elementRule(name);
    if (rule === 'drop') return;
    if (rule === 'style') return this.style(element);
    if (rule === 'reparse') return this.fallback(element, context);
    const hidden = context.hidden || this.hides(element.attrs);
    const inner = contextOf(hidden, context.quoted, context.fallback);
    if (rule === 'unwrap' || (this.depth() >= MAX_DEPTH && !VOID.has(name))) {
      return this.pushFrame(element.children, inner, undefined);
    }
    if (name === 'img') return this.image(element, context);
    if (rule === 'pre') return this.open('pre', '', element, inner);
    this.open(name, this.attributes(element), element, inner);
  }

  /** `<html>` and `<body>` are unwrapped; the first of each lends its attributes to the frame's own. */
  private root(element: ElementNode, context: Context): void {
    if (element.name === 'html')
      this.htmlAttributes ??= this.rootAttributes(element, HTML_ATTRIBUTES);
    if (element.name === 'body')
      this.bodyAttributes ??= this.rootAttributes(element, BODY_ATTRIBUTES);
    this.pushFrame(element.children, context, undefined);
  }

  private rootAttributes(element: ElementNode, allowed: Set<string>): string {
    const parts: string[] = [];
    for (const [name, value] of element.attrs) {
      if (!allowed.has(name) || !rootValueOk(name, value)) continue;
      parts.push(attribute(name, name === 'class' ? this.classValue(value) : value));
    }
    if (element.name === 'body') parts.push(...this.urlAttributes(element, true));
    return parts.join('');
  }

  private open(name: string, attributes: string, element: ElementNode, context: Context): void {
    this.impliedClose(name);
    this.out.push(`<${name}${attributes}>`);
    if (VOID.has(name)) return;
    const entry: Written = { name, open: true };
    this.written.push(entry);
    const wrapper = this.ownOutput && !context.quoted && isQuoteWrapper(element);
    if (wrapper) this.quotedCount++;
    const only = element.children.length === 1 ? element.children[0] : undefined;
    if (only?.kind === 'text') {
      // The common leaf, `<td>text</td>`: no frame needed (a text node starts no quote).
      this.out.push(markText(only.data, this.finder));
      return this.close(entry);
    }
    const inner = contextOf(context.hidden, context.quoted || wrapper, context.fallback);
    this.pushFrame(element.children, inner, entry);
  }

  /**
   * A `<noframes>` fallback, read as markup. Only at the top level: one inside re-parsed text is
   * dropped, so each input character is parsed at most twice, and all fallbacks share one element
   * budget. (Re-parsing nested fallbacks was quadratic: `<nofr<noframes>ames>` rebuilds itself.)
   */
  private fallback(element: ElementNode, context: Context): void {
    if (context.fallback || this.fallbackElements <= 0) return;
    const limits = { ...LIMITS, maxElements: this.fallbackElements };
    const parsed = parseMail(textOf(element), limits);
    this.fallbackElements -= Math.max(1, parsed.elements);
    this.pushFrame(
      parsed.root.children,
      contextOf(context.hidden, context.quoted, true),
      undefined,
    );
  }

  private style(element: ElementNode): void {
    if (element.truncated) return;
    const css = textOf(element);
    const clean = sanitizeCss(css, this.images).trim();
    if (!clean || this.styleBlockChars + clean.length > LIMITS.maxStyleChars) return;
    this.styleBlockChars += clean.length;
    this.out.push(`<style>${clean}</style>`);
  }

  private attributes(element: ElementNode, exclude?: Set<string>): string {
    const parts: string[] = [];
    for (const [name, value] of element.attrs) {
      if (exclude?.has(name) || !ATTRIBUTE_NAME.test(name) || !keepsAttribute(element.name, name))
        continue;
      const kept = name === 'class' ? this.classValue(value) || undefined : keptValue(name, value);
      if (kept !== undefined) parts.push(attribute(name, kept));
    }
    parts.push(...this.urlAttributes(element));
    if (element.name === 'a') parts.push(linkAttributes(element.attrs.get('href')));
    return parts.join('');
  }

  /**
   * `style` and `background`, both of which can name images. The frame body's `style` keeps only the
   * properties of `body-style.ts` (`body` true): an element's own style attribute outranks every
   * cascade layer, `!important` or not, so nothing in it may touch what the reading layer guards.
   */
  private urlAttributes(element: ElementNode, body = false): string[] {
    const parts: string[] = [];
    const clean = body
      ? this.bodyStyle(element.attrs.get('style'))
      : this.cleanStyle(element.attrs.get('style'));
    if (clean && this.styleAttributeChars + clean.length <= LIMITS.maxChars) {
      this.styleAttributeChars += clean.length;
      parts.push(attribute('style', clean));
    }
    const background = element.attrs.get('background');
    if (background !== undefined && BACKGROUND.has(element.name)) {
      const source = this.images.source(background, 'css');
      if (source.kind !== 'none' && source.url) parts.push(attribute('background', source.url));
    }
    return parts;
  }

  private classValue(value: string): string {
    return this.ownOutput ? value : scopeClassList(value);
  }

  private cleanStyle(style: string | undefined): string {
    if (style === undefined || style.length > MAX_STYLE_ATTRIBUTE) return '';
    let clean = this.cleanStyles.get(style);
    if (clean === undefined) {
      clean = sanitizeCss(style, this.images, this.tokensOf(style)).trim();
      this.cleanStyles.set(style, clean);
    }
    return clean.length > MAX_STYLE_ATTRIBUTE ? '' : clean;
  }

  /**
   * The frame body's style: the allowed declarations only (`keepsBodyDeclaration`). Not cached, and
   * never through `cleanStyles`: that map is keyed by the style text, so a shared key would hand the body
   * another element's unfiltered result for the same text.
   */
  private bodyStyle(style: string | undefined): string {
    if (style === undefined || style.length > MAX_STYLE_ATTRIBUTE) return '';
    const text = keepDeclarations(style, keepsBodyDeclaration, this.tokensOf(style));
    const clean = sanitizeCss(text, this.images).trim();
    return clean.length > MAX_STYLE_ATTRIBUTE ? '' : clean;
  }

  /** The element's `hidden` attribute or `style` hides it (and so any image inside). */
  private hides(attrs: Map<string, string>): boolean {
    if (attrs.has('hidden')) return true;
    const style = attrs.get('style');
    if (style === undefined || style.length > MAX_STYLE_ATTRIBUTE) return false;
    let hides = this.hidingStyles.get(style);
    if (hides === undefined) {
      hides = declarationsHide(readDeclarations(style, this.tokensOf(style)));
      this.hidingStyles.set(style, hides);
    }
    return hides;
  }

  private tokensOf(style: string): CSSToken[] {
    let tokens = this.styleTokens.get(style);
    if (tokens === undefined) {
      tokens = cssTokens(style);
      this.styleTokens.set(style, tokens);
    }
    return tokens;
  }

  private image(element: ElementNode, context: Context): void {
    const src = element.attrs.get('src') ?? '';
    const remote = this.images.remoteUrl(src);
    if (
      remote &&
      isTrackingPixel({ url: remote, attrs: element.attrs, hiddenAncestor: context.hidden })
    ) {
      this.trackersRemoved++;
      return;
    }
    const source = this.images.source(src, 'img');
    if (source.kind === 'none') return this.imageWithoutSource(element);
    if (source.url) {
      this.out.push(`<img src="${escapeAttribute(source.url)}"${this.attributes(element)}>`);
      return;
    }
    // Blocked: a quiet placeholder that keeps the image's size, or its alt text when unsized.
    if (!hasSize(element.attrs)) return this.imageWithoutSource(element);
    // No `style`: an element's own style outranks every cascade layer, and the layer holds the height cap (reading-css.ts).
    const bare: ElementNode = { ...element, attrs: placeholderAttributes(element.attrs) };
    const attributes = this.attributes(bare, NO_CLASS);
    this.out.push(`<img src="${TRANSPARENT_GIF}" class="aplos-blocked"${attributes}>`);
  }

  private imageWithoutSource(element: ElementNode): void {
    if (element.attrs.get('alt')?.trim()) this.out.push(`<img${this.attributes(element)}>`);
  }
}

/**
 * `dir` and `lang` on the frame's own `<html>` and `<body>` must be what they say: short, so the
 * `<meta charset>` stays inside the first 1,024 bytes where the browser looks for it.
 */
function rootValueOk(name: string, value: string): boolean {
  if (name === 'dir') return /^(?:ltr|rtl|auto)$/i.test(value);
  if (name === 'lang') return /^[A-Za-z0-9-]{1,35}$/.test(value);
  return true;
}

function textOf(element: ElementNode): string {
  return element.children.map(child => (child.kind === 'text' ? child.data : '')).join('');
}

/** The value written for an allowlisted attribute (ids scoped), or undefined to leave it out. */
function keptValue(name: string, value: string): string | undefined {
  if (name === 'id' || name === 'name') return value ? scopeId(value) : undefined;
  if (ID_LIST_ATTRIBUTES.has(name)) return scopeIdList(value) || undefined;
  return value;
}

/**
 * A blocked image's attributes without its `style`: a size that only the style gave (`style="width:640px;height:900px"`)
 * moves to the `width` and `height` attributes, so the placeholder keeps its box (the height is capped by the reading CSS).
 */
function placeholderAttributes(attrs: Map<string, string>): Map<string, string> {
  const kept = new Map([...attrs].filter(([name]) => name !== 'style'));
  const style = attrs.get('style');
  if (style === undefined) return kept;
  const declarations = readDeclarations(style);
  for (const name of ['width', 'height']) {
    const value = /^\s*(\d+(?:\.\d+)?)(px|%)?\s*$/.exec(declarations.get(name) ?? '');
    if (!kept.has(name) && value) kept.set(name, value[2] === '%' ? `${value[1]}%` : value[1]!);
  }
  return kept;
}

function hasSize(attrs: Map<string, string>): boolean {
  if (attrs.has('width') && attrs.has('height')) return true;
  const style = attrs.get('style');
  if (style === undefined) return false;
  const declarations = readDeclarations(style);
  return declarations.has('width') && declarations.has('height');
}

function attribute(name: string, value: string): string {
  return ` ${name}="${escapeAttribute(value)}"`;
}

function linkAttributes(href: string | undefined): string {
  if (href === undefined) return '';
  const link = classifyLink(href);
  if (link.kind === 'none') return '';
  if (link.kind === 'fragment') return attribute('href', link.href);
  return `${attribute('href', link.href)} target="_blank" rel="noopener noreferrer"`;
}
