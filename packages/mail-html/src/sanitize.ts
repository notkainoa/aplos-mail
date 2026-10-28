import type { ChildNode, Document, Element, ParentNode } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { sanitizeCss } from './css';
import { escapeAttribute } from './escape';
import { markText, type Finder } from './find';
import { ImageBook, parseRemote } from './images';
import { classifyLink } from './links';
import { BACKGROUND, BODY_ATTRIBUTES, elementRule, HTML_ATTRIBUTES, keepsAttribute, VOID } from './policy';
import { canWrapIn, QUOTE_CLOSE, QUOTE_OPEN, quoteStart } from './quotes';
import { isTrackingPixel, styleHides } from './trackers';

// The walk: the mail is parsed into a tree once, then written out element by element from the
// allowlist with every text and attribute value escaped. Nothing from the input is copied as
// markup, so how a browser would have parsed the input cannot change what the output means.
// The walk is iterative (an explicit stack), so 100,000 nested elements cannot overflow it.

/** Elements deeper than this are unwrapped: their text stays, their nesting goes. */
export const MAX_DEPTH = 256;
const ATTRIBUTE_NAME = /^[a-z][a-z0-9-]*$/;
const TRANSPARENT_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

interface Context {
  depth: number;
  hidden: boolean;
  quoted: boolean;
}

type Task = { node: ChildNode; context: Context } | string;

export interface WalkOutput {
  doctype: string;
  htmlAttributes: string;
  bodyAttributes: string;
  body: string;
  trackersRemoved: number;
  quotedCount: number;
}

