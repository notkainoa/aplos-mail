// Links in a letter never navigate the frame or the app. A click is cancelled and, when the URL passes
// safeExternalUrl, handed to `window.open` with noopener: in Electron, main's setWindowOpenHandler opens it in the
// default browser (or routes mailto to Compose) and denies the window (research section 7 "Navigation").

import { safeExternalUrl } from './urls';

/** The parts of a click the link handler reads. Duck-typed: the event comes from the frame realm. */
export interface LinkClickEvent {
  target: unknown;
  button?: number;
  preventDefault(): void;
}

interface Closest {
  closest(selector: string): { getAttribute(name: string): string | null } | null;
}

function anchorHref(target: unknown): string | null | undefined {
  const node = target as Partial<Closest> | null;
  if (!node || typeof node.closest !== 'function') return undefined;
  const anchor = node.closest('a');
  return anchor ? anchor.getAttribute('href') : undefined;
}

/** Open a URL outside the app; returns the URL opened, or null when it was refused. */
export function openExternal(
  raw: string,
  open: (url: string) => void = url => void window.open(url, '_blank', 'noopener,noreferrer'),
): string | null {
  const url = safeExternalUrl(raw);
  if (url) open(url);
  return url;
}

/** Handle a click or auxclick inside a letter: any click on a link is cancelled; a safe one opens outside. */
export function handleLinkClick(
  event: LinkClickEvent,
  open?: (url: string) => void,
): string | null {
  const href = anchorHref(event.target);
  if (href === undefined) return null;
  event.preventDefault();
  if (href === null || (event.button !== undefined && event.button > 1)) return null;
  return openExternal(href, open);
}
