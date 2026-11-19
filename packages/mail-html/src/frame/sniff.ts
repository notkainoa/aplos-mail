import type { RasterType } from './headers';

// The type of a `cid/<n>` or `img/<n>` answer, read from its leading bytes and nothing else: never
// from the sender's part header, the remote server's `Content-Type` or a caller's claim. Only the
// four raster types the frame may show are recognised; SVG, HTML, scripts, executables and
// everything else are undefined, which `Mail/serve` answers with its uniform 404.

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

function startsWith(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false;
  return magic.every((byte, i) => bytes[offset + i] === byte);
}

/** The raster type the bytes are, or undefined for anything else (an empty answer included). */
export function sniffRaster(bytes: unknown): RasterType | undefined {
  if (!(bytes instanceof Uint8Array)) return undefined;
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return 'image/gif';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'image/webp';
  return undefined;
}