export function sanitizeHtml(html: string, images: ImageBook, finder: Finder | undefined): WalkOutput {
  const document = parseDocument(html, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  const walker = new Walker(images, finder);
  return walker.run(document);
}

class Walker {
  private readonly out: string[] = [];
  private readonly tasks: Task[] = [];
  private htmlAttributes: string | undefined;
  private bodyAttributes: string | undefined;
  private trackersRemoved = 0;
  private quotedCount = 0;

  constructor(
    private readonly images: ImageBook,
    private readonly finder: Finder | undefined,
  ) {}

  run(document: Document): WalkOutput {
    this.pushChildren(document, '', { depth: 0, hidden: false, quoted: false });
    while (this.tasks.length > 0) this.step(this.tasks.pop() as Task);
    return {
      doctype: doctypeFor(document),
      htmlAttributes: this.htmlAttributes ?? '',
      bodyAttributes: this.bodyAttributes ?? '',
      body: this.out.join(''),
      trackersRemoved: this.trackersRemoved,
      quotedCount: this.quotedCount,
    };
  }

  private step(task: Task): void {
    if (typeof task === 'string') {
      this.out.push(task);
      return;
    }
    const { node, context } = task;
    if (node.type === 'text') this.out.push(markText(node.data, this.finder));
    if (node.type === 'tag' || node.type === 'script' || node.type === 'style') this.element(node, context);
  }

  /** Queues a parent's children in order, wrapping quoted history in `<details>`. */
  private pushChildren(parent: ParentNode, name: string, context: Context): void {
    const items: Task[] = [];
    const children = parent.children;
    const wrap = !context.quoted && canWrapIn(name);
    for (let index = 0; index < children.length; index++) {
      const start = wrap ? quoteStart(children[index]) : undefined;
      if (!start) {
        items.push({ node: children[index], context });
        continue;
      }
      const quoted = { ...context, quoted: true };
      const last = start === 'self' ? index : children.length - 1;
      this.quotedCount++;
      items.push(QUOTE_OPEN);
      for (let at = index; at <= last; at++) items.push({ node: children[at], context: quoted });
      items.push(QUOTE_CLOSE);
      index = last;
    }
    for (let index = items.length - 1; index >= 0; index--) this.tasks.push(items[index]);
  }

  private element(element: Element, context: Context): void {
    const name = element.name;
    if (name === 'html' || name === 'body') return this.root(element, context);
    const rule = elementRule(name);
    if (rule === 'drop') return;
    if (rule === 'style') return this.style(element);
    if (rule === 'unwrap' || (context.depth >= MAX_DEPTH && !VOID.has(name))) {
      return this.pushChildren(element, name, context);
    }
    if (rule === 'pre') return this.open('pre', '', element, context);
    if (name === 'img') return this.image(element, context);
    this.open(name, this.attributes(element), element, context);
  }

  /** `<html>` and `<body>` are unwrapped; the first of each lends its attributes to the frame's own. */
  private root(element: Element, context: Context): void {
    if (element.name === 'html') this.htmlAttributes ??= this.rootAttributes(element, HTML_ATTRIBUTES);
    if (element.name === 'body') this.bodyAttributes ??= this.rootAttributes(element, BODY_ATTRIBUTES);
    this.pushChildren(element, element.name, context);
  }

  private rootAttributes(element: Element, allowed: Set<string>): string {
    const parts: string[] = [];
    for (const [name, value] of Object.entries(element.attribs)) {
      if (allowed.has(name)) parts.push(attribute(name, value));
    }
    if (element.name === 'body') parts.push(...this.urlAttributes(element));
    return parts.join('');
  }

  private open(name: string, attributes: string, element: Element, context: Context): void {
    this.out.push(`<${name}${attributes}>`);
    if (VOID.has(name)) return;
    this.tasks.push(`</${name}>`);
    const hidden = context.hidden || isHidden(element);
    this.pushChildren(element, name, { ...context, depth: context.depth + 1, hidden });
  }

  private style(element: Element): void {
    const css = element.children.map(child => (child.type === 'text' ? child.data : '')).join('');
    const clean = sanitizeCss(css, this.images).trim();
    if (clean) this.out.push(`<style>${clean}</style>`);
  }

  private attributes(element: Element): string {
    const name = element.name;
    const parts: string[] = [];
    for (const [attributeName, value] of Object.entries(element.attribs)) {
      if (ATTRIBUTE_NAME.test(attributeName) && keepsAttribute(name, attributeName)) {
        parts.push(attribute(attributeName, value));
      }
    }
    parts.push(...this.urlAttributes(element));
    if (name === 'a') parts.push(linkAttributes(element.attribs.href));
    return parts.join('');
  }

  /** `style` and `background`, both of which can name images. */
  private urlAttributes(element: Element): string[] {
    const parts: string[] = [];
    const style = element.attribs.style;
    const clean = style === undefined ? '' : sanitizeCss(style, this.images).trim();
    if (clean) parts.push(attribute('style', clean));
    const background = element.attribs.background;
    if (background !== undefined && BACKGROUND.has(element.name)) {
      const source = this.images.source(background);
      if (source.kind !== 'none' && source.url) parts.push(attribute('background', source.url));
    }
    return parts;
  }

  private image(element: Element, context: Context): void {
    const { src = '', width, height } = element.attribs;
    const style = element.attribs.style ?? '';
    const remote = parseRemote(src.trim());
    const hidden = context.hidden || isHidden(element);
    if (remote && isTrackingPixel({ url: remote, width, height, style, hidden })) {
      this.trackersRemoved++;
      return;
    }
    const attributes = this.attributes(element);
    const source = this.images.source(src);
    if (source.kind === 'none') return this.imageWithoutSource(element, attributes);
    if (source.url) return void this.out.push(`<img src="${escapeAttribute(source.url)}"${attributes}>`);
    // Blocked: a quiet placeholder that keeps the image's size, or its alt text when unsized.
    if (width !== undefined && height !== undefined) {
      this.out.push(`<img class="aplos-blocked" src="${TRANSPARENT_GIF}"${withoutClass(attributes)}>`);
      return;
    }
    this.imageWithoutSource(element, attributes);
  }

  private imageWithoutSource(element: Element, attributes: string): void {
    if (element.attribs.alt?.trim()) this.out.push(`<img${attributes}>`);
  }
}

function attribute(name: string, value: string): string {
  return ` ${name}="${escapeAttribute(value)}"`;
}

function withoutClass(attributes: string): string {
  return attributes.replace(/ class="[^"]*"/, '');
}

function linkAttributes(href: string | undefined): string {
  if (href === undefined) return '';
  const link = classifyLink(href);
  if (link.kind === 'none') return '';
  if (link.kind === 'fragment') return attribute('href', link.href);
  return `${attribute('href', link.href)} target="_blank" rel="noopener noreferrer"`;
}

function isHidden(element: Element): boolean {
  if (element.attribs.hidden !== undefined) return true;
  const style = element.attribs.style;
  return style !== undefined && styleHides(style);
}

/** Keeps the mail's rendering mode: standards, limited quirks (XHTML transitional) or quirks. */
function doctypeFor(document: Document): string {
  const node = document.children.find(child => child.type === 'directive');
  const data = node && 'data' in node ? String(node.data) : '';
  if (/^!doctype\s+html\s*$/i.test(data.trim())) return '<!DOCTYPE html>';
  if (/transitional|frameset/i.test(data) && /\.dtd/i.test(data)) {
    return '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">';
  }
  if (/strict/i.test(data)) return '<!DOCTYPE html>';
  return '';
}
