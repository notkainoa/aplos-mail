/**
 * Where a link clicked in a sealed mail letter goes (lane eng-html, html-5; ARCH 10). Pure: no Electron import, so it
 * runs under node:test. `main/windows.ts` hands it every `window.open` request of an app window and every refused
 * subframe navigation that came from a mail frame.
 *
 * - `mailto:` opens Compose through the existing `handleLink` path (it goes to the renderer as a `deep-link` event).
 * - `http:` and `https:` open in the default browser, as `security.ts`'s `external` does: no credentials in the URL.
 * - Everything else is denied: `javascript:`, `data:`, `file:`, `blob:`, `aplos-mail:` and `aplos:` (top navigation
 *   and deep links must never come from a letter), `tel:`, `ftp:`, `about:` and anything unparsable.
 *
 * The URL is parsed with the WHATWG parser and the parsed form (`href`) is what travels on, so what was checked is
 * what is delivered. A link longer than `MAX_FRAME_LINK` is denied; that is the cap `handleLink` and `external` apply
 * too (10,000 characters).
 */
import { isShownMailDocumentUrl } from './relay';

/** The longest link accepted, the same cap `handleLink` and `external` apply. */
export const MAX_FRAME_LINK = 10_000;

export type FrameLink =
  { kind: 'mail'; url: string } | { kind: 'web'; url: string } | { kind: 'deny' };

export interface FrameLinkSinks {
  /** Opens Compose for a mailto URL: `handleLink`. */
  openMail(url: string): void;
  /** Opens a web URL in the default browser (a no-op in test mode). */
  openWeb(url: string): void;
}

const DENY: FrameLink = { kind: 'deny' };

// Header-injection characters: a field that becomes a header (to, cc, bcc, subject, any other) must have none. Only the
// body may carry line breaks, which a draft body is allowed to hold.
function hasControl(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function decoded(part: string): string | undefined {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return undefined;
  }
}

/** A mailto URL whose recipients and header-like parameters hold no control character; the body may. */
function cleanMailto(url: URL): boolean {
  const to = decoded(url.pathname);
  if (to === undefined || hasControl(to)) return false;
  for (const [name, value] of url.searchParams) {
    if (name.toLowerCase() === 'body') continue;
    if (hasControl(name) || hasControl(value)) return false;
  }
  return true;
}

/** Judges one link. Never throws. */
export function classifyFrameLink(raw: unknown): FrameLink {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_FRAME_LINK) return DENY;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return DENY;
  }
  if (url.href.length > MAX_FRAME_LINK) return DENY;
  if (url.protocol === 'mailto:') {
    return cleanMailto(url) ? { kind: 'mail', url: url.href } : DENY;
  }
  if (url.protocol === 'https:' || url.protocol === 'http:') {
    return url.username || url.password || !url.hostname ? DENY : { kind: 'web', url: url.href };
  }
  return DENY;
}

/** Sends a link where it belongs, or nowhere. Returns what it did. */
export function routeFrameLink(raw: unknown, sinks: FrameLinkSinks): FrameLink['kind'] {
  const link = classifyFrameLink(raw);
  if (link.kind === 'mail') sinks.openMail(link.url);
  else if (link.kind === 'web') sinks.openWeb(link.url);
  return link.kind;
}

/** The part of Electron's `WebFrameMain` a navigation event names. */
interface NavigationFrame {
  url: string;
}

/** The part of Electron's `will-frame-navigate` event the guard reads. */
export interface FrameNavigation {
  url: string;
  isMainFrame: boolean;
  frame?: NavigationFrame | null;
  initiator?: NavigationFrame | null;
}

/**
 * True when a refused subframe navigation is a link click inside a sealed mail frame: the frame being navigated is an
 * issued mail document and nothing but that frame started it. A navigation an app frame or another frame started is
 * never a letter's link.
 */
export function isMailFrameLink(event: FrameNavigation): boolean {
  if (event.isMainFrame || !event.frame) return false;
  if (!isShownMailDocumentUrl(event.frame.url)) return false;
  return !event.initiator || event.initiator === event.frame;
}
