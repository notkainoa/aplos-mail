// URL decisions for the sanitiser and the host. Every check parses with WHATWG `URL`, the parser the browser uses, and
// returns the re-serialised `href`, so what was checked is exactly what is emitted.

import type { ImagePolicy } from './types';

/** Inline images the frame may show: raster data URLs only (no SVG, which is a document). */
const DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z0-9+/=\s]*$/i;
/** Control characters and whitespace browsers strip from URLs before parsing. */
// eslint-disable-next-line no-control-regex
const URL_NOISE = /[\u0000- \u007f-\u009f]/g;

function parse(raw: string): URL | null {
  try {
    return new URL(raw.replace(URL_NOISE, ''));
  } catch {
    return null;
  }
}

/** True for anything that would leave the machine: http(s), ws(s), ftp and protocol-relative URLs. */
export function isRemote(raw: string): boolean {
  const cleaned = raw.replace(URL_NOISE, '').toLowerCase();
  return cleaned.startsWith('//') || /^(?:https?|wss?|ftp):/.test(cleaned);
}

/** A link the user may open outside the app: http, https or mailto with no credentials, else null. */
export function safeExternalUrl(raw: string): string | null {
  const url = parse(raw);
  if (!url) return null;
  if (url.protocol === 'mailto:') return url.href;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url.href;
}

/** The outcome for one image source: keep it (with its canonical form), or drop it and say whether it was remote. */
export type ImageDecision = { keep: true; src: string } | { keep: false; remote: boolean };

/** Decide an `<img src>`, `background=` or CSS `url()` under the policy. Only raster data URLs and, when loading, https. */
export function decideImage(raw: string, policy: ImagePolicy): ImageDecision {
  const trimmed = raw.replace(URL_NOISE, '');
  if (DATA_IMAGE.test(trimmed)) return { keep: true, src: trimmed.replace(/\s+/g, '') };
  const remote = isRemote(trimmed);
  if (policy !== 'load' || !remote) return { keep: false, remote };
  const url = parse(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed);
  if (!url || url.protocol !== 'https:' || url.username || url.password) {
    return { keep: false, remote: true };
  }
  return { keep: true, src: url.href };
}
