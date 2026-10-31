// Attribute allowlist for the sanitiser. Anything not listed is dropped: every `on*` handler, `srcset`, `formaction`,
// `xlink:href`, `ping`, `poster`, `data-*`, `contenteditable` and the rest. Values are validated per attribute and
// escaped on output, so an attribute can never break out of its quotes.

import { type BlockedCount, MAX_STYLE_ATTRIBUTE, sanitiseCss } from './css';
import type { ImagePolicy } from './types';
import { decideImage, safeExternalUrl } from './urls';

type Check = (value: string) => string | null;

/** colspan, rowspan and span are clamped to 1-MAX_SPAN (layout cost grows with the spanned grid). */
export const MAX_SPAN = 100;
const MAX_TEXT = 1_000;

const pattern =
  (re: RegExp): Check =>
  value => {
    const v = value.trim();
    return re.test(v) ? v : null;
  };
const text: Check = value => value.slice(0, MAX_TEXT);
const flag: Check = () => '';
/** A span clamped to 1-MAX_SPAN; null when it is not a number. */
function spanOf(value: string | undefined): number | null {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_SPAN) : null;
}
const span: Check = value => {
  const n = spanOf(value);
  return n === null ? null : String(n);
};

/** How many grid slots a table cell fills: colspan x rowspan after clamping. */
export function cellWeight(attribs: Record<string, string>): number {
  return (spanOf(attribs.colspan) ?? 1) * (spanOf(attribs.rowspan) ?? 1);
}

const SIZE = pattern(/^\d{1,5}(?:\.\d+)?(?:%|px)?$/i);
const SMALL_INT = pattern(/^-?\d{1,4}$/);
const COLOUR = pattern(/^#?[0-9a-z]{1,20}$/i);
const WORD = pattern(/^[a-z-]{1,20}$/i);
const NAME = pattern(/^[\w\- ]{1,200}$/);

/** Attributes any kept element may carry, with their value checks. */
const GLOBAL: Record<string, Check> = {
  align: WORD,
  valign: WORD,
  dir: pattern(/^(?:ltr|rtl|auto)$/i),
  lang: pattern(/^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/i),
  title: text,
  alt: text,
  class: NAME,
  id: NAME,
  bgcolor: COLOUR,
  color: COLOUR,
  width: SIZE,
  height: SIZE,
  border: SMALL_INT,
  cellpadding: SMALL_INT,
  cellspacing: SMALL_INT,
  hspace: SMALL_INT,
  vspace: SMALL_INT,
  colspan: span,
  rowspan: span,
  span,
  nowrap: flag,
  scope: WORD,
  headers: NAME,
  abbr: text,
  face: pattern(/^[\w\- ,'"]{1,200}$/),
  size: pattern(/^[+-]?\d{1,2}$/),
  start: SMALL_INT,
  type: pattern(/^(?:[1aAiI]|disc|circle|square)$/),
  reversed: flag,
  clear: WORD,
  open: flag,
  datetime: text,
};

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape for text content and attribute values alike. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ESCAPES[c] ?? c);
}

/** The sanitiser's shared state for one body. */
export interface AttributeContext extends BlockedCount {
  policy: ImagePolicy;
  /** Tracking pixels among the removed resources (a remote image sized 0 or 1, or hidden): the "N trackers removed" count. */
  trackers: number;
}

const TINY = /^[01](?:\.0*)?(?:px|em)?$/i;

function isTiny(value: string | undefined): boolean {
  return value !== undefined && TINY.test(value.trim());
}

/** The declarations of sanitised inline CSS, names and values lower-cased and trimmed; the last one wins. */
function declarations(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const declaration of css.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    out.set(
      declaration.slice(0, colon).trim().toLowerCase(),
      declaration
        .slice(colon + 1)
        .trim()
        .toLowerCase(),
    );
  }
  return out;
}

/**
 * A tracking pixel: an image sized 0 or 1 (px or em) in both dimensions, by attribute or inline style, or hidden by
 * inline style. `css` is the sanitised style, so escapes and comments cannot hide a size.
 */
function isPixel(attribs: Record<string, string>, css: string): boolean {
  const style = declarations(css);
  const tiny = (side: 'width' | 'height') =>
    isTiny(attribs[side]) || isTiny(style.get(side)) || isTiny(style.get(`max-${side}`));
  const hidden = style.get('display') === 'none' || style.get('visibility') === 'hidden';
  return (tiny('width') && tiny('height')) || hidden;
}

function imageSource(
  name: string,
  attribs: Record<string, string>,
  css: string,
  cx: AttributeContext,
) {
  const raw = name === 'img' ? attribs.src : attribs.background;
  if (raw === undefined) return null;
  const decision = decideImage(raw, cx.policy);
  const pixel = name === 'img' && isPixel(attribs, css);
  if (decision.keep && pixel) {
    cx.blocked++;
    cx.trackers++;
    return null;
  }
  if (decision.keep) return decision.src;
  if (!decision.remote) return null;
  cx.blocked++;
  if (pixel) cx.trackers++;
  return null;
}

/** Serialise the kept attributes of one element: ` name="value"` pairs, already escaped. */
export function keptAttributes(
  name: string,
  attribs: Record<string, string>,
  cx: AttributeContext,
): string {
  const out: string[] = [];
  for (const [key, value] of Object.entries(attribs)) {
    const check = GLOBAL[key];
    const kept = check ? check(value) : null;
    if (kept !== null) out.push(kept === '' ? ` ${key}` : ` ${key}="${escapeHtml(kept)}"`);
  }
  const css = inlineCss(attribs.style, cx);
  if (css) out.push(` style="${escapeHtml(css)}"`);
  const image = imageSource(name, attribs, css, cx);
  if (image !== null) out.push(` ${name === 'img' ? 'src' : 'background'}="${escapeHtml(image)}"`);
  if (name === 'img' && image === null && attribs.src !== undefined) out.push(' data-blocked');
  if (name === 'img') out.push(' referrerpolicy="no-referrer"');
  if (name === 'a') out.push(linkAttributes(attribs.href));
  return out.join('');
}

/** A sanitised `style` attribute, cut to MAX_STYLE_ATTRIBUTE first (the rest is dropped, never passed through). */
function inlineCss(style: string | undefined, cx: AttributeContext): string {
  if (style === undefined) return '';
  return sanitiseCss(style.slice(0, MAX_STYLE_ATTRIBUTE), cx.policy, cx).trim();
}

/** Links open outside the app through the host; they never navigate the frame. */
function linkAttributes(href: string | undefined): string {
  const safe = href === undefined ? null : safeExternalUrl(href);
  if (safe === null) return '';
  return ` href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer"`;
}
