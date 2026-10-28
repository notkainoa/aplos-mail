// Tracking pixels: remote images too small or too hidden to be meant for reading. They are
// removed, never fetched, and counted for "N trackers removed".

const TRACKER_PATH = /\/(?:open|opened|pixel|beacon|o\.gif|t\.gif|wf\/open|e\/o|track(?:ing)?\/open)(?:[./?;]|$)/i;

/** A CSS length as px when it is a plain number or px value; undefined otherwise. */
function pixels(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(value);
  return match ? Number(match[1]) : undefined;
}

function declaration(style: string, property: string): string | undefined {
  const pattern = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;!}]*)`, 'gi');
  let value: string | undefined;
  for (const match of style.matchAll(pattern)) value = match[1].trim();
  return value;
}

/** True when a sanitized `style` hides its element from view. */
export function styleHides(style: string): boolean {
  if (!style) return false;
  if (/^none$/i.test(declaration(style, 'display') ?? '')) return true;
  if (/^(?:hidden|collapse)$/i.test(declaration(style, 'visibility') ?? '')) return true;
  if (pixels(declaration(style, 'opacity')) === 0) return true;
  if (pixels(declaration(style, 'max-height')) === 0) return true;
  return pixels(declaration(style, 'max-width')) === 0;
}

export interface ImageFacts {
  url: string;
  width?: string;
  height?: string;
  style: string;
  /** The image or an ancestor is hidden (`hidden`, `display:none` and the like). */
  hidden: boolean;
}

export function isTrackingPixel(image: ImageFacts): boolean {
  if (image.hidden || styleHides(image.style)) return true;
  const width = pixels(declaration(image.style, 'width')) ?? pixels(image.width);
  const height = pixels(declaration(image.style, 'height')) ?? pixels(image.height);
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
