import { scopeFragment } from './ids';
import { parseUrl } from './url';

// Link targets: web, mail and phone links open outside the frame (target=_blank, and the host's
// window-open handler decides); in-mail fragments stay; anything else loses its href. The URL is
// read by the WHATWG parser (which strips tabs and newlines, as a browser does) and written back
// in its normalised form, so what the scheme check saw is exactly what the browser gets.

const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const LINK_SCHEME = /^(?:https?|mailto|tel):/i;
const MAX_HREF = 8_192;

export type Link =
  { kind: 'external'; href: string } | { kind: 'fragment'; href: string } | { kind: 'none' };

export function classifyLink(raw: string): Link {
  const value = raw.trim();
  if (value.length > MAX_HREF) return { kind: 'none' };
  if (value.startsWith('#') && !/\s/.test(value))
    return { kind: 'fragment', href: scopeFragment(value) };
  const url = parseUrl(value, LINK_SCHEME);
  if (!url || !LINK_SCHEMES.has(url.protocol)) return { kind: 'none' };
  return { kind: 'external', href: url.href };
}
