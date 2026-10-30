// Attribute allowlist for the sanitiser. Anything not listed is dropped: every `on*` handler, `srcset`, `formaction`,
// `xlink:href`, `ping`, `poster`, `data-*`, `contenteditable` and the rest. Values are validated per attribute and
// escaped on output, so an attribute can never break out of its quotes.

import { type BlockedCount, sanitiseCss } from './css';
import type { ImagePolicy } from './types';
import { decideImage, safeExternalUrl } from './urls';

type Check = (value: string) => string | null;

const MAX_SPAN = 1_000;
const MAX_TEXT = 1_000;

const pattern =
  (re: RegExp): Check =>
  value => {
    const v = value.trim();
    return re.test(v) ? v : null;
  };
const text: Check = value => value.slice(0, MAX_TEXT);
const flag: Check = () => '';
const span: Check = value => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? String(Math.min(n, MAX_SPAN)) : null;
};

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
}

/** A tracking pixel: an image sized 0 or 1 px by attribute, or hidden by inline style. */
function isPixel(attribs: Record<string, string>): boolean {
  const tiny = (v: string | undefined) => v !== undefined && /^\s*[01](?:px)?\s*$/i.test(v);
  const hidden = /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attribs.style ?? '');
  return (tiny(attribs.width) && tiny(attribs.height)) || hidden;
}

function imageSource(name: string, attribs: Record<string, string>, cx: AttributeContext) {
  const raw = name === 'img' ? attribs.src : attribs.background;
  if (raw === undefined) return null;
  const decision = decideImage(raw, cx.policy);
  if (decision.keep && name === 'img' && isPixel(attribs)) {
    cx.blocked++;
    return null;
  }
  if (decision.keep) return decision.src;
  if (decision.remote) cx.blocked++;
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
  if (attribs.style !== undefined) {
    const css = sanitiseCss(attribs.style, cx.policy, cx).trim();
    if (css) out.push(` style="${escapeHtml(css)}"`);
  }
  const image = imageSource(name, attribs, cx);
  if (image !== null) out.push(` ${name === 'img' ? 'src' : 'background'}="${escapeHtml(image)}"`);
  if (name === 'img' && image === null && attribs.src !== undefined) out.push(' data-blocked');
  if (name === 'img') out.push(' referrerpolicy="no-referrer"');
  if (name === 'a') out.push(linkAttributes(attribs.href));
  return out.join('');
}

/** Links open outside the app through the host; they never navigate the frame. */
function linkAttributes(href: string | undefined): string {
  const safe = href === undefined ? null : safeExternalUrl(href);
  if (safe === null) return '';
  return ` href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer"`;
}
