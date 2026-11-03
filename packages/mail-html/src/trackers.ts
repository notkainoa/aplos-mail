import { readDeclarations } from './css';

// Tracking pixels: remote images too small or too hidden to be meant for reading. They are
// removed, never fetched, and counted for "N trackers removed". Sizes and visibility are read
// from the image's attributes and its `style` declarations (tokenized, so escapes cannot hide
// them); an ancestor hidden by `hidden` or its `style` hides the image too. Rules in `<style>`
// blocks are not applied to elements (a recorded limit).

const TRACKER_PATH =
  /\/(?:open|opened|pixel|beacon|o\.gif|t\.gif|wf\/open|e\/o|track(?:ing)?\/open)(?:[./?;]|$)/i;
const NUMBER = /^-?\d{1,9}(?:\.\d{1,9})?$/;

/** A CSS or attribute length in px when it is a plain number or a px value; undefined otherwise. */
export function pixels(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  let text = value.trim().toLowerCase();
  if (text.endsWith('px')) text = text.slice(0, -2).trim();
  return NUMBER.test(text) ? Number(text) : undefined;
}

/** True when these `style` declarations hide their element from view. */
export function declarationsHide(style: Map<string, string>): boolean {
  if (style.get('display') === 'none') return true;
  const visibility = style.get('visibility');
  if (visibility === 'hidden' || visibility === 'collapse') return true;
  if (pixels(style.get('opacity')) === 0) return true;
  return pixels(style.get('max-height')) === 0 || pixels(style.get('max-width')) === 0;
}

export interface ImageFacts {
  url: string;
  attrs: Map<string, string>;
  /** An ancestor is hidden (`hidden`, `display:none` and the like). */
  hiddenAncestor: boolean;
}

export function isTrackingPixel(image: ImageFacts): boolean {
  if (image.hiddenAncestor || image.attrs.has('hidden')) return true;
  const style = readDeclarations(image.attrs.get('style') ?? '');
  if (declarationsHide(style)) return true;
  const width = pixels(style.get('width')) ?? pixels(image.attrs.get('width'));
  const height = pixels(style.get('height')) ?? pixels(image.attrs.get('height'));
  if (width !== undefined && width <= 1) return true;
  if (height !== undefined && height <= 1) return true;
  if (width !== undefined && height !== undefined) return width <= 2 && height <= 2;
  return width === undefined && height === undefined && TRACKER_PATH.test(pathOf(image.url));
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}
