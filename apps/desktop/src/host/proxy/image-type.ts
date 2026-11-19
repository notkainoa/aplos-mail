/**
 * Raster type and dimensions from an image's leading bytes, never from `Content-Type`. Only PNG, JPEG, GIF and WebP
 * are recognised; SVG and everything else is not an image here. Dimensions come from the header, before decoding.
 */

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ImageHeader {
  mime: ImageMime;
  width: number;
  height: number;
}

/** Bytes needed before `sniffMime` can answer. */
export const SNIFF_BYTES = 12;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, i) => bytes[i] === byte);
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The type named by the leading bytes, or null. Needs `SNIFF_BYTES` bytes. */
export function sniffMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length < SNIFF_BYTES) return null;
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  const six = ascii(bytes, 0, 6);
  if (six === 'GIF87a' || six === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

function pngSize(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return null;
  return [view(bytes).getUint32(16), view(bytes).getUint32(20)];
}

function gifSize(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 10) return null;
  return [view(bytes).getUint16(6, true), view(bytes).getUint16(8, true)];
}

function vp8Size(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a)
    return null;
  return [view(bytes).getUint16(26, true) & 0x3fff, view(bytes).getUint16(28, true) & 0x3fff];
}

function vp8lSize(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
  const bits = view(bytes).getUint32(21, true);
  return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
}

function vp8xSize(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 30) return null;
  const width = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16);
  const height = bytes[27] | (bytes[28] << 8) | (bytes[29] << 16);
  return [width + 1, height + 1];
}

function webpSize(bytes: Uint8Array): [number, number] | null {
  const chunk = bytes.length >= 16 ? ascii(bytes, 12, 4) : '';
  if (chunk === 'VP8 ') return vp8Size(bytes);
  if (chunk === 'VP8L') return vp8lSize(bytes);
  if (chunk === 'VP8X') return vp8xSize(bytes);
  return null;
}

/** Markers without a length field: TEM, RST0-7, SOI. */
function standalone(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);
}

/** SOF0-SOF15, less DHT (C4), JPG (C8) and DAC (CC), which share the range. */
function startOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** Walks the JPEG marker segments up to the first SOFn; stops at SOS or EOI, which come too late. */
function jpegSize(bytes: Uint8Array): [number, number] | null {
  const data = view(bytes);
  let at = 2;
  while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    at += 2;
    if (marker === 0xff) at -= 1;
    else if (startOfFrame(marker))
      return at + 7 <= bytes.length ? [data.getUint16(at + 5), data.getUint16(at + 3)] : null;
    else if (marker === 0xda || marker === 0xd9) return null;
    else if (!standalone(marker)) {
      if (at + 2 > bytes.length) return null;
      at += data.getUint16(at);
    }
  }
  return null;
}

const SIZE_READERS: Record<ImageMime, (bytes: Uint8Array) => [number, number] | null> = {
  'image/png': pngSize,
  'image/jpeg': jpegSize,
  'image/gif': gifSize,
  'image/webp': webpSize,
};

/** Type and dimensions, or null when the bytes are not one of the four rasters or carry no usable size. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  const mime = sniffMime(bytes);
  const size = mime ? SIZE_READERS[mime](bytes) : null;
  if (!mime || !size || size[0] === 0 || size[1] === 0) return null;
  return { mime, width: size[0], height: size[1] };
}
