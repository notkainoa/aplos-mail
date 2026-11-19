// The allowlist. An element not listed here is unwrapped (its children stay); one in DROPPED goes
// with everything inside it. Only listed attributes survive; URL-bearing ones (`href`, `src`,
// `background`, `style`) and id-bearing ones (ids.ts) are rewritten by the walker, never copied.

export type ElementRule = 'keep' | 'unwrap' | 'drop' | 'pre' | 'style' | 'reparse';

const KEPT = new Set([
  'a',
  'abbr',
  'acronym',
  'address',
  'article',
  'aside',
  'b',
  'bdi',
  'bdo',
  'big',
  'blockquote',
  'br',
  'caption',
  'center',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'font',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'main',
  'mark',
  'nav',
  'ol',
  'p',
  'pre',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'section',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'tt',
  'u',
  'ul',
  'var',
  'wbr',
]);

const DROPPED = new Set([
  'applet',
  'audio',
  'base',
  'basefont',
  'bgsound',
  'button',
  'canvas',
  'datalist',
  'dialog',
  'embed',
  'frame',
  'iframe',
  'input',
  'isindex',
  'keygen',
  'link',
  'math',
  'meta',
  'noembed',
  'noscript',
  'object',
  'optgroup',
  'option',
  'param',
  'portal',
  'script',
  'select',
  'slot',
  'source',
  'svg',
  'template',
  'textarea',
  'title',
  'track',
  'video',
]);

/**
 * Raw-text elements whose text is the mail's own fallback markup, shown because the frames it
 * stands in for are dropped: the text is parsed as HTML once more (and sanitized like the rest).
 */
const REPARSED = new Set(['noframes']);

/** Raw-text elements whose text is shown, as preformatted text. */
const AS_PRE = new Set(['xmp', 'listing', 'plaintext']);

export const VOID = new Set(['br', 'col', 'hr', 'img', 'wbr']);

export function elementRule(name: string): ElementRule {
  if (name === 'style') return 'style';
  if (KEPT.has(name)) return 'keep';
  if (DROPPED.has(name)) return 'drop';
  if (AS_PRE.has(name)) return 'pre';
  if (REPARSED.has(name)) return 'reparse';
  return 'unwrap';
}

const GLOBAL = new Set([
  'align',
  'bgcolor',
  'border',
  'class',
  'color',
  'dir',
  'height',
  'hidden',
  'id',
  'lang',
  'role',
  'title',
  'valign',
  'width',
]);

const BY_ELEMENT: Record<string, Set<string>> = {
  a: new Set(['name']),
  img: new Set(['alt', 'hspace', 'vspace']),
  table: new Set(['cellpadding', 'cellspacing', 'frame', 'rules', 'summary']),
  td: new Set(['abbr', 'colspan', 'headers', 'nowrap', 'rowspan', 'scope']),
  th: new Set(['abbr', 'colspan', 'headers', 'nowrap', 'rowspan', 'scope']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  ol: new Set(['reversed', 'start', 'type']),
  ul: new Set(['type']),
  li: new Set(['type', 'value']),
  font: new Set(['face', 'size']),
  hr: new Set(['noshade', 'size']),
  br: new Set(['clear']),
  details: new Set(['open']),
  time: new Set(['datetime']),
  del: new Set(['datetime']),
  ins: new Set(['datetime']),
};

/** Elements whose `background` attribute names an image. */
export const BACKGROUND = new Set(['body', 'table', 'td', 'th', 'tr', 'tbody', 'thead', 'tfoot']);

/** Attributes copied as text (escaped; ids scoped). `style`, `href`, `src` and `background` are handled apart. */
export function keepsAttribute(element: string, name: string): boolean {
  if (GLOBAL.has(name) || name.startsWith('aria-')) return true;
  return BY_ELEMENT[element]?.has(name) ?? false;
}

/** Attributes the frame's `<html>` and `<body>` take from the mail's. */
export const HTML_ATTRIBUTES = new Set(['dir', 'lang']);
export const BODY_ATTRIBUTES = new Set([
  'bgcolor',
  'text',
  'link',
  'vlink',
  'alink',
  'class',
  'dir',
  'lang',
]);
