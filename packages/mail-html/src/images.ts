// Image sources found in HTML attributes and CSS, classified and rewritten to the frame's
// relative routes: `cid/<n>` for inline parts and `img/<n>` for remote images the proxy fetches.

export type ImagePolicy = 'block' | 'allow';

export type ImageSource =
  | { kind: 'inline'; url: string } // cid/<n> or a raster data: URL
  | { kind: 'remote'; url?: string } // img/<n> when allowed, no url when blocked
  | { kind: 'none' };

const RASTER_DATA = /^data:image\/(?:png|jpe?g|gif|webp)[;,]/i;
const MAX_DATA_URL = 1_000_000;

export class ImageBook {
  readonly remote: string[] = [];
  private readonly byUrl = new Map<string, number>();

  constructor(
    private readonly cids: readonly string[],
    readonly policy: ImagePolicy,
  ) {}

  /** Classifies one image URL; remote ones are numbered once each, in order of appearance. */
  source(raw: string): ImageSource {
    const value = raw.trim();
    if (/^cid:/i.test(value)) return this.cid(value.slice(4));
    if (RASTER_DATA.test(value)) return dataSource(value);
    const url = parseRemote(value);
    if (!url) return { kind: 'none' };
    const index = this.number(url);
    return this.policy === 'allow' ? { kind: 'remote', url: `img/${index}` } : { kind: 'remote' };
  }

  private cid(id: string): ImageSource {
    const wanted = safeDecode(id).replace(/^<|>$/g, '');
    let index = this.cids.indexOf(wanted);
    if (index < 0) index = this.cids.findIndex(cid => cid.toLowerCase() === wanted.toLowerCase());
    return index < 0 ? { kind: 'none' } : { kind: 'inline', url: `cid/${index}` };
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

function dataSource(value: string): ImageSource {
  if (value.length > MAX_DATA_URL) return { kind: 'none' };
  return { kind: 'inline', url: value.replace(/[\s"'()\\<>]/g, '') };
}

/** An absolute http(s) URL, normalised by the WHATWG parser, or undefined. */
export function parseRemote(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return url.href;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
