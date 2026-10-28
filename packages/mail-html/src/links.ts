// Link targets: web and mail links open outside the frame; anything else loses its href.

const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const FRAGMENT = /^#[^\s]*$/;

export type Link = { kind: 'external'; href: string } | { kind: 'fragment'; href: string } | { kind: 'none' };

export function classifyLink(raw: string): Link {
  const value = raw.trim();
  if (FRAGMENT.test(value)) return { kind: 'fragment', href: value };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: 'none' };
  }
  if (!LINK_SCHEMES.has(url.protocol)) return { kind: 'none' };
  return { kind: 'external', href: url.href };
}
