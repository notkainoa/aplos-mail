import { asciiLower } from './parse';
import { parseUrl } from './url';

// Image sources found in HTML attributes and CSS, classified and rewritten to the frame's
// relative routes: `cid/<n>` for inline parts and `img/<n>` for remote images the proxy fetches.
// Nothing else survives, except a raster `data:` URL in an `<img src>` (no request; the frame's
// CSP allows `img-src data:`). CSS never keeps a `data:` URL.

export type ImagePolicy = 'block' | 'allow';

export type ImageSource =
  | { kind: 'inline'; url: string } // cid/<n>, or a raster data: URL for <img src>
  | { kind: 'remote'; url?: string } // img/<n> when allowed, no url when blocked
  | { kind: 'none' };

export type ImageContext = 'img' | 'css';

const RASTER_DATA = /^data:image\/(?:png|jpe?g|gif|webp)[;,]/i;
const REWRITTEN = /^(?:cid|img)\/\d{1,6}$/;
const MAX_DATA_URL = 1_000_000;
const MAX_REMOTE_URL = 8_192;
const REMOTE_SCHEME = /^https?:/i;

export interface ImageBookOptions {
  cids: readonly string[];
  policy: ImagePolicy;
  /**
   * Re-reading the sanitizer's own output (the idempotence check): `cid/<n>` and `img/<n>` count
   * as already rewritten. Mail input never gets this.
   */
  ownOutput?: boolean;
}

export class ImageBook {
  /** Remote URLs by index, numbered once each in order of appearance (blocked ones too). */
  readonly remote: string[] = [];
  private readonly byUrl = new Map<string, number>();
  private readonly cidIndex = new Map<string, number>();
  private readonly cidIndexFolded = new Map<string, number>();

  constructor(private readonly options: ImageBookOptions) {
    options.cids.forEach((cid, index) => {
      const bare = stripAngles(cid);
      if (!this.cidIndex.has(bare)) this.cidIndex.set(bare, index);
      if (!this.cidIndexFolded.has(asciiLower(bare)))
        this.cidIndexFolded.set(asciiLower(bare), index);
    });
  }

  /** Classifies one image URL. */
  source(raw: string, context: ImageContext): ImageSource {
    const value = raw.trim();
    if (this.options.ownOutput && REWRITTEN.test(value)) return { kind: 'inline', url: value };
    if (/^cid:/i.test(value)) return this.cid(value.slice(4));
    if (RASTER_DATA.test(value)) return context === 'img' ? dataSource(value) : { kind: 'none' };
    const url = this.remoteUrl(value);
    if (!url) return { kind: 'none' };
    const index = this.number(url);
    return this.options.policy === 'allow'
      ? { kind: 'remote', url: `img/${index}` }
      : { kind: 'remote' };
  }

  /** The normalised URL when `raw` is a remote http(s) image, without numbering it. */
  remoteUrl(raw: string): string | undefined {
    const value = raw.trim();
    return value.length > MAX_REMOTE_URL ? undefined : parseRemote(value);
  }

  private cid(id: string): ImageSource {
    const wanted = stripAngles(safeDecode(id));
    const index = this.cidIndex.get(wanted) ?? this.cidIndexFolded.get(asciiLower(wanted));
    return index === undefined ? { kind: 'none' } : { kind: 'inline', url: `cid/${index}` };
  }

  private number(url: string): number {
    const known = this.byUrl.get(url);
    if (known !== undefined) return known;
    const index = this.remote.length;
    this.remote.push(url);
    this.byUrl.set(url, index);
    return index;
  }
}

function stripAngles(value: string): string {
  const start = value.startsWith('<') ? 1 : 0;
  const end = value.endsWith('>') ? value.length - 1 : value.length;
  return value.slice(start, Math.max(start, end));
}

function dataSource(value: string): ImageSource {
  if (value.length > MAX_DATA_URL) return { kind: 'none' };
  return { kind: 'inline', url: value.replace(/[\s"'()\\<>]/g, '') };
}

/** An absolute http(s) URL, normalised by the WHATWG parser, or undefined. */
export function parseRemote(value: string): string | undefined {
  const url = parseUrl(value, REMOTE_SCHEME);
  if (url?.protocol !== 'http:' && url?.protocol !== 'https:') return undefined;
  return url.href;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
