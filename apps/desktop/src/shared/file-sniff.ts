// What an attachment's first bytes must look like for the extension its name claims, checked before Aplos opens it in
// another app (blob-area decision 12): a `.pdf` that is not a PDF is refused, not handed to the OS. No Electron import.

const ascii = (bytes: Uint8Array, at: number, text: string) =>
  text.length + at <= bytes.length &&
  [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0));
const hex = (bytes: Uint8Array, at: number, values: readonly number[]) =>
  at + values.length <= bytes.length && values.every((v, i) => bytes[at + i] === v);

/**
 * Plain text: no NUL byte in the first 4 KB (a binary file almost always does), or UTF-16 (a byte order mark, or a NUL in
 * every other byte throughout, the shape Excel's "Unicode Text" and Notepad's UTF-16 write).
 */
function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 4096);
  if (!head.includes(0)) return true;
  const bom =
    head.length >= 2 &&
    ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff));
  if (!bom) return false;
  // Past the mark, text in UTF-16 has its NULs in one lane only.
  let even = 0;
  let odd = 0;
  for (let i = 2; i < head.length; i += 1) {
    if (head[i] !== 0) continue;
    if (i % 2 === 0) even += 1;
    else odd += 1;
  }
  return even === 0 || odd === 0;
}

/** A PDF reader accepts the header anywhere in the first 1 KB (a stray BOM or newline is common). */
const pdfHeader = (bytes: Uint8Array) =>
  [...Array(Math.max(0, Math.min(bytes.length, 1024) - 4)).keys()].some(i =>
    ascii(bytes, i, '%PDF'),
  );

const BMFF_BRANDS = ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot', 'PICT'];
const isoBmff = (bytes: Uint8Array) => BMFF_BRANDS.some(brand => ascii(bytes, 4, brand));

const SNIFFERS: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  '.pdf': pdfHeader,
  '.png': b => hex(b, 0, [0x89, 0x50, 0x4e, 0x47]),
  '.jpg': b => hex(b, 0, [0xff, 0xd8, 0xff]),
  '.jpeg': b => hex(b, 0, [0xff, 0xd8, 0xff]),
  '.gif': b => ascii(b, 0, 'GIF8'),
  '.webp': b => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'),
  '.heic': b => ascii(b, 4, 'ftyp'),
  '.docx': b => hex(b, 0, [0x50, 0x4b, 0x03, 0x04]),
  '.xlsx': b => hex(b, 0, [0x50, 0x4b, 0x03, 0x04]),
  '.pptx': b => hex(b, 0, [0x50, 0x4b, 0x03, 0x04]),
  '.mp4': isoBmff,
  '.mov': isoBmff,
  '.mp3': b =>
    ascii(b, 0, 'ID3') || (b.length > 1 && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0),
  '.wav': b => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE'),
  '.rtf': b => ascii(b, 0, '{\\rtf'),
  '.txt': looksLikeText,
  '.md': looksLikeText,
  '.csv': looksLikeText,
  '.json': looksLikeText,
  '.eml': looksLikeText,
  '.ics': looksLikeText,
};

/** The extensions Aplos may open without saving first: each has a sniffer, so the two lists cannot drift apart. */
export const SNIFFED_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(SNIFFERS));

/** Whether `bytes` look like what `extension` (lower case, with its dot) says; false for an extension with no sniffer. */
export function sniffMatches(extension: string, bytes: Uint8Array): boolean {
  const sniff = Object.hasOwn(SNIFFERS, extension) ? SNIFFERS[extension] : undefined;
  return sniff ? sniff(bytes) : false;
}
